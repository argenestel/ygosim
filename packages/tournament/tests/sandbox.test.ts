import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentCommand } from '../src/agent-process.js';
import { ROSTER } from '../src/roster.js';
import { sandboxCommand } from '../src/sandbox.js';
import type { Player } from '../src/types.js';

const execute = promisify(execFile);
const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
const availability = vi.hoisted(() => ({ missingBubblewrap: false }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async access(path: Parameters<typeof actual.access>[0], mode?: number) {
      if (availability.missingBubblewrap && String(path).endsWith('/bwrap') && mode === constants.X_OK) {
        throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
      }
      return actual.access(path, mode);
    },
  };
});

afterEach(async () => {
  availability.missingBubblewrap = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function player(cli: Player['cli']): Player {
  return { id: 'fixture', label: 'Fixture', cli, model: 'offline-fixture' };
}

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'ygosim-sandbox-'));
  roots.push(root);
  const workdir = join(root, 'player');
  const hostHome = join(root, 'host-home');
  await fs.mkdir(workdir);
  await fs.mkdir(hostHome);
  return { root, workdir, hostHome, env: { PATH: process.env.PATH, HOME: hostHome } };
}

async function wrap(command: string, args: string[], setup: Awaited<ReturnType<typeof fixture>>, cli: Player['cli'] = 'codex') {
  const wrapped = await sandboxCommand({ command, args, env: setup.env }, setup.workdir, player(cli));
  cleanups.push(wrapped.cleanup);
  return wrapped;
}

describe('filesystem sandbox', () => {
  it('redacts cloned credential values without returning those values or changing their files', async () => {
    const setup = await fixture(); const source = join(setup.hostHome, '.codex');
    await fs.mkdir(source);
    const value = { tokens: { access_token: 'synthetic-access-fixture', refresh_token: 'synthetic-refresh-fixture' } };
    await fs.writeFile(join(source, 'auth.json'), JSON.stringify(value));
    const wrapped = await wrap('/usr/bin/node', ['--version'], setup);
    expect(wrapped.redact('synthetic-access-fixture / synthetic-refresh-fixture')).toBe('[REDACTED] / [REDACTED]');
    expect(JSON.parse(await fs.readFile(join(wrapped.env.CODEX_HOME!, 'auth.json'), 'utf8'))).toEqual(value);
    expect(Object.keys(wrapped)).not.toContain('secrets');
  });
  it('reads and writes only its own workdir, with a fresh PID namespace and tmpfs', async () => {
    const setup = await fixture();
    const secret = join(setup.root, 'sibling-secret');
    const repository = fileURLToPath(new URL('../../../package.json', import.meta.url));
    await fs.writeFile(secret, 'private-fixture');
    await fs.writeFile(join(setup.workdir, 'own.txt'), 'own-fixture');
    await fs.symlink(secret, join(setup.workdir, 'escape'));
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const [workdir, secret, repository, hostPid] = process.argv.slice(1);
      const readable = file => { try { fs.readFileSync(file); return true; } catch { return false; } };
      fs.writeFileSync(path.join(workdir, 'written.txt'), 'sandbox-write');
      fs.writeFileSync('/tmp/sandbox-temp', 'sandbox-temp');
      console.log(JSON.stringify({
        own: fs.readFileSync(path.join(workdir, 'own.txt'), 'utf8'),
        secret: readable(secret), repository: readable(repository), escape: readable(path.join(workdir, 'escape')),
        hostProcess: readable('/proc/' + hostPid + '/environ'), cwd: process.cwd(), home: process.env.HOME,
        temp: fs.existsSync('/tmp/sandbox-temp'), pid: process.pid
      }));
    `;
    const wrapped = await wrap('/usr/bin/node', ['-e', script, setup.workdir, secret, repository, String(process.pid)], setup);
    const { stdout } = await execute(wrapped.command, wrapped.args, { env: wrapped.env, cwd: setup.workdir, timeout: 20000 });
    expect(JSON.parse(stdout)).toEqual({ own: 'own-fixture', secret: false, repository: false, escape: false,
      hostProcess: false, cwd: setup.workdir, home: join(setup.workdir, '.home'), temp: true, pid: 2 });
    expect(await fs.readFile(join(setup.workdir, 'written.txt'), 'utf8')).toBe('sandbox-write');
    expect(wrapped.args).toContain('--unshare-pid');
    expect(wrapped.args).not.toContain('--unshare-net');
    const sources = wrapped.args.flatMap((arg, index) => ['--bind', '--ro-bind'].includes(arg) ? [wrapped.args[index + 1]] : []);
    for (const forbidden of ['/', '/home', setup.hostHome, dirname(repository), '/run', '/tmp']) expect(sources).not.toContain(forbidden);
  });

  it('keeps local MCP network access and preserves filtered provider environment without adding keys to arguments', async () => {
    const setup = await fixture();
    const server = createServer((_request, response) => response.end('offline-mcp-fixture'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Missing fixture listener');
      const url = `http://127.0.0.1:${address.port}`;
      const env = { ...setup.env, OPENAI_API_KEY: 'provider-fixture', MCP_TOOL_TIMEOUT: '660000' };
      const script = `fetch(process.argv[1]).then(async r => console.log(JSON.stringify({ response: await r.text(),
        provider: Boolean(process.env.OPENAI_API_KEY), timeout: process.env.MCP_TOOL_TIMEOUT })));`;
      const wrapped = await sandboxCommand({ command: '/usr/bin/node', args: ['-e', script, url], env }, setup.workdir, player('codex'));
      cleanups.push(wrapped.cleanup);
      expect(wrapped.env.OPENAI_API_KEY).toBe(env.OPENAI_API_KEY);
      expect(wrapped.args.join(' ')).not.toContain(env.OPENAI_API_KEY);
      const { stdout } = await execute(wrapped.command, wrapped.args, { env: wrapped.env, timeout: 20000 });
      expect(JSON.parse(stdout)).toEqual({ response: 'offline-mcp-fixture', provider: true, timeout: '660000' });
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  for (const cli of ['codex', 'claude', 'pi'] as const) it(`clones only ${cli} credentials with private permissions and cleans up the home`, async () => {
    const setup = await fixture();
    const config = cli === 'codex' ? '.codex' : cli === 'claude' ? '.claude' : '.pi/agent';
    const filenames = cli === 'codex' ? ['auth.json'] : cli === 'claude' ? ['.credentials.json'] : ['auth.json', 'models.json'];
    const source = join(setup.hostHome, config);
    await fs.mkdir(join(source, 'extensions'), { recursive: true });
    for (const filename of [...filenames, 'settings.json', 'AGENTS.md', 'CLAUDE.md', 'config.toml']) {
      await fs.writeFile(join(source, filename), JSON.stringify({ fixture: filename }), { mode: 0o644 });
    }
    const wrapped = await wrap('/usr/bin/node', ['--version'], setup, cli);
    const home = join(setup.workdir, '.home');
    const destination = join(home, config);
    expect(wrapped.env.HOME).toBe(home);
    expect(wrapped.env.CODEX_HOME).toBe(join(home, '.codex'));
    expect(wrapped.env.PI_CODING_AGENT_DIR).toBe(join(home, '.pi', 'agent'));
    expect(wrapped.env.CLAUDE_CONFIG_DIR).toBe(join(home, '.claude'));
    expect((await fs.stat(home)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o700);
    expect((await fs.readdir(destination)).sort()).toEqual([...filenames].sort());
    for (const filename of filenames) {
      expect((await fs.stat(join(destination, filename))).mode & 0o777).toBe(0o600);
      const [original, cloned] = await Promise.all([fs.readFile(join(source, filename)), fs.readFile(join(destination, filename))]);
      expect(cloned.equals(original)).toBe(true);
    }
    await wrapped.cleanup();
    await wrapped.cleanup();
    await expect(fs.access(home)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.access(join(source, filenames[0]!));
  });

  it('resolves a PATH symlink to the real executable', async () => {
    const setup = await fixture();
    const bin = join(setup.root, 'bin');
    await fs.mkdir(bin);
    await fs.symlink('/usr/bin/node', join(bin, 'fixture-node'));
    setup.env.PATH = bin;
    const wrapped = await wrap('fixture-node', ['--version'], setup);
    expect(wrapped.args.slice(wrapped.args.indexOf('--') + 1)).toEqual([await fs.realpath('/usr/bin/node'), '--version']);
    const { stdout } = await execute(wrapped.command, wrapped.args, { env: wrapped.env, timeout: 20000 });
    expect(stdout.trim()).toMatch(/^v\d+\./);
  });

  it('resolves pnpm shims and external dependency trees without exposing their parents', async () => {
    const setup = await fixture();
    const modules = join(setup.root, 'store', 'tool', 'node_modules');
    const target = join(modules, 'fixture-tool', 'cli.js');
    const dependency = join(setup.root, 'store', 'dependency', 'node_modules', 'fixture-dependency');
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(join(dependency, 'index.js'), `module.exports = 'fixture-dependency';`);
    await fs.symlink(dependency, join(modules, 'fixture-dependency'));
    const secret = join(setup.root, 'store', 'private-secret');
    await fs.writeFile(secret, 'private-fixture');
    await fs.writeFile(target, `#!/usr/bin/env node\nconsole.log(JSON.stringify({dependency: require('fixture-dependency'),
      secret: require('node:fs').existsSync(process.argv[2])}));\n`, { mode: 0o755 });
    const shim = join(setup.root, 'pi');
    await fs.writeFile(shim, `#!/bin/sh\n# cmd-shim-target=${target}\nexec node "${target}" "$@"\n`, { mode: 0o755 });
    const wrapped = await wrap(shim, [secret], setup, 'pi');
    expect(wrapped.args.slice(wrapped.args.indexOf('--') + 1)).toEqual([target, secret]);
    const { stdout } = await execute(wrapped.command, wrapped.args, { env: wrapped.env, timeout: 20000 });
    expect(JSON.parse(stdout)).toEqual({ dependency: 'fixture-dependency', secret: false });
  });

  it('fails closed when a dependency symlink escapes node_modules', async () => {
    const setup = await fixture();
    const modules = join(setup.root, 'node_modules');
    await fs.mkdir(modules);
    const script = join(modules, 'fixture.js');
    await fs.writeFile(script, '#!/usr/bin/node\n', { mode: 0o755 });
    await fs.symlink(setup.hostHome, join(modules, 'escape'));
    await expect(sandboxCommand({ command: script, args: [], env: setup.env }, setup.workdir, player('pi'))).rejects.toThrow('Unable to resolve an isolated CLI runtime');
    await expect(fs.access(join(setup.workdir, '.home'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on unsupported platforms, unavailable commands, and unsafe workdirs', async () => {
    const setup = await fixture();
    const command = { command: '/usr/bin/node', args: ['--version'], env: setup.env };
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    await expect(sandboxCommand(command, setup.workdir, player('codex'))).rejects.toThrow('requires Linux and bubblewrap');
    vi.unstubAllGlobals();
    await expect(sandboxCommand({ ...command, command: '/not-an-installed-cli' }, setup.workdir, player('codex'))).rejects.toThrow('Unable to resolve an isolated CLI runtime');
    for (const workdir of ['/', '/home', '/tmp', '/run', setup.hostHome, fileURLToPath(new URL('../../../', import.meta.url))]) {
      await expect(sandboxCommand(command, workdir, player('codex'))).rejects.toThrow('isolated directory');
    }
  });

  it('fails closed when bubblewrap is missing even if the CLI is executable', async () => {
    const setup = await fixture();
    availability.missingBubblewrap = true;
    await expect(sandboxCommand({ command: '/usr/bin/node', args: ['--version'], env: setup.env }, setup.workdir, player('codex'))).rejects.toThrow('bubblewrap is required');
  });

  it('reuses a private home across resumes without overwriting session files or refreshing credentials', async () => {
    const setup = await fixture();
    const source = join(setup.hostHome, '.codex');
    await fs.mkdir(source);
    await fs.writeFile(join(source, 'auth.json'), 'fixture-auth');
    const first = await wrap('/usr/bin/node', ['--version'], setup);
    const session = join(first.env.CODEX_HOME!, 'session.json');
    await fs.writeFile(session, 'fixture-session');
    await fs.unlink(join(first.env.CODEX_HOME!, 'auth.json'));
    await fs.symlink(join(setup.root, 'outside-auth'), join(first.env.CODEX_HOME!, 'auth.json'));
    const resumed = await wrap('/usr/bin/node', ['--version'], setup);
    expect(resumed.env.HOME).toBe(first.env.HOME);
    expect(await fs.readFile(session, 'utf8')).toBe('fixture-session');
    await expect(fs.access(join(setup.root, 'outside-auth'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.lstat(join(first.env.CODEX_HOME!, 'auth.json'))).isSymbolicLink()).toBe(true);
  });

  it('does not follow preexisting private-home or credential symlinks and removes partial setup', async () => {
    const setup = await fixture();
    const command = { command: '/usr/bin/node', args: ['--version'], env: setup.env };
    const home = join(setup.workdir, '.home');
    await fs.symlink(setup.hostHome, home);
    await expect(sandboxCommand(command, setup.workdir, player('codex'))).rejects.toThrow('Unable to prepare private sandbox home');
    await fs.access(setup.hostHome);
    await fs.unlink(home);
    const source = join(setup.hostHome, '.codex');
    await fs.mkdir(source);
    await fs.symlink(join(setup.root, 'outside-auth'), join(source, 'auth.json'));
    await expect(sandboxCommand(command, setup.workdir, player('codex'))).rejects.toThrow('Unable to prepare private sandbox home');
    await expect(fs.access(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not touch an external directory planted in a resumed private home', async () => {
    const setup = await fixture();
    const first = await wrap('/usr/bin/node', ['--version'], setup);
    await fs.rm(first.env.CODEX_HOME!, { recursive: true });
    const outside = join(setup.root, 'missing-outside-directory');
    await fs.symlink(outside, first.env.CODEX_HOME!);
    const resumed = await wrap('/usr/bin/node', ['--version'], setup);
    expect(resumed.env.CODEX_HOME).toBe(first.env.CODEX_HOME);
    await expect(fs.access(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    await resumed.cleanup();
    await expect(fs.access(join(setup.workdir, '.home'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  for (const cli of ['codex', 'claude', 'pi'] as const) it(`runs installed ${cli} --version without credentials or model calls`, async () => {
    const setup = await fixture();
    const wrapped = await sandboxCommand({ command: cli, args: ['--version'], env: setup.env }, setup.workdir, player(cli), { cloneCredentials: false });
    cleanups.push(wrapped.cleanup);
    const { stdout } = await execute(wrapped.command, wrapped.args, { env: wrapped.env, cwd: setup.workdir, timeout: 30000 });
    expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    console.info(`${cli} sandbox version: ${stdout.trim()}`);
  }, 40000);

  for (const cli of ['codex', 'claude', 'pi'] as const) for (const resume of [false, true]) {
    it(`accepts installed ${cli} ${resume ? 'resume' : 'initial'} command syntax offline`, async () => {
      const setup = await fixture();
      const rosterPlayer = ROSTER.find(player => player.cli === cli)!;
      const command = agentCommand(rosterPlayer, 'http://127.0.0.1:1/mcp', setup.workdir, 'Offline syntax fixture',
        '00000000-0000-4000-8000-000000000001', resume);
      const args = [...command.args, ...(cli === 'pi' ? ['--offline'] : []), '--help'];
      const wrapped = await sandboxCommand({ ...command, args, env: setup.env }, setup.workdir, rosterPlayer, { cloneCredentials: false });
      cleanups.push(wrapped.cleanup);
      const { stdout, stderr } = await execute(wrapped.command, wrapped.args, { env: wrapped.env, cwd: setup.workdir, timeout: 30000 });
      expect(`${stdout}\n${stderr}`).toMatch(/Usage:|Options:/i);
      expect(`${stdout}\n${stderr}`).not.toMatch(/unknown (?:argument|option|flag)|unexpected argument|unrecognized (?:argument|option|flag)/i);
      console.info(`${cli} ${resume ? 'resume' : 'initial'} sandbox help: accepted`);
    }, 40000);
  }
});
