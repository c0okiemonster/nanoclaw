import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupKey: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  activeSlotCount: number;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn:
    | ((groupKey: string, slotId: number) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;
  private maxParallelConfig = new Map<string, number>();

  private getGroup(groupKey: string): GroupState {
    let state = this.groups.get(groupKey);
    if (!state) {
      state = {
        active: false,
        activeSlotCount: 0,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupKey, state);
    }
    return state;
  }

  setProcessMessagesFn(
    fn: (groupKey: string, slotId: number) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  setMaxParallel(groupKey: string, max: number): void {
    this.maxParallelConfig.set(groupKey, max);
  }

  private getMaxParallel(groupKey: string): number {
    return this.maxParallelConfig.get(groupKey) ?? 1;
  }

  enqueueMessageCheck(groupKey: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupKey);

    if (state.active) {
      // Slot 0 is busy — check if we can spin up a parallel slot
      const maxParallel = this.getMaxParallel(groupKey);
      if (
        !state.idleWaiting &&
        maxParallel > 1 &&
        state.activeSlotCount < maxParallel &&
        this.activeCount < MAX_CONCURRENT_CONTAINERS
      ) {
        const slotId = state.activeSlotCount;
        logger.debug(
          { groupKey, slotId, activeSlotCount: state.activeSlotCount },
          'Spinning up parallel slot',
        );
        this.runForGroup(groupKey, 'messages', slotId).catch((err) =>
          logger.error(
            { groupKey, slotId, err },
            'Unhandled error in runForGroup (parallel)',
          ),
        );
        return;
      }

      state.pendingMessages = true;
      logger.debug({ groupKey }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupKey)) {
        this.waitingGroups.push(groupKey);
      }
      logger.debug(
        { groupKey, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupKey, 'messages').catch((err) =>
      logger.error({ groupKey, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupKey: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupKey);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupKey, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupKey, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupKey, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupKey);
      }
      logger.debug({ groupKey, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupKey, fn });
      if (!this.waitingGroups.includes(groupKey)) {
        this.waitingGroups.push(groupKey);
      }
      logger.debug(
        { groupKey, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupKey, { id: taskId, groupKey, fn }).catch((err) =>
      logger.error({ groupKey, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupKey: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupKey);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupKey: string): void {
    const state = this.getGroup(groupKey);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupKey);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupKey: string, text: string): boolean {
    const state = this.getGroup(groupKey);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupKey: string): void {
    const state = this.getGroup(groupKey);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupKey: string,
    reason: 'messages' | 'drain',
    slotId: number = 0,
  ): Promise<void> {
    const state = this.getGroup(groupKey);
    if (slotId === 0) {
      state.active = true;
      state.idleWaiting = false;
      state.isTaskContainer = false;
      state.pendingMessages = false;
    }
    state.activeSlotCount++;
    this.activeCount++;

    logger.debug(
      { groupKey, reason, slotId, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupKey, slotId);
        if (success) {
          if (slotId === 0) state.retryCount = 0;
        } else {
          if (slotId === 0) this.scheduleRetry(groupKey, state);
        }
      }
    } catch (err) {
      logger.error({ groupKey, err }, 'Error processing messages for group');
      if (slotId === 0) this.scheduleRetry(groupKey, state);
    } finally {
      if (slotId === 0) {
        state.active = false;
        state.process = null;
        state.containerName = null;
        state.groupFolder = null;
      }
      state.activeSlotCount--;
      this.activeCount--;
      if (slotId === 0) {
        this.drainGroup(groupKey);
      }
    }
  }

  private async runTask(groupKey: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupKey);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupKey, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupKey, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupKey);
    }
  }

  private scheduleRetry(groupKey: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupKey, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupKey, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupKey);
      }
    }, delayMs);
  }

  private drainGroup(groupKey: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupKey);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupKey, task).catch((err) =>
        logger.error(
          { groupKey, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupKey, 'drain').catch((err) =>
        logger.error(
          { groupKey, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextKey = this.waitingGroups.shift()!;
      const state = this.getGroup(nextKey);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextKey, task).catch((err) =>
          logger.error(
            { groupKey: nextKey, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextKey, 'drain').catch((err) =>
          logger.error(
            { groupKey: nextKey, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
