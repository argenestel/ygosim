import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AGY_AUTH_KEYS, agyMcpConfig, agyMcpConfigPath } from './agy.js';
import type { Player } from './types.js';

const execFileAsync = promisify(execFile);

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function ensurePrivateDirectory(path: string, root: string): Promise<void> {
  const distance = relative(root, path);
  if (distance === '..' || distance.startsWith('../') || isAbsolute(distance)) throw new Error('Private path escapes sandbox home');
  let current = root;
  for (const part of distance.split('/').filter(Boolean)) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700, recursive: true });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || await realpath(current) !== current) {
      throw new Error('Unsafe private directory');
    }
    await chmod(current, 0o700);
  }
}

async function cloneAgyAuth(source: string, destination: string, home: string): Promise<void> {
  const sourceInfo = await optionalStat(source);
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.uid !== process.getuid!() || sourceInfo.nlink !== 1) {
    throw new Error('Antigravity auth database is not a regular file');
  }
  await ensurePrivateDirectory(dirname(destination), home);
  const keys = AGY_AUTH_KEYS.map(sqlString).join(', ');
  const sql = [
    'PRAGMA journal_mode=DELETE;',
    'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);',
    `ATTACH ${sqlString(source)} AS host;`,
    `INSERT INTO main.ItemTable(key, value) SELECT key, value FROM host.ItemTable WHERE key IN (${keys});`,
    'DETACH host;',
  ].join(' ');
  await execFileAsync('sqlite3', [destination, sql], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  await chmod(destination, 0o600);
  const destinationInfo = await lstat(destination);
  if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink() || destinationInfo.nlink !== 1 || destinationInfo.uid !== process.getuid!()) {
    throw new Error('Antigravity auth clone is unsafe');
  }
}

async function agyAuthSecrets(database: string): Promise<string[]> {
  try {
    const keys = AGY_AUTH_KEYS.map(sqlString).join(', ');
    const { stdout } = await execFileAsync('sqlite3', ['-json', database,
      `SELECT value FROM ItemTable WHERE key IN (${keys});`], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      maxBuffer: 256 * 1024,
      timeout: 5_000,
    });
    const rows: unknown = JSON.parse(String(stdout));
    const secrets = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === 'string') {
        if (value) secrets.add(value);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const entry of Object.values(value)) collect(entry);
    };
    collect(rows);
    return [...secrets];
  } catch {
    // Redaction remains covered by YGOSIM_MCP_TOKEN in the runner.  A
    // malformed optional auth database must not make normal output unsafe.
    return [];
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid!()) throw new Error('Unsafe private file');
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(value));
  } finally {
    await file.close();
  }
}

async function writePrivateText(path: string, value: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid!()) throw new Error('Unsafe private file');
    await file.chmod(0o600);
    await file.writeFile(value);
  } finally {
    await file.close();
  }
}

function jsonStrings(value: unknown): string[] {
  const strings = new Set<string>();
  const collect = (entry: unknown) => {
    if (typeof entry === 'string') {
      if (entry) strings.add(entry);
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    for (const child of Object.values(entry)) collect(child);
  };
  collect(value);
  return [...strings];
}

async function cloneAgyToken(hostHome: string, home: string): Promise<string[]> {
  const source = join(hostHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  const sourceInfo = await optionalStat(source);
  let contents: string;
  if (sourceInfo) {
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.uid !== process.getuid!() || sourceInfo.nlink !== 1 || (sourceInfo.mode & 0o077) !== 0) {
      throw new Error('Antigravity token file is not a regular file');
    }
    contents = (await readFile(source, 'utf8')).trim();
  } else {
    const env = {
      PATH: '/usr/bin:/bin', LANG: 'C',
      ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
      ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
    };
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity'], {
      env, maxBuffer: 256 * 1024, timeout: 5_000,
    });
    contents = String(stdout).trim();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(contents); } catch { throw new Error('Antigravity token file is not valid JSON'); }
  const token = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).token : undefined;
  if (!token || typeof token !== 'object' || typeof (token as Record<string, unknown>).access_token !== 'string'
    || typeof (token as Record<string, unknown>).refresh_token !== 'string') {
    throw new Error('Antigravity token file has an unexpected shape');
  }
  const destination = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  await ensurePrivateDirectory(dirname(destination), home);
  await writePrivateText(destination, contents);
  return jsonStrings(parsed);
}

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
  if (command.env.YGOSIM_MCP_TOKEN) {
    secrets.add(command.env.YGOSIM_MCP_TOKEN);
    secrets.add(`Bearer ${command.env.YGOSIM_MCP_TOKEN}`);
  }
  try {
    const existing = await optionalStat(home);
    if (existing) {
      if (!existing.isDirectory() || (existing.mode & 0o077) !== 0 || existing.uid !== process.getuid!() || await realpath(home) !== home) throw new Error();
    } else {
      await mkdir(home, { mode: 0o700 });
      created = true;
      if (player.cli === 'agy') {
        const source = join(hostHome, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        const destination = join(env.XDG_CONFIG_HOME!, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        if (options.cloneCredentials !== false) {
          if (await optionalStat(source)) await cloneAgyAuth(source, destination, home);
          for (const secret of await cloneAgyToken(hostHome, home)) secrets.add(secret);
        }
      } else {
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
    }
    if (player.cli === 'agy' && command.env.AGY_MCP_URL) {
      const configPath = agyMcpConfigPath(home);
      await ensurePrivateDirectory(dirname(configPath), home);
      const token = command.env.YGOSIM_MCP_TOKEN;
      await writePrivateJson(configPath, agyMcpConfig(command.env.AGY_MCP_URL, token ? `Bearer ${token}` : undefined));
      for (const secret of await agyAuthSecrets(join(env.XDG_CONFIG_HOME!, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'))) {
        secrets.add(secret);
      }
      const tokenPath = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
      if ((await optionalStat(tokenPath))?.isFile()) {
        try {
          for (const secret of jsonStrings(JSON.parse(await readFile(tokenPath, 'utf8')))) secrets.add(secret);
        } catch { /* cloneAgyToken validates fresh credentials; resumed homes are redacted best-effort. */ }
      }
    }
    const destination = player.cli === 'codex' ? env.CODEX_HOME : player.cli === 'claude' ? env.CLAUDE_CONFIG_DIR : env.PI_CODING_AGENT_DIR;
    const filenames = player.cli === 'codex' ? ['auth.json'] : player.cli === 'claude' ? ['.credentials.json'] : player.cli === 'pi' ? ['auth.json', 'models.json'] : [];
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
