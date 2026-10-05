import { constants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Player } from './types.js';

function within(root: string, path: string): boolean {
  const distance = relative(root, path);
  return distance === '' || (distance !== '..' && !distance.startsWith('../') && !isAbsolute(distance));
}

async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

async function executable(command: string, path: string | undefined, workdir: string): Promise<string> {
  const candidates = command.includes('/')
    ? [resolve(workdir, command)]
    : (path ?? '/usr/bin:/bin').split(':').map(directory => resolve(workdir, directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const target = await realpath(candidate);
      if ((await stat(target)).isFile()) return target;
    } catch {}
  }
  throw new Error('Sandbox executable is unavailable');
}

function moduleRoot(path: string): string | undefined {
  for (let directory = path; directory !== dirname(directory); directory = dirname(directory)) {
    if (basename(directory) === 'node_modules') return directory;
  }
  return undefined;
}

async function runtimeTrees(entry: string): Promise<string[]> {
  const first = moduleRoot(entry);
  if (!first) return [];
  const roots = new Set([first]);
  for (const root of roots) {
    const pending = [root];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        if (!entry.isSymbolicLink()) continue;
        const target = await realpath(path);
        if (within(root, target) || within('/usr', target)) continue;
        const dependencyRoot = moduleRoot(target);
        if (!dependencyRoot) throw new Error('CLI dependency escapes its runtime tree');
        roots.add(dependencyRoot);
      }
    }
  }
  return [...roots].filter(root => ![...roots].some(other => other !== root && within(other, root)));
}

export async function sandboxCommand(
  command: { command: string; args: string[]; env: NodeJS.ProcessEnv },
  workdir: string,
  player: Player,
  options: { cloneCredentials?: boolean } = {},
): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv; redact(text: string): string; cleanup(): Promise<void> }> {
  if (process.platform !== 'linux') throw new Error('Filesystem sandbox requires Linux and bubblewrap');
  const directory = resolve(workdir);
  const hostHome = command.env.HOME ?? homedir();
  const protectedPaths = ['/usr', '/etc', '/lib', '/lib64', '/bin', '/sbin', '/proc', '/dev', '/tmp', '/run', hostHome,
    dirname(fileURLToPath(import.meta.url))];
  if (protectedPaths.some(path => within(directory, resolve(path)))) throw new Error('Sandbox workdir must be an isolated directory');

  let wrapper: string;
  let entry: string;
  let trees: string[];
  const args = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
    '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
  try {
    if (await realpath(directory) !== directory || !(await stat(directory)).isDirectory()) throw new Error();
    wrapper = await executable('bwrap', '/usr/bin:/bin', directory);
    entry = await executable(command.command, command.env.PATH, directory);
    const file = await open(entry, 'r');
    let header: string;
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      header = buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
    const shimTarget = header.match(/^# cmd-shim-target=(.+)$/m)?.[1];
    if (shimTarget !== undefined) {
      if (!isAbsolute(shimTarget) || !moduleRoot(shimTarget)) throw new Error();
      entry = await executable(shimTarget, command.env.PATH, directory);
    }
    trees = await runtimeTrees(entry);
    for (const path of ['/lib', '/lib64', '/bin', '/sbin']) {
      const info = await optionalStat(path);
      if (!info) continue;
      if (info.isSymbolicLink()) args.push('--symlink', await readlink(path), path);
      else args.push('--ro-bind', path, path);
    }
    for (const path of ['/etc/ld.so.cache', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl/certs',
      '/etc/ssl/cert.pem', '/etc/ca-certificates/extracted/cadir', '/etc/ca-certificates/extracted/tls-ca-bundle.pem',
      '/etc/pki/tls/certs', '/etc/pki/ca-trust/extracted/pem']) {
      if (await optionalStat(path)) args.push('--ro-bind', await realpath(path), path);
    }
    for (const tree of trees) if (!within('/usr', tree) && !within(directory, tree)) args.push('--ro-bind', tree, tree);
    if (!within('/usr', entry) && !within(directory, entry) && !trees.some(tree => within(tree, entry))) {
      args.push('--ro-bind', entry, entry);
    }
    const support = join(dirname(entry), 'codex-code-mode-host');
    if (player.cli === 'codex' && basename(entry) === 'codex' && (await optionalStat(support))?.isFile()) {
      args.push('--ro-bind', support, support);
    }
  } catch { throw new Error('Unable to resolve an isolated CLI runtime; Linux bubblewrap is required'); }

  const home = join(directory, '.home');
  const env = { ...command.env, HOME: home, CODEX_HOME: join(home, '.codex'), PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'), TMPDIR: '/tmp', PWD: directory };
  let created = false;
  const secrets = new Set<string>();
  try {
    const existing = await optionalStat(home);
    if (existing) {
      if (!existing.isDirectory() || (existing.mode & 0o077) !== 0 || existing.uid !== process.getuid!() || await realpath(home) !== home) throw new Error();
    } else {
      await mkdir(home, { mode: 0o700 });
      created = true;
      const source = player.cli === 'codex' ? command.env.CODEX_HOME ?? join(hostHome, '.codex')
        : player.cli === 'claude' ? command.env.CLAUDE_CONFIG_DIR ?? join(hostHome, '.claude')
        : command.env.PI_CODING_AGENT_DIR ?? join(hostHome, '.pi', 'agent');
      const destination = player.cli === 'codex' ? env.CODEX_HOME : player.cli === 'claude' ? env.CLAUDE_CONFIG_DIR : env.PI_CODING_AGENT_DIR;
      await mkdir(destination, { recursive: true, mode: 0o700 });
      if (options.cloneCredentials !== false) {
        const filenames = player.cli === 'codex' ? ['auth.json'] : player.cli === 'claude' ? ['.credentials.json'] : ['auth.json', 'models.json'];
        for (const filename of filenames) {
          const sourceFile = join(source, filename);
          const info = await optionalStat(sourceFile);
          if (!info) continue;
          if (!info.isFile()) throw new Error();
          const destinationFile = join(destination, filename);
          await copyFile(sourceFile, destinationFile, constants.COPYFILE_EXCL);
          await chmod(destinationFile, 0o600);
        }
      }
    }
    const destination = player.cli === 'codex' ? env.CODEX_HOME : player.cli === 'claude' ? env.CLAUDE_CONFIG_DIR : env.PI_CODING_AGENT_DIR;
    const filenames = player.cli === 'codex' ? ['auth.json'] : player.cli === 'claude' ? ['.credentials.json'] : ['auth.json', 'models.json'];
    const collect = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string' && /key|token|secret|password|authorization|^(access|refresh)$/i.test(key) && entry) {
          secrets.add(entry); secrets.add(entry.replace(/^Bearer\s+/i, ''));
          secrets.add(JSON.stringify(entry).slice(1, -1));
        } else collect(entry);
      }
    };
    for (const filename of filenames) {
      const path = join(destination, filename);
      if (!(await optionalStat(path))?.isFile()) continue;
      const contents = await readFile(path, 'utf8');
      try { collect(JSON.parse(contents)); }
      catch { if (contents.trim()) { secrets.add(contents); secrets.add(contents.trim()); } }
    }
  } catch {
    if (created) await rm(home, { recursive: true, force: true });
    throw new Error('Unable to prepare private sandbox home');
  }

  args.push('--bind', directory, directory, '--chdir', directory, '--', entry, ...command.args);
  return {
    command: wrapper, args, env,
    redact(text) {
      for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[REDACTED]');
      return text;
    },
    async cleanup() {
      try { await rm(home, { recursive: true, force: true }); }
      catch { throw new Error('Unable to remove private sandbox home'); }
    },
  };
}
