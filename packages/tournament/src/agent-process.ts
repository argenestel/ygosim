import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Player } from './types.js';
import { CONTINUE_PROMPT } from './agent-prompt.js';
import { sandboxCommand } from './sandbox.js';

export interface AgentCommand { command: string; args: string[]; env: NodeJS.ProcessEnv }
export function agentCommand(player: Player, url: string, workdir: string, prompt: string, sessionId: string, resume: boolean, authorization?: string, customDecks = false): AgentCommand {
  const keys = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  keys.push(...(player.cli === 'codex' ? ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] : player.cli === 'claude'
    ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']
    : player.model.startsWith('fireworks/') ? ['FIREWORKS_API_KEY'] : player.model.startsWith('openai-codex/') ? [] : ['XAI_API_KEY']));
  const env: NodeJS.ProcessEnv = Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  if (authorization) env.YGOSIM_MCP_TOKEN = authorization.replace(/^Bearer /, '');
  if (player.cli === 'codex') {
    const settings = ['-c', `model_reasoning_effort=${JSON.stringify(player.effort ?? 'medium')}`, '-c', 'developer_instructions=""',
      '-c', `mcp_servers.ygosim.url=${JSON.stringify(url)}`, '-c', 'mcp_servers.ygosim.tool_timeout_sec=660',
      '-c', 'mcp_servers.ygosim.bearer_token_env_var="YGOSIM_MCP_TOKEN"', '-c', 'web_search="disabled"',
      ...['shell_tool', 'code_mode_host', 'code_mode', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'hooks', 'plugins', 'skill_search'].flatMap(feature => ['--disable', feature])];
    const args = resume && sessionId
      ? ['exec', 'resume', sessionId, '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-c', 'sandbox_mode="read-only"', '-m', player.model, ...settings, prompt]
      : ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '-m', player.model, ...settings, prompt];
    return { command: 'codex', args, env };
  }
  if (player.cli === 'pi') return { command: 'pi', args: ['-p', '-a', '--no-builtin-tools', '--no-extensions', '-e', 'builtin:mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--system-prompt', 'Play this tournament using only the ygosim game tools.', '--tools', [...(customDecks ? [] : ['list_decks']), 'card_info', 'enter_match', 'wait_for_turn', 'act', 'get_state', 'surrender'].map(tool => `mcp__ygosim__${tool}`).join(','), '--mode', 'json', ...(player.model.startsWith('openai-codex/') ? ['--provider', 'openai-codex', '--model', player.model.slice('openai-codex/'.length)] : ['--model', player.model]), '--thinking', player.effort ?? 'high', '--session-dir', join(workdir, 'sessions'), ...(resume ? ['--continue'] : []), prompt], env };
  env.MCP_TOOL_TIMEOUT = '660000';
  return { command: 'claude', args: ['-p', '--model', player.model, '--mcp-config', join(workdir, 'claude-mcp.json'), '--strict-mcp-config', '--restricted', '--tools', '', '--setting-sources', '', '--disable-slash-commands', '--allowedTools', 'mcp__ygosim__*', '--output-format', 'stream-json', '--verbose', resume ? '--resume' : '--session-id', sessionId, prompt], env };
}

export function terminateTree(child: ChildProcess): void {
  if (!child.pid) return;
  const signal = (name: NodeJS.Signals) => {
    try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, name); }
    catch { try { child.kill(name); } catch { /* Already gone. */ } }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 3000);
  timer.unref();
}

export async function runAgent(options: {
  player: Player; url: string; gameDir: string; prompt: string; signal: AbortSignal;
  onResume: () => Promise<void>; isEnded: () => boolean;
  authorization?: string;
  onModel?: (model: string) => void;
  onEffort?: (effort: string) => void;
  onRedactor?: (redact: (text: string) => string) => void;
  customDecks?: boolean;
}): Promise<void> {
  const { player, signal, gameDir } = options;
  if (signal.aborted || options.isEnded()) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(player.id)) throw new Error('Invalid agent identifier');
  if (await realpath(gameDir) !== resolve(gameDir)) throw new Error('Agent game directory must not contain symlinks');
  const workdir = join(gameDir, '.workdir', player.id);
  for (const dir of [join(gameDir, '.workdir'), workdir, join(workdir, '.pi'), join(workdir, 'sessions')]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || await realpath(dir) !== resolve(dir)) throw new Error('Unsafe agent workspace path');
    await chmod(dir, 0o700);
  }
  const mcpFile = join(workdir, '.pi', 'mcp.json');
  const claudeFile = join(workdir, 'claude-mcp.json');
  const openPrivateFile = async (path: string, flags: number) => {
    const file = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!()) throw new Error('Unsafe private file');
      await file.chmod(0o600);
      return file;
    } catch (error) { await file.close(); throw error; }
  };
  const writeConfig = async (path: string, value: unknown) => {
    const file = await openPrivateFile(path, constants.O_WRONLY | constants.O_CREAT);
    try {
      await file.truncate(0); await file.writeFile(JSON.stringify(value));
    } finally { await file.close(); }
  };
  const config = { url: options.url, ...(options.authorization ? { headers: { Authorization: options.authorization } } : {}) };
  try {
    await writeConfig(mcpFile, { mcpServers: { ygosim: { ...config, exposure: 'direct' } } });
    await writeConfig(claudeFile, { mcpServers: { ygosim: { ...config, type: 'http' } } });
  } catch {
    await rm(mcpFile, { force: true }); await rm(claudeFile, { force: true });
    throw new Error('Unable to write private MCP configuration safely');
  }
  let transcriptFile: Awaited<ReturnType<typeof open>> | undefined;
  let stderrFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    transcriptFile = await openPrivateFile(join(gameDir, `${player.id}.transcript.jsonl`), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
    stderrFile = await openPrivateFile(join(gameDir, `${player.id}.stderr.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
  } catch {
    await transcriptFile?.close(); await stderrFile?.close();
    await rm(mcpFile, { force: true }); await rm(claudeFile, { force: true });
    throw new Error('Unable to open private agent logs safely');
  }
  const transcript = transcriptFile.createWriteStream();
  const stderr = stderrFile.createWriteStream();
  // Streams stay open across resumes so output is an uninterrupted transcript.
  let streamError: Error | undefined;
  transcript.on('error', error => { streamError = error; });
  stderr.on('error', error => { streamError = error; });
  let sessionId = player.cli === 'claude' ? randomUUID() : '';
  let sandbox: Awaited<ReturnType<typeof sandboxCommand>> | undefined;
  try {
    for (let attempt = 0; attempt <= 6 && !signal.aborted && !options.isEnded(); attempt++) {
      if (attempt) await options.onResume();
      const command = agentCommand(player, options.url, workdir, attempt ? CONTINUE_PROMPT : options.prompt, sessionId, attempt > 0, options.authorization, options.customDecks);
      const isolated = await sandboxCommand(command, workdir, player);
      sandbox = isolated;
      const secrets = Object.entries(command.env).filter(([key, value]) => value && /KEY|TOKEN|PROXY/.test(key)).map(([, value]) => value!);
      const redact = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), isolated.redact ? isolated.redact(text) : text);
      options.onRedactor?.(redact);
      let errorPending = '';
      const exitCode = await new Promise<number | null>(resolve => {
        const child = spawn(isolated.command, isolated.args, { cwd: workdir, env: isolated.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        const abort = () => terminateTree(child);
        signal.addEventListener('abort', abort, { once: true });
        let pending = '';
        child.stdout!.on('data', (chunk: Buffer) => {
          pending += chunk.toString();
          const lines = pending.split('\n'); pending = lines.pop()!;
          for (const line of lines) {
            transcript.write(`${redact(line)}\n`);
            try {
              const event = JSON.parse(line);
              if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
              if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') options.onModel?.(redact(event.model));
              if (event.type === 'model_change' && typeof event.modelId === 'string') options.onModel?.(redact(event.modelId));
              if (event.type === 'message_end' && event.message?.role === 'assistant' && typeof event.message.model === 'string') options.onModel?.(redact(event.message.model));
              if (event.type === 'thinking_level_change' && typeof event.thinkingLevel === 'string') options.onEffort?.(event.thinkingLevel);
            } catch { /* Preserve raw output, including non-JSON diagnostics. */ }
          }
        });
        child.stderr!.on('data', chunk => {
          errorPending += chunk.toString();
          const lines = errorPending.split('\n'); errorPending = lines.pop()!;
          for (const line of lines) stderr.write(`${redact(line)}\n`);
        });
        child.once('error', () => stderr.write('Unable to start isolated agent process\n'));
        // Descendants can keep the pipes open after the direct CLI exits.
        // Kill them on exit so close can arrive and the next resume can start.
        child.once('exit', () => terminateTree(child));
        child.once('close', (code, sig) => {
          if (pending) transcript.write(redact(pending));
          if (errorPending) stderr.write(redact(errorPending));
          stderr.write(`\n[runner] exit code=${code} signal=${sig}\n`);
          signal.removeEventListener('abort', abort);
          // Also terminate descendants left behind by an exited CLI.
          terminateTree(child);
          resolve(code);
        });
        if (signal.aborted) abort();
      });
      if (player.cli === 'pi') {
        for (const entry of (await readdir(join(workdir, 'sessions'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const file = await open(join(workdir, 'sessions', entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
          const input = file.createReadStream();
          const lines = createInterface({ input, crlfDelay: Infinity });
          try {
            for await (const line of lines) {
              let event: any;
              try { event = JSON.parse(line); } catch { continue; }
              if (event.type === 'model_change' && typeof event.provider === 'string' && typeof event.modelId === 'string') options.onModel?.(redact(`${event.provider}/${event.modelId}`));
              if (event.type === 'thinking_level_change' && typeof event.thinkingLevel === 'string') options.onEffort?.(event.thinkingLevel);
            }
          } finally { lines.close(); input.destroy(); await file.close(); }
        }
      }
      if (streamError) throw streamError;
      if (player.cli === 'codex' && !sessionId && !signal.aborted && !options.isEnded()) {
        throw new Error('Codex exited without a thread.started event; no session is available to resume');
      }
      if (exitCode !== 0 && !signal.aborted && !options.isEnded()) throw new Error(`${player.cli} exited unsuccessfully; tournament infrastructure validation required`);
      if (!signal.aborted && !options.isEnded() && attempt < 6) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 1000);
        signal.addEventListener('abort', done, { once: true });
      });
    }
  } finally {
    await sandbox?.cleanup();
    await rm(mcpFile, { force: true });
    await rm(claudeFile, { force: true });
    await Promise.all([new Promise<void>(resolve => transcript.end(resolve)), new Promise<void>(resolve => stderr.end(resolve))]);
  }
}
