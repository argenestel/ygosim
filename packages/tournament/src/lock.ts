import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

class LockBusy extends Error {}

/** Publish a populated directory atomically; immutable owner names protect stale recovery. */
async function claim(path: string): Promise<() => Promise<void>> {
  const nonce = randomUUID();
  const prepared = `${path}.${nonce}.tmp`;
  const owner = `owner-${process.pid}-${nonce}`;
  await mkdir(prepared);
  try {
    await writeFile(join(prepared, owner), '');
    try { await rename(prepared, path); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      let entries: string[];
      try { entries = await readdir(path); }
      catch (readError) { if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError; entries = []; }
      if (entries.length) {
        const oldOwner = entries.length === 1 ? /^owner-(\d+)-[a-zA-Z0-9-]+$/.exec(entries[0]!) : null;
        if (!oldOwner) throw new LockBusy(`Lock is already held: ${path}`);
        let dead = false;
        try { process.kill(Number(oldOwner[1]), 0); }
        catch (pidError) { dead = (pidError as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!dead) throw new LockBusy(`Lock is already held: ${path}`);
        // Only one contender can remove this exact old owner. A new owner's
        // different nonce can never be mistaken for the stale owner.
        try { await unlink(join(path, entries[0]!)); }
        catch { throw new LockBusy(`Lock ownership changed: ${path}`); }
      }
      try { await rename(prepared, path); }
      catch (renameError) {
        if (['EEXIST', 'ENOTEMPTY'].includes((renameError as NodeJS.ErrnoException).code ?? '')) throw new LockBusy(`Lock ownership changed: ${path}`);
        throw renameError;
      }
    }
  } finally { await rm(prepared, { recursive: true, force: true }); }
  return async () => {
    try { await unlink(join(path, owner)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    // A new populated lock may have replaced our now-empty directory. Never
    // remove it recursively; rmdir only succeeds while the directory is empty.
    try { await rmdir(path); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  };
}

export async function acquireLock(path: string, waitMs = 0): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { return await claim(path); }
    catch (error) {
      if (!(error instanceof LockBusy) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
