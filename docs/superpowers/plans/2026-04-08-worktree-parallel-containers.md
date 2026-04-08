# Worktree-Based Parallel Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable multiple concurrent containers per group using git worktrees, allowing parallel PR reviews, fixes, and feature work without blocking the primary container.

**Architecture:** Each group gets configurable parallel slots (default 1, up to 4). Slot 0 is the original repo mount (keep-alive, dev servers). Slots 1-N create temporary git worktrees for isolated parallel work. A new `WorktreeManager` module handles worktree lifecycle. The `GroupQueue` evolves from single-container-per-group to multi-slot routing. Agent swarm mode is opt-in via explicit keywords in the user message.

**Tech Stack:** Node.js, TypeScript, SQLite (better-sqlite3), git CLI, vitest

**Spec:** `docs/superpowers/specs/2026-04-08-worktree-parallel-containers-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/types.ts` | Modify | Add `maxParallel` to `ContainerConfig`, export `WorktreeSlot` interface |
| `src/worktree-manager.ts` | Create | Git worktree lifecycle: acquire, release, cleanup, PR fetch |
| `src/worktree-manager.test.ts` | Create | Tests for worktree manager |
| `src/group-queue.ts` | Modify | Multi-slot support: route messages to idle slot or spin up new slot |
| `src/group-queue.test.ts` | Modify | Tests for multi-slot routing |
| `src/db.ts` | Modify | Session table migration: add `slot_id` column |
| `src/db.test.ts` | Modify | Tests for slot-aware session functions |
| `src/container-runner.ts` | Modify | Accept `WorktreeSlot`, mount worktree path, per-slot IPC |
| `src/index.ts` | Modify | Pass slot info, slot-aware sessions, swarm context injection |
| `src/group-folder.ts` | Modify | Add `resolveSlotIpcPath` for per-slot IPC directories |
| `container/agent-runner/src/index.ts` | Modify | Receive slot context, suppress dev servers in worktree slots |

---

### Task 1: Add `maxParallel` to ContainerConfig and `WorktreeSlot` type

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add `maxParallel` to `ContainerConfig`**

In `src/types.ts`, add `maxParallel` to the `ContainerConfig` interface:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  ports?: string[];
  memory?: string;
  cpus?: string;
  maxParallel?: number; // Default: 1. Max concurrent containers for this group.
}
```

- [ ] **Step 2: Add `WorktreeSlot` interface**

In `src/types.ts`, add the `WorktreeSlot` interface after `ContainerConfig`:

```typescript
export interface WorktreeSlot {
  slotId: number;
  worktreePath: string;
  sourcePath: string;
  branch: string;
  ref?: string;
  createdAt: number;
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean compile, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add maxParallel to ContainerConfig and WorktreeSlot type"
```

---

### Task 2: Create WorktreeManager

**Files:**
- Create: `src/worktree-manager.ts`
- Create: `src/worktree-manager.test.ts`

- [ ] **Step 1: Write the tests**

Create `src/worktree-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorktreeManager } from './worktree-manager.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('WorktreeManager', () => {
  let manager: WorktreeManager;
  let testRepoPath: string;

  beforeEach(() => {
    manager = new WorktreeManager();
    // Create a real temp git repo for integration tests
    testRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
    execFileSync('git', ['init', testRepoPath]);
    execFileSync('git', ['-C', testRepoPath, 'commit', '--allow-empty', '-m', 'init']);
  });

  afterEach(() => {
    // Release all slots and clean up
    for (const slot of manager.getActiveSlots('test_group')) {
      manager.release(slot);
    }
    fs.rmSync(testRepoPath, { recursive: true, force: true });
  });

  it('acquires a worktree slot and creates the directory', async () => {
    const slot = await manager.acquire(testRepoPath, 'test_group');
    expect(slot.slotId).toBe(1);
    expect(slot.sourcePath).toBe(testRepoPath);
    expect(fs.existsSync(slot.worktreePath)).toBe(true);
    expect(slot.branch).toContain('test_group');
  });

  it('assigns incrementing slot IDs', async () => {
    const slot1 = await manager.acquire(testRepoPath, 'test_group');
    const slot2 = await manager.acquire(testRepoPath, 'test_group');
    expect(slot1.slotId).toBe(1);
    expect(slot2.slotId).toBe(2);
  });

  it('releases a slot and removes the worktree', async () => {
    const slot = await manager.acquire(testRepoPath, 'test_group');
    const wtPath = slot.worktreePath;
    expect(fs.existsSync(wtPath)).toBe(true);
    await manager.release(slot);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(manager.getActiveSlots('test_group')).toHaveLength(0);
  });

  it('reports available slots correctly', async () => {
    expect(manager.availableSlots('test_group', 4)).toBe(3); // slots 1-3
    await manager.acquire(testRepoPath, 'test_group');
    expect(manager.availableSlots('test_group', 4)).toBe(2);
  });

  it('returns empty array for group with no active slots', () => {
    expect(manager.getActiveSlots('nonexistent')).toEqual([]);
  });

  it('reuses released slot IDs', async () => {
    const slot1 = await manager.acquire(testRepoPath, 'test_group');
    expect(slot1.slotId).toBe(1);
    await manager.release(slot1);
    const slot1b = await manager.acquire(testRepoPath, 'test_group');
    expect(slot1b.slotId).toBe(1);
  });

  it('acquires with a specific ref (branch name)', async () => {
    // Create a branch in the test repo
    execFileSync('git', ['-C', testRepoPath, 'branch', 'feature-branch']);
    const slot = await manager.acquire(testRepoPath, 'test_group', 'feature-branch');
    expect(slot.ref).toBe('feature-branch');
    // Verify the worktree is on the correct branch
    const head = execFileSync('git', ['-C', slot.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const branchHead = execFileSync('git', ['-C', testRepoPath, 'rev-parse', 'feature-branch'], { encoding: 'utf-8' }).trim();
    expect(head).toBe(branchHead);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/worktree-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement WorktreeManager**

Create `src/worktree-manager.ts`:

```typescript
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { WorktreeSlot } from './types.js';

export class WorktreeManager {
  private activeSlots = new Map<string, Map<number, WorktreeSlot>>();

  /**
   * Acquire the next available worktree slot for a group.
   * Creates a git worktree from sourcePath, optionally checking out a ref.
   * Slot IDs start at 1 (slot 0 is the original repo).
   */
  async acquire(
    sourcePath: string,
    groupFolder: string,
    ref?: string,
  ): Promise<WorktreeSlot> {
    const groupSlots = this.activeSlots.get(groupFolder) ?? new Map();
    this.activeSlots.set(groupFolder, groupSlots);

    // Find lowest available slot ID starting at 1
    let slotId = 1;
    while (groupSlots.has(slotId)) slotId++;

    const worktreeDir = path.join(sourcePath, '.worktrees');
    fs.mkdirSync(worktreeDir, { recursive: true });

    const worktreePath = path.join(worktreeDir, `${groupFolder}-${slotId}`);
    const branch = `${groupFolder}/slot-${slotId}-${Date.now()}`;

    try {
      if (ref) {
        // Check out a specific ref (branch, PR branch, commit)
        execFileSync('git', ['-C', sourcePath, 'worktree', 'add', worktreePath, '--detach'], {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        execFileSync('git', ['-C', worktreePath, 'checkout', ref], {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      } else {
        // Create from HEAD on a new branch
        execFileSync('git', ['-C', sourcePath, 'worktree', 'add', '-b', branch, worktreePath], {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ sourcePath, groupFolder, slotId, ref, error: msg }, 'Failed to create worktree');
      throw new Error(`Failed to create worktree: ${msg}`);
    }

    const slot: WorktreeSlot = {
      slotId,
      worktreePath,
      sourcePath,
      branch: ref ?? branch,
      ref,
      createdAt: Date.now(),
    };

    groupSlots.set(slotId, slot);
    logger.info(
      { groupFolder, slotId, worktreePath, ref: ref ?? 'HEAD' },
      'Worktree slot acquired',
    );

    return slot;
  }

  /**
   * Release a worktree slot. Removes the worktree and frees the slot ID.
   */
  async release(slot: WorktreeSlot): Promise<void> {
    // Find which group owns this slot and remove it
    for (const [groupFolder, slots] of this.activeSlots) {
      if (slots.has(slot.slotId) && slots.get(slot.slotId)?.worktreePath === slot.worktreePath) {
        slots.delete(slot.slotId);
        if (slots.size === 0) this.activeSlots.delete(groupFolder);
        break;
      }
    }

    try {
      // Check for uncommitted changes
      const status = execFileSync('git', ['-C', slot.worktreePath, 'status', '--porcelain'], {
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();

      if (status) {
        logger.warn(
          { slotId: slot.slotId, worktreePath: slot.worktreePath },
          'Worktree has uncommitted changes — leaving for inspection',
        );
        return;
      }

      // Remove the worktree
      execFileSync('git', ['-C', slot.sourcePath, 'worktree', 'remove', slot.worktreePath, '--force'], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      // Delete temporary branch if it was auto-created (not a ref checkout)
      if (!slot.ref) {
        try {
          execFileSync('git', ['-C', slot.sourcePath, 'branch', '-D', slot.branch], {
            encoding: 'utf-8',
            stdio: 'pipe',
          });
        } catch {
          // Branch may already be deleted or merged
        }
      }

      logger.info(
        { slotId: slot.slotId, worktreePath: slot.worktreePath },
        'Worktree slot released',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ slotId: slot.slotId, error: msg }, 'Failed to remove worktree cleanly');
      // Still free the slot so it can be reused
    }
  }

  /**
   * Fetch a PR branch from origin and return the local ref name.
   * Call this before acquire() when checking out a PR.
   */
  fetchPrBranch(sourcePath: string, prNumber: number): string {
    const localRef = `pr-${prNumber}`;
    execFileSync(
      'git',
      ['-C', sourcePath, 'fetch', 'origin', `pull/${prNumber}/head:${localRef}`],
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    logger.info({ sourcePath, prNumber, localRef }, 'PR branch fetched');
    return localRef;
  }

  /** Get all active slots for a group. */
  getActiveSlots(groupFolder: string): WorktreeSlot[] {
    const slots = this.activeSlots.get(groupFolder);
    return slots ? Array.from(slots.values()) : [];
  }

  /** Count available slots (excluding slot 0 which is the original repo). */
  availableSlots(groupFolder: string, maxParallel: number): number {
    const activeCount = this.activeSlots.get(groupFolder)?.size ?? 0;
    return Math.max(0, maxParallel - 1 - activeCount);
  }

  /**
   * Cleanup stale worktrees on startup.
   * Removes worktrees left behind from previous crashes.
   */
  cleanupStale(sourcePath: string, groupFolder: string): void {
    const worktreeDir = path.join(sourcePath, '.worktrees');
    if (!fs.existsSync(worktreeDir)) return;

    const prefix = `${groupFolder}-`;
    for (const entry of fs.readdirSync(worktreeDir)) {
      if (entry.startsWith(prefix)) {
        const fullPath = path.join(worktreeDir, entry);
        try {
          execFileSync('git', ['-C', sourcePath, 'worktree', 'remove', fullPath, '--force'], {
            encoding: 'utf-8',
            stdio: 'pipe',
          });
          logger.info({ path: fullPath }, 'Cleaned up stale worktree');
        } catch {
          logger.warn({ path: fullPath }, 'Failed to clean up stale worktree');
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/worktree-manager.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worktree-manager.ts src/worktree-manager.test.ts
git commit -m "feat: add WorktreeManager for git worktree lifecycle"
```

---

### Task 3: Migrate session DB to support slot IDs

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/db.test.ts` (in the existing sessions describe block, or create one):

```typescript
describe('slot-aware sessions', () => {
  it('stores and retrieves session for slot 0 (default)', () => {
    setSession('test_group', 'session-abc');
    expect(getSession('test_group')).toBe('session-abc');
  });

  it('stores and retrieves session for a specific slot', () => {
    setSession('test_group', 'session-slot1', 1);
    expect(getSession('test_group', 1)).toBe('session-slot1');
    // Slot 0 should be unaffected
    expect(getSession('test_group')).toBeUndefined();
  });

  it('deletes session for a specific slot', () => {
    setSession('test_group', 'session-0');
    setSession('test_group', 'session-1', 1);
    deleteSession('test_group', 1);
    expect(getSession('test_group')).toBe('session-0');
    expect(getSession('test_group', 1)).toBeUndefined();
  });

  it('getAllSessions returns slot 0 sessions only', () => {
    setSession('group_a', 'sess-a');
    setSession('group_b', 'sess-b');
    setSession('group_a', 'sess-a1', 1);
    const all = getAllSessions();
    expect(all['group_a']).toBe('sess-a');
    expect(all['group_b']).toBe('sess-b');
    // Slot 1 sessions should not appear in getAllSessions
  });

  it('deleteSlotSessions removes all non-zero slot sessions for a group', () => {
    setSession('test_group', 'sess-0');
    setSession('test_group', 'sess-1', 1);
    setSession('test_group', 'sess-2', 2);
    deleteSlotSessions('test_group');
    expect(getSession('test_group')).toBe('sess-0');
    expect(getSession('test_group', 1)).toBeUndefined();
    expect(getSession('test_group', 2)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts`
Expected: FAIL — functions don't accept slot parameters.

- [ ] **Step 3: Add DB migration for slot_id column**

In `src/db.ts`, after the existing `context_mode` migration block, add:

```typescript
// Add slot_id to sessions table (migration for worktree parallel containers)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions_new (
      group_folder TEXT NOT NULL,
      slot_id INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL,
      PRIMARY KEY (group_folder, slot_id)
    );
    INSERT OR IGNORE INTO sessions_new (group_folder, slot_id, session_id)
      SELECT group_folder, 0, session_id FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_new RENAME TO sessions;
  `);
} catch {
  // Already migrated
}
```

- [ ] **Step 4: Update session functions to accept optional slotId**

In `src/db.ts`, update the session functions:

```typescript
export function getSession(groupFolder: string, slotId: number = 0): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ? AND slot_id = ?')
    .get(groupFolder, slotId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string, slotId: number = 0): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, slot_id, session_id) VALUES (?, ?, ?)',
  ).run(groupFolder, slotId, sessionId);
}

export function deleteSession(groupFolder: string, slotId: number = 0): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ? AND slot_id = ?').run(groupFolder, slotId);
}

export function deleteSlotSessions(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ? AND slot_id > 0').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions WHERE slot_id = 0')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: migrate sessions table to support per-slot sessions"
```

---

### Task 4: Add per-slot IPC path resolution

**Files:**
- Modify: `src/group-folder.ts`
- Modify: `src/group-folder.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/group-folder.test.ts`:

```typescript
describe('resolveSlotIpcPath', () => {
  it('returns base IPC path for slot 0', () => {
    const result = resolveSlotIpcPath('test_group', 0);
    expect(result).toBe(resolveGroupIpcPath('test_group'));
  });

  it('returns slot-specific path for slot > 0', () => {
    const result = resolveSlotIpcPath('test_group', 1);
    expect(result).toContain('test_group');
    expect(result).toContain('slot-1');
  });

  it('rejects invalid group folders', () => {
    expect(() => resolveSlotIpcPath('../escape', 1)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/group-folder.test.ts`
Expected: FAIL — `resolveSlotIpcPath` not found.

- [ ] **Step 3: Implement `resolveSlotIpcPath`**

Add to `src/group-folder.ts`:

```typescript
export function resolveSlotIpcPath(folder: string, slotId: number): string {
  if (slotId === 0) return resolveGroupIpcPath(folder);
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder, `slot-${slotId}`);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/group-folder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/group-folder.ts src/group-folder.test.ts
git commit -m "feat: add resolveSlotIpcPath for per-slot IPC directories"
```

---

### Task 5: Evolve GroupQueue to multi-slot

**Files:**
- Modify: `src/group-queue.ts`
- Modify: `src/group-queue.test.ts`

This is the largest task. The GroupQueue needs to track multiple active containers per group and route new messages to idle slots or spin up new containers.

- [ ] **Step 1: Write the failing test for parallel slot routing**

Add to `src/group-queue.test.ts`:

```typescript
describe('multi-slot routing', () => {
  it('routes to slot 0 first when idle', async () => {
    const processMessages = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1');
    await vi.advanceTimersByTimeAsync(200);
    expect(processMessages).toHaveBeenCalledTimes(1);
    // Should have been called with groupKey and slotId 0
    expect(processMessages).toHaveBeenCalledWith('group1', 0);
  });

  it('spins up parallel slot when slot 0 is busy and maxParallel > 1', async () => {
    const callSlots: number[] = [];
    const processMessages = vi.fn(async (_groupKey: string, slotId: number) => {
      callSlots.push(slotId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.setMaxParallel('group1', 4);

    queue.enqueueMessageCheck('group1'); // → slot 0
    await vi.advanceTimersByTimeAsync(50); // let slot 0 start
    queue.enqueueMessageCheck('group1'); // → slot 1 (slot 0 busy)

    await vi.advanceTimersByTimeAsync(600);
    expect(callSlots).toContain(0);
    expect(callSlots).toContain(1);
  });

  it('queues when all slots are busy', async () => {
    let callCount = 0;
    const processMessages = vi.fn(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.setMaxParallel('group1', 2); // slot 0 + slot 1 only

    queue.enqueueMessageCheck('group1'); // → slot 0
    await vi.advanceTimersByTimeAsync(50);
    queue.enqueueMessageCheck('group1'); // → slot 1
    await vi.advanceTimersByTimeAsync(50);
    queue.enqueueMessageCheck('group1'); // → queued (both slots busy)

    // Only 2 should be running
    expect(callCount).toBe(2);

    // After slots free up, queued message should run
    await vi.advanceTimersByTimeAsync(600);
    expect(callCount).toBe(3);
  });

  it('pipes to idle slot 0 instead of creating new slot', async () => {
    const processMessages = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.setMaxParallel('group1', 4);

    queue.enqueueMessageCheck('group1');
    await vi.advanceTimersByTimeAsync(200); // slot 0 finishes

    // Mark slot 0 as idle-waiting (container still alive, waiting for input)
    queue.registerProcess('group1', { kill: vi.fn() } as any, 'container-1', 'group1');
    queue.notifyIdle('group1');

    // This should pipe to idle slot, not create slot 1
    const sent = queue.sendMessage('group1', 'follow-up');
    expect(sent).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/group-queue.test.ts`
Expected: FAIL — `setMaxParallel` not found, `processMessages` signature mismatch.

- [ ] **Step 3: Implement multi-slot GroupQueue**

Update `src/group-queue.ts`. Key changes:

1. Change `processMessagesFn` signature to include `slotId`:
```typescript
private processMessagesFn: ((groupKey: string, slotId: number) => Promise<boolean>) | null = null;

setProcessMessagesFn(fn: (groupKey: string, slotId: number) => Promise<boolean>): void {
  this.processMessagesFn = fn;
}
```

2. Add `maxParallelConfig` map and setter:
```typescript
private maxParallelConfig = new Map<string, number>();

setMaxParallel(groupKey: string, max: number): void {
  this.maxParallelConfig.set(groupKey, max);
}

private getMaxParallel(groupKey: string): number {
  return this.maxParallelConfig.get(groupKey) ?? 1;
}
```

3. Track active slots per group instead of single `active` boolean. Add `activeSlots` set to `GroupState`:
```typescript
interface GroupState {
  activeSlots: Set<number>;
  idleWaiting: boolean;         // slot 0 only
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;       // slot 0 process
  containerName: string | null;       // slot 0 container name
  groupFolder: string | null;
  retryCount: number;
  slotProcesses: Map<number, { process: ChildProcess; containerName: string }>;
}
```

4. Update `enqueueMessageCheck` to find next available slot:
   - If slot 0 idle-waiting → return (sendMessage will pipe to it)
   - If slot 0 not active → run on slot 0
   - If slot 0 busy and `maxParallel > 1` and slots available → run on next slot
   - Otherwise → queue

5. Update `runForGroup` to accept and pass `slotId`.

6. Update `registerProcess` to accept `slotId`.

7. Track slot counts against `activeCount` for global concurrency.

The full implementation is significant — the engineer should preserve all existing behavior for slot 0 and add parallel slot support on top. All existing tests must continue to pass (they all use the default `maxParallel: 1`).

- [ ] **Step 4: Run all tests**

Run: `npx vitest run src/group-queue.test.ts`
Expected: All tests PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/group-queue.ts src/group-queue.test.ts
git commit -m "feat: evolve GroupQueue to support multi-slot parallel containers"
```

---

### Task 6: Update ContainerRunner for worktree mounts and per-slot IPC

**Files:**
- Modify: `src/container-runner.ts`

- [ ] **Step 1: Add `slotId` and `worktreeRef` to `ContainerInput`**

In `src/container-runner.ts`, update the `ContainerInput` interface:

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  keepAlive?: boolean;
  slotId?: number;
  worktreeRef?: string;
  assistantName?: string;
  script?: string;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
}
```

- [ ] **Step 2: Update `buildVolumeMounts` to accept a `WorktreeSlot`**

Add `worktreeSlot?: WorktreeSlot` parameter to `buildVolumeMounts`. When provided, replace the matching `additionalMounts` hostPath with `worktreeSlot.worktreePath`:

```typescript
function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  worktreeSlot?: WorktreeSlot,
): VolumeMount[] {
  // ... existing code ...

  // Additional mounts — apply worktree override if slot provided
  if (group.containerConfig?.additionalMounts) {
    const resolvedMounts = group.containerConfig.additionalMounts.map((m) => {
      const resolved = { ...m, hostPath: resolveHostPath(m.hostPath) };
      // If this mount matches the worktree source, use the worktree path instead
      if (worktreeSlot && resolved.hostPath === worktreeSlot.sourcePath) {
        return { ...resolved, hostPath: worktreeSlot.worktreePath };
      }
      return resolved;
    });
    // ... rest of validation ...
  }
}
```

- [ ] **Step 3: Use per-slot IPC paths for non-zero slots**

Import `resolveSlotIpcPath` from `group-folder.ts`. In `buildVolumeMounts`, when `worktreeSlot` is provided, use slot-specific IPC:

```typescript
import { resolveGroupFolderPath, resolveGroupIpcPath, resolveSlotIpcPath } from './group-folder.js';

// In buildVolumeMounts:
const slotId = worktreeSlot?.slotId ?? 0;
const groupIpcDir = resolveSlotIpcPath(group.folder, slotId);
```

- [ ] **Step 4: Pass `worktreeSlot` from `runContainerAgent`**

Update `runContainerAgent` to accept optional `worktreeSlot` parameter and pass it to `buildVolumeMounts`:

```typescript
export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  worktreeSlot?: WorktreeSlot,
): Promise<ContainerOutput> {
  // ...
  const mounts = buildVolumeMounts(group, input.isMain, worktreeSlot);
  // ...
}
```

- [ ] **Step 5: Disable keep-alive and port mappings for non-zero slots**

In `buildContainerArgs`, when `input.slotId > 0`, skip port mappings (dev servers only run in slot 0):

```typescript
// Port mappings only for slot 0 (dev servers)
if (portMappings && (!input?.slotId || input.slotId === 0)) {
  for (const mapping of portMappings) {
    args.push('-p', mapping);
  }
}
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 7: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: support worktree mounts and per-slot IPC in container runner"
```

---

### Task 7: Wire up parallel routing in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import WorktreeManager and wire into startup**

```typescript
import { WorktreeManager } from './worktree-manager.js';

// At module level:
const worktreeManager = new WorktreeManager();
```

- [ ] **Step 2: Set maxParallel on the queue for each registered group**

In the startup section where registered groups are loaded, call `queue.setMaxParallel`:

```typescript
for (const [jid, groups] of Object.entries(registeredGroups)) {
  for (const group of groups) {
    const maxParallel = group.containerConfig?.maxParallel ?? 1;
    if (maxParallel > 1) {
      queue.setMaxParallel(group.folder, maxParallel);
    }
  }
}
```

- [ ] **Step 3: Update `processMessagesFn` callback to accept slotId**

The queue now calls `processMessagesFn(groupKey, slotId)`. Update the callback:

```typescript
queue.setProcessMessagesFn(async (groupKey: string, slotId: number) => {
  return processGroupMessages(groupKey, slotId);
});
```

Update `processGroupMessages` signature:

```typescript
async function processGroupMessages(groupKey: string, slotId: number = 0): Promise<boolean> {
```

- [ ] **Step 4: Acquire worktree for non-zero slots**

In `processGroupMessages`, when `slotId > 0`, acquire a worktree before spawning the container:

```typescript
let worktreeSlot: WorktreeSlot | undefined;
if (slotId > 0 && group.containerConfig?.additionalMounts?.length) {
  // Find the first additional mount (the repo to create a worktree for)
  const repoMount = group.containerConfig.additionalMounts[0];
  const resolvedPath = resolveHostPath(repoMount.hostPath);
  try {
    worktreeSlot = await worktreeManager.acquire(resolvedPath, group.folder);
  } catch (err) {
    logger.error({ groupKey, slotId, err }, 'Failed to acquire worktree');
    return false;
  }
}
```

- [ ] **Step 5: Pass worktreeSlot to runAgent and release on completion**

Update `runAgent` to accept and forward `worktreeSlot`:

```typescript
const output = await runAgent(group, prompt, chatJid, imageAttachments, wrappedOnOutput, worktreeSlot);

// After runAgent completes, release worktree
if (worktreeSlot) {
  await worktreeManager.release(worktreeSlot);
}
```

- [ ] **Step 6: Use slot-aware sessions**

Replace `sessions[group.folder]` with `getSession(group.folder, slotId)`:

```typescript
const sessionId = slotId === 0
  ? sessions[group.folder]
  : getSession(group.folder, slotId);
```

And update session saves:

```typescript
if (output.newSessionId) {
  if (slotId === 0) {
    sessions[group.folder] = output.newSessionId;
  }
  setSession(group.folder, output.newSessionId, slotId);
}
```

- [ ] **Step 7: Inject worktree context into prompt for non-zero slots**

When `slotId > 0`, prepend context to the prompt:

```typescript
if (worktreeSlot) {
  const ctx = `[System: You are running in parallel slot ${worktreeSlot.slotId} (worktree). The repo at /workspace/extra/${path.basename(worktreeSlot.sourcePath)} is a worktree copy. Your work branch: ${worktreeSlot.branch}. Do not start dev servers — they run in the primary container only.]`;
  prompt = `${ctx}\n\n${prompt}`;
}
```

- [ ] **Step 8: Inject agent swarm context when keywords detected**

Check the prompt for swarm keywords and inject context:

```typescript
const SWARM_KEYWORDS = /\b(use agents?|with agents?|agent swarm)\b/i;
if (SWARM_KEYWORDS.test(prompt)) {
  const swarmCtx = `[System: Agent swarm requested. You may use the agent orchestration system (@system-architect, @implementation, @quality-assurance, @integration) for this task. See .claude/QUICK_START_AGENTS.md for the workflow.]`;
  prompt = `${swarmCtx}\n\n${prompt}`;
}
```

- [ ] **Step 9: Disable keep-alive for non-zero slots**

When building ContainerInput, set `keepAlive: false` for non-zero slots:

```typescript
keepAlive: slotId === 0 && (group.containerConfig?.ports?.length ?? 0) > 0,
```

- [ ] **Step 10: Verify build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 11: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire parallel slot routing, worktree acquisition, and swarm context"
```

---

### Task 8: Update agent runner for slot context

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Add `slotId` and `worktreeRef` to ContainerInput**

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  keepAlive?: boolean;
  slotId?: number;
  worktreeRef?: string;
  assistantName?: string;
  script?: string;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
}
```

- [ ] **Step 2: Log slot context on startup**

In the `main()` function, after parsing input, log the slot info:

```typescript
if (containerInput.slotId && containerInput.slotId > 0) {
  log(`Running in parallel slot ${containerInput.slotId} (worktree mode)`);
  if (containerInput.worktreeRef) {
    log(`Worktree ref: ${containerInput.worktreeRef}`);
  }
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build && ./container/build.sh`
Expected: Both compile and container image build succeed.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: add slot context logging to agent runner"
```

---

### Task 9: Configure mft groups with maxParallel and integration test

**Files:**
- No code files — DB update + manual test

- [ ] **Step 1: Update mft group configs in DB**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');
for (const folder of ['slack_mft', 'whatsapp_mft']) {
  const row = db.prepare('SELECT container_config FROM registered_groups WHERE folder = ?').get(folder);
  const config = JSON.parse(row.container_config);
  config.maxParallel = 4;
  db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(JSON.stringify(config), folder);
  console.log(folder + ': maxParallel set to 4');
}
db.close();
"
```

- [ ] **Step 2: Rebuild and restart**

```bash
npm run build
./container/build.sh
nanoclaw restart
```

- [ ] **Step 3: Integration test — send two messages**

In Slack, send:
```
@mft what files changed in the last commit?
```
Wait for it to start working, then immediately send:
```
@mft what's the status of MS-970?
```

Expected: Both messages get responses without the second one waiting for the first.

- [ ] **Step 4: Integration test — PR review in parallel**

While @mft is working on something, send:
```
@mft review pr #<recent-PR-number>
```

Expected: PR review starts in a separate worktree container.

- [ ] **Step 5: Verify worktree cleanup**

After the parallel container finishes, verify the worktree was removed:

```bash
ls /Users/lenny/github/mashie/.worktrees/ 2>/dev/null
```

Expected: Empty or directory doesn't exist.

- [ ] **Step 6: Commit config changes (if any)**

```bash
git add -A && git commit -m "feat: enable maxParallel=4 for mft groups"
```

---

### Task 10: Startup cleanup of stale worktrees

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add stale worktree cleanup on startup**

In the startup section of `index.ts`, after loading registered groups, clean up stale worktrees:

```typescript
// Clean up stale worktrees from previous crashes
for (const [, groups] of Object.entries(registeredGroups)) {
  for (const group of groups) {
    if ((group.containerConfig?.maxParallel ?? 1) > 1 && group.containerConfig?.additionalMounts?.length) {
      const repoMount = group.containerConfig.additionalMounts[0];
      const resolvedPath = resolveHostPath(repoMount.hostPath);
      worktreeManager.cleanupStale(resolvedPath, group.folder);
    }
    // Clear ephemeral slot sessions
    deleteSlotSessions(group.folder);
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: clean up stale worktrees and slot sessions on startup"
```

---

## Summary

| Task | Description | Estimated Complexity |
|------|-------------|---------------------|
| 1 | Types: maxParallel + WorktreeSlot | Small |
| 2 | WorktreeManager module + tests | Medium |
| 3 | DB migration: slot-aware sessions | Medium |
| 4 | Per-slot IPC path resolution | Small |
| 5 | GroupQueue multi-slot evolution | Large |
| 6 | ContainerRunner worktree mounts | Medium |
| 7 | index.ts wiring (routing, sessions, context) | Large |
| 8 | Agent runner slot context | Small |
| 9 | Config + integration test | Small |
| 10 | Startup cleanup | Small |

Tasks 1-4 are independent and can be parallelized. Tasks 5-7 depend on 1-4. Tasks 8-10 depend on 5-7.
