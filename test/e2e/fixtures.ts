import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DuelEvent } from '../../packages/protocol/src/index';

type Running = { child: ChildProcess; port: number; logs: string[] };
async function launch(entry: string, env: Record<string, string>): Promise<Running> {
  const args = entry.endsWith('.ts')
    ? ['--import', resolve('packages/server/node_modules/tsx/dist/loader.mjs'), resolve(entry)]
    : [resolve(entry)];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  try {
    const port = await new Promise<number>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`Startup timeout: ${entry}`)), 30_000);
      const onExit = (code: number | null) => { clearTimeout(timer); fail(new Error(`${entry} exited ${code}`)); };
      child.once('error', error => { clearTimeout(timer); fail(error); });
      child.once('exit', onExit);
      child.stdout!.on('data', chunk => {
        const text = String(chunk); logs.push(text);
        const match = text.match(/E2E_READY (\d+)/);
        if (match) { clearTimeout(timer); child.off('exit', onExit); ok(Number(match[1])); }
      });
      child.stderr!.on('data', chunk => logs.push(String(chunk)));
    });
    return { child, port, logs };
  } catch (error) {
    await stop(child);
    throw new Error(`${entry} startup failed; captured output:\n${logs.join('')}`, { cause: error });
  }
}
async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(done => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    child.kill('SIGTERM');
  });
}

export const test = base.extend<{ scenario: string; appURL: string; diagnostics: void; duelEvents: DuelEvent[]; processControl: { disconnect: () => Promise<void> }; disconnectServer: () => Promise<void> }>({
  scenario: ['natural', { option: true }],
  duelEvents: async ({}, use) => { await use([]); },
  processControl: async ({}, use) => { await use({ disconnect: async () => { throw new Error('Server not started'); } }); },
  disconnectServer: async ({ appURL, processControl }, use) => { expect(appURL).toBeTruthy(); await use(processControl.disconnect); },
  appURL: async ({ scenario, processControl, page }, use, info) => {
    let server: Running | undefined, frontend: Running | undefined;
    try {
      server = await launch('test/e2e/server.ts', { E2E_SCENARIO: scenario, YGOSIM_ALLOW_AGENT_LAUNCH: '0' });
      const child = server.child;
      processControl.disconnect = () => stop(child);
      frontend = await launch('test/e2e/frontend.mjs', { E2E_SERVER_PORT: String(server.port), E2E_LOW_GRAPHICS: scenario === 'natural' ? '1' : '0', E2E_SCENARIO: scenario });
      await expect.poll(async () => fetch(`http://127.0.0.1:${server!.port}/api/health`).then(r => r.json()), { timeout: 30_000 })
        .toEqual(expect.objectContaining({ ok: true, db: true }));
      await use(`http://127.0.0.1:${frontend.port}`);
    } finally {
      if (info.status !== info.expectedStatus && !page.isClosed()) {
        const path = info.outputPath('failure-before-shutdown.png');
        await page.screenshot({ path }).catch(() => {});
        await info.attach('failure-before-shutdown', { path, contentType: 'image/png' }).catch(() => {});
      }
      if (frontend) await stop(frontend.child);
      if (server) await stop(server.child);
      for (const [name, process] of [['server', server], ['frontend', frontend]] as const) {
        if (!process) continue;
        const path = info.outputPath(`${name}.log`);
        await writeFile(path, process.logs.join(''));
        await info.attach(name, { path, contentType: 'text/plain' });
      }
      if (server) expect(server.logs.join('')).not.toMatch(/\[room [^\]]+\]|\[(?:server|ocgcore)\].*(?:invalid|failed|abort|error|stall)/i);
    }
  },
  diagnostics: [async ({ page, duelEvents, scenario }, use, info) => {
    const errors: string[] = [], consoleLines: string[] = [], messages: unknown[] = [], actions: unknown[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => {
      consoleLines.push(`${msg.type()}: ${msg.text()}`);
      if (msg.type() === 'error' && !/^Failed to load resource:/.test(msg.text())) errors.push(msg.text());
    });
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 400 && !path.startsWith('/api/img/') && path !== '/favicon.ico') errors.push(`HTTP ${response.status()} ${path}`);
    });
    page.on('requestfailed', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/') && !path.startsWith('/api/img/')) errors.push(`Request failed ${path}: ${request.failure()?.errorText}`);
    });
    page.on('websocket', socket => {
      if (new URL(socket.url()).pathname !== '/ws') return;
      socket.on('framesent', frame => {
        const msg = JSON.parse(String(frame.payload));
        if (['action', 'surrender', 'side_deck'].includes(msg.type)) actions.push(msg);
      });
      socket.on('framereceived', frame => {
        try {
          const msg = JSON.parse(String(frame.payload));
          messages.push(msg);
          if (msg.type === 'events') duelEvents.push(...msg.events);
          if (msg.type === 'error') errors.push(msg.message);
        } catch { errors.push('Malformed server WebSocket frame'); }
      });
    });
    await use();
    if (!page.isClosed()) {
      const lowGraphics = await page.evaluate(() => (window as any).__ygosimBoard?.lowGraphics).catch(() => undefined);
      if (lowGraphics !== undefined) expect(lowGraphics, 'Actual rendered graphics mode').toBe(scenario === 'natural');
    }
    await info.attach('console', { body: consoleLines.join('\n'), contentType: 'text/plain' });
    await info.attach('server-messages', { body: JSON.stringify(messages, null, 2), contentType: 'application/json' });
    await info.attach('client-actions', { body: JSON.stringify(actions, null, 2), contentType: 'application/json' });
    expect(errors, 'Unexpected browser/server errors').toEqual([]);
  }, { auto: true }],
});
export { expect };
