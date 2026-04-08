import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorktreeManager } from './worktree-manager.js';

/** Create a temporary git repo and return its path. */
function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-worktree-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  // Need at least one commit so we can create worktrees
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

/** Recursively remove a directory. */
function rmrf(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('WorktreeManager', () => {
  let manager: WorktreeManager;
  let repoDir: string;
  const groupFolder = 'test-group';

  beforeEach(() => {
    manager = new WorktreeManager();
    repoDir = makeTempRepo();
  });

  afterEach(() => {
    rmrf(repoDir);
  });

  it('acquires a worktree slot and creates the directory', async () => {
    const slot = await manager.acquire(repoDir, groupFolder);
    expect(fs.existsSync(slot.worktreePath)).toBe(true);
    expect(slot.slotId).toBeGreaterThan(0);
    expect(slot.sourcePath).toBe(repoDir);

    // cleanup
    await manager.release(slot);
  });

  it('assigns incrementing slot IDs starting at 1', async () => {
    const slot1 = await manager.acquire(repoDir, groupFolder);
    const slot2 = await manager.acquire(repoDir, groupFolder);

    expect(slot1.slotId).toBe(1);
    expect(slot2.slotId).toBe(2);

    await manager.release(slot1);
    await manager.release(slot2);
  });

  it('releases a slot and removes the worktree directory', async () => {
    const slot = await manager.acquire(repoDir, groupFolder);
    const worktreePath = slot.worktreePath;
    expect(fs.existsSync(worktreePath)).toBe(true);

    await manager.release(slot);
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it('reports available slots correctly', async () => {
    const maxParallel = 3;
    // No active slots: maxParallel - 1 (slot 0 is original repo)
    expect(manager.availableSlots(groupFolder, maxParallel)).toBe(
      maxParallel - 1,
    );

    const slot = await manager.acquire(repoDir, groupFolder);
    expect(manager.availableSlots(groupFolder, maxParallel)).toBe(
      maxParallel - 2,
    );

    await manager.release(slot);
    expect(manager.availableSlots(groupFolder, maxParallel)).toBe(
      maxParallel - 1,
    );
  });

  it('returns empty array for group with no active slots', () => {
    const slots = manager.getActiveSlots('no-such-group');
    expect(slots).toEqual([]);
  });

  it('reuses released slot IDs', async () => {
    const slot1 = await manager.acquire(repoDir, groupFolder);
    expect(slot1.slotId).toBe(1);

    await manager.release(slot1);

    const slot2 = await manager.acquire(repoDir, groupFolder);
    expect(slot2.slotId).toBe(1); // reused

    await manager.release(slot2);
  });

  it('acquires with a specific ref (branch name)', async () => {
    // Create a feature branch in the repo
    execFileSync('git', ['checkout', '-b', 'feature-x'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'feature work');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'feature commit'], { cwd: repoDir });
    execFileSync('git', ['checkout', 'main'], { cwd: repoDir });

    const slot = await manager.acquire(repoDir, groupFolder, 'feature-x');
    expect(fs.existsSync(slot.worktreePath)).toBe(true);
    expect(slot.ref).toBe('feature-x');
    // The feature file should exist in the worktree
    expect(fs.existsSync(path.join(slot.worktreePath, 'feature.txt'))).toBe(
      true,
    );

    await manager.release(slot);
  });
});
