import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Player } from './types.js';
import { CONTINUE_PROMPT } from './agent-prompt.js';

export interface AgentCommand { command: string; args: string[]; env: NodeJS.ProcessEnv }
export function agentCommand(player: Player, url: string, workdir: string, prompt: string, sessionId: string, resume: boolean): AgentCommand {
  const env = { ...process.env };
  const config = JSON.stringify({ mcpServers: { ygosim: { type: 'http', url } } });
  if (player.cli === 'codex') {
    const settings = ['-c', `model_reasoning_effort=${JSON.stringify(player.effort ?? 'medium')}`, '-c', 'developer_instructions=""',
      '-c', `mcp_servers.ygosim.url=${JSON.stringify(url)}`, '-c', 'mcp_servers.ygosim.tool_timeout_sec=660'];
    const args = resume && sessionId
      ? ['exec', 'resume', sessionId, '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-m', player.model, ...settings, prompt]
      : ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-m', player.model, ...settings, prompt];
    return { command: 'codex', args, env };
  }
  if (player.cli === 'pi') return { command: 'pi', args: ['-p', '-a', '--mode', 'json', '--model', player.model, '--thinking', player.effort ?? 'high', '--session-dir', join(workdir, 'sessions'), ...(resume ? ['--continue'] : []), prompt], env };
  env.MCP_TOOL_TIMEOUT = '660000';
  return { command: 'claude', args: ['-p', '--model', player.model, '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__ygosim__*', '--output-format', 'stream-json', '--verbose', resume ? '--resume' : '--session-id', sessionId, prompt], env };
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
}): Promise<void> {
  const { player, signal, gameDir } = options;
  const workdir = join(gameDir, '.workdir', player.id);
  await mkdir(join(workdir, '.pi'), { recursive: true });
  await mkdir(join(workdir, 'sessions'), { recursive: true });
  await writeFile(join(workdir, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { ygosim: { url: options.url } } }));
  const transcript = createWriteStream(join(gameDir, `${player.id}.transcript.jsonl`), { flags: 'a' });
  const stderr = createWriteStream(join(gameDir, `${player.id}.stderr.log`), { flags: 'a' });
  // Streams stay open across resumes so output is an uninterrupted transcript.
  let streamError: Error | undefined;
  transcript.on('error', error => { streamError = error; });
  stderr.on('error', error => { streamError = error; });
  let sessionId = player.cli === 'claude' ? randomUUID() : '';
  try {
    for (let attempt = 0; attempt <= 6 && !signal.aborted && !options.isEnded(); attempt++) {
      if (attempt) await options.onResume();
      const command = agentCommand(player, options.url, workdir, attempt ? CONTINUE_PROMPT : options.prompt, sessionId, attempt > 0);
      await new Promise<void>(resolve => {
        const child = spawn(command.command, command.args, { cwd: workdir, env: command.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        const abort = () => terminateTree(child);
        signal.addEventListener('abort', abort, { once: true });
        let pending = '';
        child.stdout!.on('data', (chunk: Buffer) => {
          transcript.write(chunk);
          pending += chunk.toString();
          const lines = pending.split('\n'); pending = lines.pop()!;
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
            } catch { /* Preserve raw output, including non-JSON diagnostics. */ }
          }
        });
        child.stderr!.on('data', chunk => stderr.write(chunk));
        child.once('error', error => stderr.write(`${error.message}\n`));
        // Descendants can keep the pipes open after the direct CLI exits.
        // Kill them on exit so close can arrive and the next resume can start.
        child.once('exit', () => terminateTree(child));
        child.once('close', (code, sig) => {
          stderr.write(`\n[runner] exit code=${code} signal=${sig}\n`);
          signal.removeEventListener('abort', abort);
          // Also terminate descendants left behind by an exited CLI.
          terminateTree(child);
          resolve();
        });
        if (signal.aborted) abort();
      });
      if (streamError) throw streamError;
      if (player.cli === 'codex' && !sessionId && !signal.aborted && !options.isEnded()) {
        throw new Error('Codex exited without a thread.started event; no session is available to resume');
      }
      if (!signal.aborted && !options.isEnded() && attempt < 6) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 1000);
        signal.addEventListener('abort', done, { once: true });
      });
    }
  } finally {
    await Promise.all([new Promise<void>(resolve => transcript.end(resolve)), new Promise<void>(resolve => stderr.end(resolve))]);
  }
}
