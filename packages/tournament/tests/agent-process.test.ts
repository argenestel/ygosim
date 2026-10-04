import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
import { runAgent } from '../src/agent-process.js';
import { ROSTER } from '../src/roster.js';
afterEach(() => { vi.useRealTimers(); spawnMock.mockReset(); });
it('captures split thread events and stops after exactly six resumes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tournament-agent-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let started!: () => void;
  const firstSpawn = new Promise<void>(resolve => { started = resolve; });
  spawnMock.mockImplementation(() => {
    started();
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write('{"type":"thread.started","thread_');
      child.stdout.write('id":"test-thread"}\n');
      child.stderr.write('CLI diagnostic\n');
      child.emit('close', 1, null);
    });
    return child;
  });
  const resumes = vi.fn(async () => {});
  try {
    const task = runAgent({ player: ROSTER[0]!, url: 'http://localhost/mcp', gameDir: dir,
      prompt: 'play', signal: new AbortController().signal, onResume: resumes, isEnded: () => false });
    // Wait for real filesystem setup explicitly; wall-clock load must not
    // consume an arbitrary number of fake retry ticks before the first spawn.
    await firstSpawn;
    await new Promise<void>(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(7000);
    await task;
    expect(spawnMock).toHaveBeenCalledTimes(7);
    expect(resumes).toHaveBeenCalledTimes(6);
    expect(spawnMock.mock.calls[1]![1].slice(0, 3)).toEqual(['exec', 'resume', 'test-thread']);
    expect((await readFile(join(dir, 'codex-sol.transcript.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(7);
    expect(await readFile(join(dir, 'codex-sol.stderr.log'), 'utf8')).toContain('CLI diagnostic');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('terminates the detached process group, escalating after a grace period', async () => {
  const { terminateTree } = await import('../src/agent-process.js');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    terminateTree({ pid: 12345, kill: vi.fn() } as any);
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(3000);
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
  } finally { kill.mockRestore(); }
});

it('kills descendants at exit before waiting for their inherited pipes to close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tournament-agent-exit-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let ended = false;
  let child: any;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    child.emit('close', 0, null);
    return true;
  });
  spawnMock.mockImplementation(() => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 98765;
    queueMicrotask(() => {
      child.stdout.write('{"type":"thread.started","thread_id":"thread"}\n');
      ended = true;
      child.emit('exit', 0, null);
    });
    return child;
  });
  try {
    await runAgent({ player: ROSTER[0]!, url: 'url', gameDir: dir, prompt: 'play', signal: new AbortController().signal,
      isEnded: () => ended, onResume: vi.fn(async () => {}) });
    expect(kill).toHaveBeenCalledWith(-98765, 'SIGTERM');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  } finally { kill.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});

it('reports a missing Codex thread rather than starting fresh continuation sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tournament-agent-thread-'));
  spawnMock.mockImplementation(() => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => child.emit('close', 1, null));
    return child;
  });
  try {
    await expect(runAgent({ player: ROSTER[0]!, url: 'url', gameDir: dir, prompt: 'play', signal: new AbortController().signal,
      isEnded: () => false, onResume: vi.fn(async () => {}) })).rejects.toThrow('no session is available to resume');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
