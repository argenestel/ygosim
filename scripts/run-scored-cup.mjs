import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  players: { type: 'string' }, name: { type: 'string', default: 'Six-agent Bubble Cup' },
  server: { type: 'string', default: 'ws://localhost:7788' },
  'max-minutes': { type: 'string', default: '90' }, concurrency: { type: 'string', default: '3' },
  seed: { type: 'string', default: '20261006' },
} });
const players = values.players?.split(',').map(id => id.trim());
if (!players || players.length !== 6 || new Set(players).size !== 6 || players.some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) {
  throw new Error('Supply --players with exactly six distinct roster IDs, including the chosen Gemini provider.');
}
const stateDir = join(root, '.omx', 'state');
const logDir = join(root, '.omx', 'logs');
mkdirSync(stateDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const statePath = join(stateDir, `scored-cup-${stamp}.json`);
const logPath = join(logDir, `scored-cup-${stamp}.log`);
const state = { name: values.name, players, phase: 'validation', startedAt: new Date().toISOString(),
  server: values.server, maxMinutes: Number(values['max-minutes']), concurrency: Number(values.concurrency),
  validationId: null, tournamentId: null, logPath };
function persist() {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(`${statePath}.tmp`, statePath);
}
function log(text) {
  appendFileSync(logPath, text, { mode: 0o600 });
  process.stdout.write(text);
}
let child;
let stopped = false;
function stop() { stopped = true; child?.kill('SIGTERM'); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const common = ['--players', players.join(','), '--server', values.server, '--max-minutes', values['max-minutes'],
  '--concurrency', values.concurrency, '--seed', values.seed];
async function launch(phase, extra) {
  state.phase = phase;
  persist();
  log(`Starting ${phase}; state: ${statePath}\n`);
  let partial = '';
  const args = ['--import', join(root, 'packages/tournament/node_modules/tsx/dist/loader.mjs'),
    join(root, 'packages/tournament/src/index.ts'), ...common, ...extra];
  const code = await new Promise((done, reject) => {
    child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      log(text);
      partial += text;
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        const match = line.match(/^Tournament ([a-zA-Z0-9_-]+):/);
        if (match) {
          state[phase === 'validation' ? 'validationId' : 'tournamentId'] = match[1];
          persist();
        }
      }
    });
    child.stderr.on('data', chunk => log(String(chunk)));
    child.once('error', reject);
    child.once('close', done);
  });
  child = undefined;
  if (stopped || code !== 0) throw new Error(`${phase} stopped with exit code ${code}; scoring will not proceed without passing validation.`);
}
try {
  await launch('validation', ['--validate', '--games', '3', '--name', `${values.name} readiness`]);
  const tournamentRoot = process.env.YGOSIM_TOURNAMENT_DIR ? resolve(process.env.YGOSIM_TOURNAMENT_DIR) : join(root, 'data/tournaments');
  const validation = JSON.parse(readFileSync(join(tournamentRoot, state.validationId, 'tournament.json'), 'utf8'));
  if (validation.scored !== false || !validation.validation?.passed) throw new Error('Roster validation did not pass; no scored games launched.');
  await launch('scored', ['--validated-by', state.validationId, '--name', values.name]);
  state.phase = 'complete';
  state.completedAt = new Date().toISOString();
  persist();
  log(`Scored tournament ${state.tournamentId} completed.\n`);
} catch (error) {
  state.phase = stopped ? 'interrupted' : 'failed';
  state.error = String(error);
  state.completedAt = new Date().toISOString();
  persist();
  log(`${state.error}\n`);
  process.exitCode = stopped ? 130 : 1;
}
