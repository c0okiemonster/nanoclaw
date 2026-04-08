# Worktree-Based Parallel Containers

## Problem

When you tag @mft while it's already working, the second message queues and waits. This blocks common workflows like reviewing a PR while a feature is being built, or fixing two independent issues simultaneously. The agent can only do one thing at a time per group, even when the tasks are independent.

## Solution

Allow multiple concurrent containers per group, each with its own git worktree of the mounted repo. The original repo (slot 0) is never modified by parallel containers — all parallel work happens in dedicated worktrees to prevent branch switching or interference.

## Key Decisions

- **maxParallel: 4** per group (configurable in `ContainerConfig`)
- **Slot 0** = the original repo mount (current behavior, keep-alive with dev servers)
- **Slots 1-N** = temporary git worktrees, created on demand, cleaned up after
- **All parallel work uses worktrees** — including your own PRs, to avoid switching the branch in slot 0
- **PR fixes** use the `mashie-pr-review-fix` skill (not `mashie-pr-review`)
- **PR reviews** use the `mashie-pr-review` skill

## Scenarios

### 1. Fix while working
```
You:   @mft fix the memo crash
       → [slot 0: working on original repo]
You:   @mft fix the UTC offset bug
       → [slot 1: worktree from HEAD, branch mft/slot-1-utc-fix]
```

### 2. Review someone else's PR
```
You:   @mft implement MS-907
       → [slot 0: working]
You:   @mft review pr #284
       → [slot 1: worktree checks out PR #284's branch, runs mashie-pr-review]
```

### 3. Fix PR review comments (own or others)
```
You:   @mft fix pr #284
       → [slot 1: worktree checks out PR #284's branch, runs mashie-pr-review-fix]
```

### 4. New feature from description
```
You:   @mft new feature: dietary filter for weekly menu
       → [slot 1: worktree from HEAD, creates Jira ticket + branch + scaffolding]
```

### 5. Multiple parallel tasks
```
You:   @mft fix the failing test       → [slot 0]
You:   @mft review pr #291             → [slot 1: worktree]
You:   @mft what's the status of MS-970 → [slot 2: no worktree needed, just Jira lookup]
```

## Architecture

### New Module: WorktreeManager

`src/worktree-manager.ts` — manages git worktree lifecycle for mounted repos.

```
Responsibilities:
- Create worktrees from a source repo path
- Check out a specific ref (branch, PR, commit SHA, or HEAD)
- Track active slots per group
- Clean up worktrees when containers finish
- Handle PR branch fetching (git fetch origin pull/N/head)
```

**Interface:**

```typescript
interface WorktreeSlot {
  slotId: number;
  worktreePath: string;      // e.g. /Users/lenny/github/mashie/.worktrees/mft-1
  sourcePath: string;        // e.g. /Users/lenny/github/mashie
  branch: string;            // e.g. mft/slot-1-fix-test
  ref?: string;              // e.g. PR #284's branch, or HEAD
  createdAt: number;
}

interface WorktreeManager {
  // Acquire the next available slot, create a worktree
  acquire(sourcePath: string, groupFolder: string, ref?: string): Promise<WorktreeSlot>;

  // Release a slot, clean up the worktree
  release(slot: WorktreeSlot): Promise<void>;

  // Get active slots for a group
  getActiveSlots(groupFolder: string): WorktreeSlot[];

  // Check available slot count
  availableSlots(groupFolder: string, maxParallel: number): number;
}
```

**Worktree Location:**

```
{repo}/.worktrees/{groupFolder}-{slotId}/
e.g. /Users/lenny/github/mashie/.worktrees/slack_mft-1/
     /Users/lenny/github/mashie/.worktrees/slack_mft-2/
     /Users/lenny/github/mashie/.worktrees/slack_mft-3/
```

**PR Branch Fetching:**

```bash
# For "review pr #284" or "fix pr #284":
git fetch origin pull/284/head:pr-284
git worktree add .worktrees/slack_mft-1 pr-284
```

### Changes to GroupQueue

`src/group-queue.ts` — currently enforces one container per group. Needs to support multiple.

**Current:** `GroupState.active` is a boolean — one container per group.

**New:** `GroupState` tracks multiple active slots:

```typescript
interface GroupState {
  slots: Map<number, SlotState>;  // slot 0 = primary, 1-N = worktree
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  retryCount: number;
}

interface SlotState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  worktreeSlot?: WorktreeSlot;
}
```

**Routing logic when a new message arrives:**

1. If slot 0 is **idle-waiting** → pipe message to it (current behavior, via IPC)
2. If slot 0 is **busy** and slots available → acquire worktree, spin up new container in next slot
3. If all slots busy → queue the message (current behavior)

### Changes to ContainerRunner

`src/container-runner.ts` — needs to mount the worktree path instead of the original repo.

**`buildVolumeMounts`** changes:

- Receives an optional `WorktreeSlot`
- If slot provided, mount `slot.worktreePath` at `/workspace/extra/{name}` instead of the original `hostPath`
- Each slot gets its own IPC namespace: `data/ipc/{groupFolder}/slot-{slotId}/`
- Each slot gets its own session: keyed by `{groupFolder}:slot-{slotId}`

**`ContainerInput`** additions:

```typescript
interface ContainerInput {
  // ... existing fields ...
  slotId?: number;           // Which slot this container runs in
  worktreeRef?: string;      // What ref was checked out (for agent context)
}
```

### Changes to ContainerInput / Agent Context

The agent needs to know it's in a worktree so it behaves correctly:

- **Slot 0** (original): full behavior, dev servers, keep-alive
- **Slots 1-N** (worktree): no keep-alive, no dev servers, task-focused

The agent receives context like:

```
[System: You are running in parallel slot 1 (worktree). 
 The repo at /workspace/extra/mashie is a worktree copy, not the original.
 Your work will be on branch: mft/slot-1-fix-test
 Do not start dev servers in this container.]
```

### Changes to Session DB

Currently keyed by `group_folder`. Needs to support per-slot sessions.

```sql
-- Current
CREATE TABLE sessions (group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL);

-- New: add slot_id, default 0 for backwards compatibility
CREATE TABLE sessions (
  group_folder TEXT NOT NULL,
  slot_id INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL,
  PRIMARY KEY (group_folder, slot_id)
);
```

Slot 0 sessions persist across restarts (current behavior). Worktree slot sessions (1-N) are ephemeral — cleared when the worktree is released.

### Changes to ContainerConfig

```typescript
interface ContainerConfig {
  // ... existing fields ...
  maxParallel?: number;  // Default: 1 (current behavior). Set to 4 for parallel.
}
```

### Changes to IPC

Each slot gets its own IPC directory:

```
data/ipc/{groupFolder}/           ← slot 0 (current, unchanged)
data/ipc/{groupFolder}/slot-1/    ← slot 1
data/ipc/{groupFolder}/slot-2/    ← slot 2
data/ipc/{groupFolder}/slot-3/    ← slot 3
```

Messages, tasks, and input directories are per-slot.

### Worktree Cleanup

When a worktree container exits (code 0 or timeout):

1. WorktreeManager checks if there are uncommitted changes
2. If clean: `git worktree remove .worktrees/slack_mft-1`
3. If dirty: log a warning, leave the worktree for manual inspection
4. Release the slot so it can be reused

Temporary branches (`mft/slot-N-*`) are deleted after merge or after 7 days of inactivity.

### Mount Override Integration

The existing `mount-overrides.json` system applies to worktrees too. If the source repo path is overridden (e.g. `/Users/lenny/github/mashie` → `/Users/lenny/github/matilda/mashie`), the worktree is created under the resolved path.

## What Changes

| File | Change |
|------|--------|
| `src/worktree-manager.ts` | **New** — worktree lifecycle management |
| `src/group-queue.ts` | Multi-slot support, routing logic |
| `src/container-runner.ts` | Worktree mount support, per-slot IPC/sessions |
| `src/index.ts` | Pass slot info to container, session key changes |
| `src/db.ts` | Session table migration (add `slot_id`) |
| `src/types.ts` | Add `maxParallel` to `ContainerConfig` |
| `container/agent-runner/src/index.ts` | Receive slot context, skip dev servers in worktrees |

## What Stays the Same

- Slot 0 behavior is identical to today (keep-alive, dev servers, IPC)
- Channel layer (Slack/WhatsApp) — unchanged
- Mount security (allowlist, overrides) — unchanged
- Container skills — unchanged
- Groups with `maxParallel: 1` (default) behave exactly as today

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Two worktrees editing same files → merge conflict | Agent handles merge or flags to user |
| Worktree cleanup fails → disk space leak | Startup cleanup: remove stale worktrees on NanoClaw start |
| Too many containers → resource exhaustion | `maxParallel` cap + `MAX_CONCURRENT_CONTAINERS` global cap |
| PR branch not found | Agent reports error, worktree not created |
| Slot 0 branch changes while worktrees exist | Worktrees are independent — no effect |

## Migration

- **DB migration**: Add `slot_id` column to sessions table with default 0
- **Config**: Add `maxParallel: 4` to mft group configs
- **No breaking changes**: Default `maxParallel: 1` preserves current behavior for all groups
