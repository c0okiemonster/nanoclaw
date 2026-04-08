import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  deleteSlotSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getSession,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup, WorktreeSlot } from './types.js';
import { WorktreeManager } from './worktree-manager.js';
import { parseImageReferences } from './image.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup[]> = {};
/** Message cursor per folder (not per JID) for independent tracking */
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
const worktreeManager = new WorktreeManager();

/** Reverse index: folder -> RegisteredGroup (with jid populated) */
const folderToGroup = new Map<string, RegisteredGroup>();

function rebuildFolderIndex(): void {
  folderToGroup.clear();
  for (const [jid, groups] of Object.entries(registeredGroups)) {
    for (const g of groups) {
      folderToGroup.set(g.folder, { ...g, jid });
    }
  }
}

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Migrate JID-keyed cursors to folder-keyed cursors.
  // Old format: { "46723210738@s.whatsapp.net": "2024-..." }
  // New format: { "whatsapp_main": "2024-..." }
  const migratedCursors: Record<string, string> = {};
  let needsMigration = false;
  for (const [key, ts] of Object.entries(lastAgentTimestamp)) {
    if (key.includes('@')) {
      // Old JID-keyed format — convert to folder(s)
      needsMigration = true;
      const groups = registeredGroups[key];
      if (groups) {
        for (const g of groups) {
          // Only set if not already present (don't overwrite newer cursors)
          if (!migratedCursors[g.folder]) {
            migratedCursors[g.folder] = ts;
          }
        }
      }
    } else {
      // Already folder-keyed
      migratedCursors[key] = ts;
    }
  }
  if (needsMigration) {
    lastAgentTimestamp = migratedCursors;
    logger.info('Migrated lastAgentTimestamp from JID keys to folder keys');
    saveState();
  }

  rebuildFolderIndex();

  logger.info(
    { groupCount: Object.values(registeredGroups).flat().length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 * Cursors are keyed by folder for independent tracking per registration.
 */
function getOrRecoverCursor(folder: string, chatJid: string): string {
  const existing = lastAgentTimestamp[folder];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { folder, chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[folder] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  // Push to array, replacing existing entry with same folder or appending
  if (!registeredGroups[jid]) {
    registeredGroups[jid] = [];
  }
  const idx = registeredGroups[jid].findIndex((g) => g.folder === group.folder);
  if (idx >= 0) {
    registeredGroups[jid][idx] = { ...group, jid };
  } else {
    registeredGroups[jid].push({ ...group, jid });
  }
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Update reverse index
  folderToGroup.set(group.folder, { ...group, jid });

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered:
        registeredJids.has(c.jid) && (registeredGroups[c.jid]?.length ?? 0) > 0,
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup[]>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 * groupKey is the folder name (unique across all registrations).
 */
async function processGroupMessages(
  groupKey: string,
  slotId: number = 0,
): Promise<boolean> {
  // Reverse-lookup: find the group by folder
  const group = folderToGroup.get(groupKey);
  if (!group || !group.jid) return true;
  const chatJid = group.jid;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn(
      { chatJid, folder: groupKey },
      'No channel owns JID, skipping messages',
    );
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(groupKey, chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups (or when multiple groups share a JID), check trigger
  const jidGroups = registeredGroups[chatJid];
  const multiReg = jidGroups && jidGroups.length > 1;
  if (multiReg || (!isMainGroup && group.requiresTrigger !== false)) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  let prompt = formatMessages(missedMessages, TIMEZONE);
  const imageAttachments = parseImageReferences(missedMessages);

  // Acquire worktree for parallel slots (non-zero)
  let worktreeSlot: WorktreeSlot | undefined;
  if (slotId > 0 && group.containerConfig?.additionalMounts?.length) {
    const repoMount = group.containerConfig.additionalMounts[0];
    const resolvedPath = repoMount.hostPath;
    try {
      worktreeSlot = await worktreeManager.acquire(resolvedPath, group.folder);
    } catch (err) {
      logger.error({ groupKey, slotId, err }, 'Failed to acquire worktree');
      return false;
    }
  }

  // Inject worktree context for parallel slots
  if (worktreeSlot) {
    const repoName = path.basename(worktreeSlot.sourcePath);
    const ctx = `[System: You are running in parallel slot ${worktreeSlot.slotId} (worktree). The repo at /workspace/extra/${repoName} is a worktree copy. Your work branch: ${worktreeSlot.branch}. Do not start dev servers — they run in the primary container only.]`;
    prompt = `${ctx}\n\n${prompt}`;
  }

  // Inject agent swarm context when keywords detected
  const SWARM_KEYWORDS = /\b(use agents?|with agents?|agent swarm)\b/i;
  if (SWARM_KEYWORDS.test(prompt)) {
    const swarmCtx = `[System: Agent swarm requested. You may use the agent orchestration system (@system-architect, @implementation, @quality-assurance, @integration) for this task. See .claude/QUICK_START_AGENTS.md for the workflow.]`;
    prompt = `${swarmCtx}\n\n${prompt}`;
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[groupKey] || '';
  lastAgentTimestamp[groupKey] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      folder: groupKey,
      messageCount: missedMessages.length,
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle.
  // Groups with port mappings (dev servers) skip the idle timer — the container
  // stays alive until the hard timeout so dev servers aren't killed mid-session.
  const hasPorts = (group.containerConfig?.ports?.length ?? 0) > 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (hasPorts) return; // Dev server container — don't idle-kill
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(groupKey);
    }, group.containerConfig?.timeout || IDLE_TIMEOUT);
  };

  // Heartbeat: remind agent to send progress updates if silent for too long.
  // Writes an IPC message that the agent-runner picks up during its poll loop.
  const HEARTBEAT_MS = 3 * 60 * 1000; // 3 minutes
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastOutputTime = Date.now();

  const startHeartbeat = () => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      const silentMs = Date.now() - lastOutputTime;
      if (silentMs >= HEARTBEAT_MS) {
        const inputDir = path.join(DATA_DIR, 'ipc', groupKey, 'input');
        try {
          fs.mkdirSync(inputDir, { recursive: true });
          const filename = `${Date.now()}-heartbeat.json`;
          fs.writeFileSync(
            path.join(inputDir, filename),
            JSON.stringify({
              type: 'message',
              text: '[System reminder: You have been working for over 3 minutes without sending a progress update. Use send_message NOW to tell the user what you are currently doing and your progress so far. Then continue your work.]',
            }),
          );
          logger.debug({ group: group.name }, 'Heartbeat reminder sent');
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_MS);
  };
  startHeartbeat();

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    imageAttachments,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
        lastOutputTime = Date.now();
        startHeartbeat(); // Restart heartbeat when agent is actively working
      }

      if (result.status === 'success') {
        // Don't mark as idle for groups with port mappings — prevents
        // scheduled tasks from preempting the container and killing dev servers.
        if (!hasPorts) {
          queue.notifyIdle(groupKey);
        }
        // Stop heartbeat when agent finishes a query — prevents "Idle." spam
        // in keep-alive containers. Heartbeat restarts on the next inbound message.
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    worktreeSlot,
  );

  // Release worktree after container finishes
  if (worktreeSlot) {
    await worktreeManager.release(worktreeSlot);
  }

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[groupKey] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  imageAttachments: Array<{ relativePath: string; mediaType: string }>,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  worktreeSlot?: WorktreeSlot,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const slotId = worktreeSlot?.slotId ?? 0;
  const sessionId =
    slotId === 0 ? sessions[group.folder] : getSession(group.folder, slotId);

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  const allRegisteredJids = new Set(
    Object.entries(registeredGroups)
      .filter(([, gs]) => gs.length > 0)
      .map(([jid]) => jid),
  );
  writeGroupsSnapshot(group.folder, isMain, availableGroups, allRegisteredJids);

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          if (slotId === 0) {
            sessions[group.folder] = output.newSessionId;
          }
          setSession(group.folder, output.newSessionId, slotId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        keepAlive:
          slotId === 0 && (group.containerConfig?.ports?.length ?? 0) > 0,
        slotId,
        worktreeRef: worktreeSlot?.ref,
        assistantName: ASSISTANT_NAME,
        ...(imageAttachments.length > 0 && { imageAttachments }),
      },
      (proc, containerName) =>
        queue.registerProcess(group.folder, proc, containerName, group.folder),
      wrappedOnOutput,
      worktreeSlot,
    );

    if (output.newSessionId) {
      if (slotId === 0) {
        sessions[group.folder] = output.newSessionId;
      }
      setSession(group.folder, output.newSessionId, slotId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const groups = registeredGroups[chatJid];
          if (!groups || groups.length === 0) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          // Iterate ALL registered groups for this JID — each checks its own trigger
          const multiRegistration = groups.length > 1;
          for (const group of groups) {
            const isMainGroup = group.isMain === true;
            // When multiple groups share a JID, ALL must use triggers to distinguish
            const needsTrigger =
              multiRegistration ||
              (!isMainGroup && group.requiresTrigger !== false);

            // For non-main groups, only act on trigger messages.
            // Non-trigger messages accumulate in DB and get pulled as
            // context when a trigger eventually arrives.
            if (needsTrigger) {
              const triggerPattern = getTriggerPattern(group.trigger);
              const allowlistCfg = loadSenderAllowlist();
              const hasTrigger = groupMessages.some(
                (m) =>
                  triggerPattern.test(m.content.trim()) &&
                  (m.is_from_me ||
                    isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
              );
              if (!hasTrigger) continue;
            }

            // Pull all messages since lastAgentTimestamp so non-trigger
            // context that accumulated between triggers is included.
            const allPending = getMessagesSince(
              chatJid,
              getOrRecoverCursor(group.folder, chatJid),
              ASSISTANT_NAME,
              MAX_MESSAGES_PER_PROMPT,
            );
            const messagesToSend =
              allPending.length > 0 ? allPending : groupMessages;
            const formatted = formatMessages(messagesToSend, TIMEZONE);

            if (queue.sendMessage(group.folder, formatted)) {
              logger.debug(
                { chatJid, folder: group.folder, count: messagesToSend.length },
                'Piped messages to active container',
              );
              lastAgentTimestamp[group.folder] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              saveState();
              // Show typing indicator while the container processes the piped message
              channel
                .setTyping?.(chatJid, true)
                ?.catch((err) =>
                  logger.warn(
                    { chatJid, err },
                    'Failed to set typing indicator',
                  ),
                );
            } else {
              // No active container — enqueue for a new one
              queue.enqueueMessageCheck(group.folder);
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, groups] of Object.entries(registeredGroups)) {
    for (const group of groups) {
      const pending = getMessagesSince(
        chatJid,
        getOrRecoverCursor(group.folder, chatJid),
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      );
      if (pending.length > 0) {
        logger.info(
          {
            group: group.name,
            folder: group.folder,
            pendingCount: pending.length,
          },
          'Recovery: found unprocessed messages',
        );
        queue.enqueueMessageCheck(group.folder);
      }
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, groups] of Object.entries(registeredGroups)) {
    for (const group of groups) {
      ensureOneCLIAgent(jid, group);
    }
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const groups = registeredGroups[chatJid];
    const isMainJid = groups?.some((g) => g.isMain);
    if (!isMainJid) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        registeredGroups[chatJid]?.length
      ) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupKey, proc, containerName, groupFolder) =>
      queue.registerProcess(groupKey, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const groups of Object.values(registeredGroups)) {
        for (const group of groups) {
          writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
        }
      }
    },
  });
  queue.setProcessMessagesFn(async (groupKey: string, slotId: number) => {
    return processGroupMessages(groupKey, slotId);
  });

  // Configure parallel slots for groups that support it
  for (const groups of Object.values(registeredGroups)) {
    for (const group of groups) {
      const maxParallel = group.containerConfig?.maxParallel ?? 1;
      if (maxParallel > 1) {
        queue.setMaxParallel(group.folder, maxParallel);
      }
    }
  }

  // Clean up stale worktrees and ephemeral slot sessions from previous crashes
  for (const groups of Object.values(registeredGroups)) {
    for (const group of groups) {
      if (
        (group.containerConfig?.maxParallel ?? 1) > 1 &&
        group.containerConfig?.additionalMounts?.length
      ) {
        const repoMount = group.containerConfig.additionalMounts[0];
        worktreeManager.cleanupStale(repoMount.hostPath, group.folder);
      }
      deleteSlotSessions(group.folder);
    }
  }

  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
