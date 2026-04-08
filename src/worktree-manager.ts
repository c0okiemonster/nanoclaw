import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { logger } from './logger.js';
import type { WorktreeSlot } from './types.js';

export class WorktreeManager {
  /**
   * groupFolder → (slotId → WorktreeSlot)
   */
  private readonly slots = new Map<string, Map<number, WorktreeSlot>>();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create a git worktree for the given group.
   *
   * @param sourcePath  Absolute path to the source git repo.
   * @param groupFolder Identifier for the group (used in dir names + state key).
   * @param ref         Optional branch/commit to check out (detached). When
   *                    omitted a new branch is created from HEAD.
   */
  async acquire(
    sourcePath: string,
    groupFolder: string,
    ref?: string,
  ): Promise<WorktreeSlot> {
    const slotId = this.nextSlotId(groupFolder);
    const worktreesDir = path.join(sourcePath, '.worktrees');
    const worktreePath = path.join(worktreesDir, `${groupFolder}-${slotId}`);

    fs.mkdirSync(worktreesDir, { recursive: true });

    let branch: string;

    if (ref) {
      // Detached checkout at the supplied ref
      execFileSync('git', ['worktree', 'add', '--detach', worktreePath, ref], {
        cwd: sourcePath,
      });
      branch = ref;
    } else {
      // Create a new branch from HEAD
      branch = `wt/${groupFolder}-${slotId}`;
      execFileSync(
        'git',
        ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'],
        { cwd: sourcePath },
      );
    }

    const slot: WorktreeSlot = {
      slotId,
      worktreePath,
      sourcePath,
      branch,
      ref,
      createdAt: Date.now(),
    };

    this.groupSlots(groupFolder).set(slotId, slot);

    logger.debug({ slotId, worktreePath, branch }, 'worktree acquired');

    return slot;
  }

  /**
   * Remove a worktree when work is finished.
   * If the worktree has uncommitted changes it is left in place and a warning
   * is logged so the user can inspect the state.
   */
  async release(slot: WorktreeSlot): Promise<void> {
    const { slotId, worktreePath, sourcePath, branch, ref } = slot;

    if (fs.existsSync(worktreePath)) {
      if (this.isDirty(worktreePath)) {
        logger.warn(
          { worktreePath, slotId },
          'worktree has uncommitted changes — leaving for inspection',
        );
      } else {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
            cwd: sourcePath,
          });
          logger.debug({ slotId, worktreePath }, 'worktree removed');
        } catch (err) {
          logger.warn({ err, worktreePath }, 'failed to remove worktree');
        }

        // Delete the auto-created branch (not present when ref was supplied)
        if (!ref) {
          try {
            execFileSync('git', ['branch', '-D', branch], { cwd: sourcePath });
          } catch (err) {
            logger.warn({ err, branch }, 'failed to delete temp branch');
          }
        }
      }
    }

    // WorktreeSlot doesn't carry groupFolder — find the slot by worktreePath.
    for (const [gf, map] of this.slots) {
      if (map.has(slotId) && map.get(slotId)?.worktreePath === worktreePath) {
        map.delete(slotId);
        if (map.size === 0) this.slots.delete(gf);
        break;
      }
    }
  }

  /**
   * Fetch a PR branch from origin and return the local ref name.
   */
  fetchPrBranch(sourcePath: string, prNumber: number): string {
    const localRef = `pr-${prNumber}`;
    execFileSync(
      'git',
      ['fetch', 'origin', `pull/${prNumber}/head:${localRef}`],
      { cwd: sourcePath },
    );
    return localRef;
  }

  /**
   * Return all currently-active slots for the given group.
   */
  getActiveSlots(groupFolder: string): WorktreeSlot[] {
    const map = this.slots.get(groupFolder);
    if (!map) return [];
    return Array.from(map.values());
  }

  /**
   * Count how many more worktrees can be started for the group.
   * Slot 0 is the original repo and is not counted against the limit.
   *
   * availableSlots = maxParallel - 1 - activeCount
   */
  availableSlots(groupFolder: string, maxParallel: number): number {
    const active = this.getActiveSlots(groupFolder).length;
    return Math.max(0, maxParallel - 1 - active);
  }

  /**
   * On startup, remove any stale worktrees that were left behind by a crash.
   * Looks in `{sourcePath}/.worktrees/` for dirs matching `{groupFolder}-*`.
   */
  cleanupStale(sourcePath: string, groupFolder: string): void {
    const worktreesDir = path.join(sourcePath, '.worktrees');
    if (!fs.existsSync(worktreesDir)) return;

    const prefix = `${groupFolder}-`;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const stalePath = path.join(worktreesDir, entry.name);
      logger.warn({ stalePath }, 'removing stale worktree');
      try {
        execFileSync('git', ['worktree', 'remove', '--force', stalePath], {
          cwd: sourcePath,
        });
      } catch {
        // Prune may suffice if the dir was already gone
        try {
          execFileSync('git', ['worktree', 'prune'], { cwd: sourcePath });
        } catch {
          // best-effort
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private groupSlots(groupFolder: string): Map<number, WorktreeSlot> {
    let map = this.slots.get(groupFolder);
    if (!map) {
      map = new Map();
      this.slots.set(groupFolder, map);
    }
    return map;
  }

  private nextSlotId(groupFolder: string): number {
    const map = this.groupSlots(groupFolder);
    // Find the lowest positive integer not currently in use
    let id = 1;
    while (map.has(id)) id++;
    return id;
  }

  private isDirty(worktreePath: string): boolean {
    try {
      const out = execFileSync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        encoding: 'utf8',
      });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }
}
