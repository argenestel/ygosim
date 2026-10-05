import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../src/sandbox.js', () => ({ sandboxCommand: async (command: any) => ({ ...command, cleanup: async () => {} }) }));
import { agentCommand, runAgent } from '../src/agent-process.js';
import { getRosterPlayer, ROSTER } from '../src/roster.js';
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); spawnMock.mockReset(); });
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
      child.emit('close', 0, null);
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

it('restricts built-in tools and keeps organizer credentials out of the process environment', () => {
  vi.stubEnv('YGOSIM_TOURNAMENT_READ_TOKEN', 'synthetic-organizer-fixture');
  const codex = agentCommand(ROSTER[0]!, 'http://localhost/mcp', '/fixture', 'play', '', false);
  expect(codex.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(codex.args).toContain('read-only'); expect(codex.args).toContain('shell_tool');
  const pi = agentCommand(ROSTER.find(player => player.cli === 'pi')!, 'http://localhost/mcp', '/fixture', 'play', '', false);
  expect(pi.args).toContain('--no-builtin-tools'); expect(pi.args).toContain('--no-context-files');
  const claude = agentCommand(ROSTER.at(-1)!, 'http://localhost/mcp', '/fixture', 'play', '', false, 'Bearer synthetic-player-fixture');
  expect(claude.args).toContain('--restricted'); expect(claude.args).toContain('/fixture/claude-mcp.json');
  expect(claude.args.join(' ')).not.toContain('synthetic-player-fixture');
  for (const command of [codex, pi, claude]) expect(command.env).not.toHaveProperty('YGOSIM_TOURNAMENT_READ_TOKEN');
});

it('rejects configuration symlinks and hardlinks before starting a process or changing their targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tournament-agent-config-'));
  try {
    const target = join(root, 'outside'); await writeFile(target, 'original');
    for (const kind of ['symlink', 'hardlink'] as const) {
      const dir = join(root, kind); const piDir = join(dir, '.workdir', ROSTER[0]!.id, '.pi'); await mkdir(piDir, { recursive: true });
      if (kind === 'symlink') await symlink(target, join(piDir, 'mcp.json')); else await link(target, join(piDir, 'mcp.json'));
      await expect(runAgent({ player: ROSTER[0]!, url: 'url', gameDir: dir, prompt: 'play', signal: new AbortController().signal,
        isEnded: () => false, onResume: async () => {} })).rejects.toThrow('configuration safely');
      expect(await readFile(target, 'utf8')).toBe('original');
    }
    expect(spawnMock).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('does not prepare configuration or spawn an already-aborted agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tournament-agent-aborted-'));
  try {
    const controller = new AbortController(); controller.abort();
    await runAgent({ player: ROSTER[0]!, url: 'url', gameDir: dir, prompt: 'play', signal: controller.signal, isEnded: () => false, onResume: async () => {} });
    expect(spawnMock).not.toHaveBeenCalled();
    await expect(access(join(dir, '.workdir'))).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('redacts split credential output and stops on unsuccessful CLI exits instead of scoring exhaustion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tournament-agent-redaction-'));
  spawnMock.mockImplementation(() => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write('{"type":"thread.started","thread_id":"fixture"}\n{"note":"synthetic-');
      child.stdout.write('player-fixture"}\n'); child.stderr.write('synthetic-player-fixture\n'); child.emit('close', 1, null);
    });
    return child;
  });
  try {
    await expect(runAgent({ player: ROSTER[0]!, url: 'url', authorization: 'Bearer synthetic-player-fixture', gameDir: dir, prompt: 'play', signal: new AbortController().signal,
      isEnded: () => false, onResume: async () => {} })).rejects.toThrow('infrastructure validation required');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    for (const suffix of ['transcript.jsonl', 'stderr.log']) {
      const text = await readFile(join(dir, `${ROSTER[0]!.id}.${suffix}`), 'utf8');
      expect(text).not.toContain('synthetic-player-fixture'); expect(text).toContain('[REDACTED]');
    }
    await expect(access(join(dir, '.workdir', ROSTER[0]!.id, 'claude-mcp.json'))).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('selects Luna through Pi openai-codex with max thinking and no unrelated provider key', () => {
  vi.stubEnv('XAI_API_KEY', 'synthetic-xai-fixture');
  const command = agentCommand(getRosterPlayer('pi-luna-max')!, 'http://localhost/mcp', '/fixture', 'play', '', false);
  expect(command.command).toBe('pi');
  expect(command.args.slice(command.args.indexOf('--provider'), command.args.indexOf('--thinking') + 2)).toEqual(['--provider', 'openai-codex', '--model', 'gpt-6-luna', '--thinking', 'max']);
  expect(command.env).not.toHaveProperty('XAI_API_KEY');
  const custom = agentCommand(getRosterPlayer('pi-luna-max')!, 'http://localhost/mcp', '/fixture', 'play', '', false, undefined, true);
  expect(custom.args[custom.args.indexOf('--tools') + 1]).not.toContain('list_decks');
  expect(custom.args[custom.args.indexOf('--tools') + 1]).toContain('card_info');
});

it('audits Pi provider, model and effective thinking level from its private session metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tournament-pi-metadata-')); let ended = false;
  const onModel = vi.fn(); const onEffort = vi.fn();
  spawnMock.mockImplementation((_command, _args, options) => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    void writeFile(join(options.cwd, 'sessions', 'fixture.jsonl'), `${JSON.stringify({ type: 'model_change', provider: 'openai-codex', modelId: 'gpt-6-luna' })}\n${JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'max' })}\n`).then(() => { ended = true; child.emit('close', 0, null); });
    return child;
  });
  try {
    await runAgent({ player: getRosterPlayer('pi-luna-max')!, url: 'url', gameDir: dir, prompt: 'play', signal: new AbortController().signal,
      isEnded: () => ended, onResume: async () => {}, onModel, onEffort });
    expect(onModel).toHaveBeenCalledWith('openai-codex/gpt-6-luna'); expect(onEffort).toHaveBeenCalledWith('max');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
