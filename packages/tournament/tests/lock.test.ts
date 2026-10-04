import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireLock } from '../src/lock.js';

it('serializes owners and recovers an empty lock left during release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tournament-lock-unit-'));
  try {
    const path = join(root, '.lock');
    const release = await acquireLock(path);
    await expect(acquireLock(path)).rejects.toThrow('already held');
    const pending = acquireLock(path, 1000);
    await release();
    const nextRelease = await pending;
    expect(await readdir(path)).toHaveLength(1);
    await nextRelease();
    await mkdir(path);
    const emptyRelease = await acquireLock(path);
    await emptyRelease();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('allows only one contender to replace an immutable dead owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tournament-lock-stale-'));
  try {
    const path = join(root, '.lock');
    await mkdir(path); await writeFile(join(path, 'owner-2147483647-stale'), '');
    const attempts = await Promise.allSettled([acquireLock(path), acquireLock(path)]);
    const successful = attempts.filter((attempt): attempt is PromiseFulfilledResult<() => Promise<void>> => attempt.status === 'fulfilled');
    expect(successful).toHaveLength(1);
    await successful[0]!.value();
  } finally { await rm(root, { recursive: true, force: true }); }
});
