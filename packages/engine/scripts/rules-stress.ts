import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createDuel, loadCardDb, parseYdk } from '../src/index.js';
import { rng } from './fuzz-support.js';
import { createBot } from '../../server/src/ai/index.js';
import { EasyBot } from '../../server/src/ai/easy.js';
import { BotProgress, actionDiagnostic, fingerprint } from '../../server/src/ai/progress.js';
import { Room } from '../../server/src/room.js';

const names = ['blue-eyes-fusion', 'junk-synchro', 'link-code-talker', 'utopia-xyz'];
const decks = names.map(name => parseYdk(readFileSync(new URL(`../decks/${name}.ydk`, import.meta.url), 'utf8')));
const output = process.argv[2] ?? '/tmp/ygosim-review/complex-decks.json';
mkdirSync(dirname(output), { recursive: true });
const db = await loadCardDb();
const results: object[] = [], promptCounts: Record<string, number> = {}, eventCounts: Record<string, number> = {}, summonCounts: Record<string, number> = {};
const activeCards = new Set<number>();
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const started = performance.now(), cpuStarted = process.cpuUsage();
let peakRss = process.memoryUsage().rss;
let concurrency: object | undefined;
let matrixMetrics: object | undefined;
const metrics = () => ({ wallMs: performance.now() - started, cpuMicros: process.cpuUsage(cpuStarted), peakRss, memory: process.memoryUsage(), eventLoopDelayMs: { mean: delay.mean / 1e6, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 } });
const save = () => writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(),
  purpose: 'Stress actual shuffled preset decks via production createDuel. Completion and adapter health are not independent proof of card ruling accuracy.',
  decks: names.map((name, i) => ({ name, hash: fingerprint(decks[i]) })),
  metrics: matrixMetrics ?? metrics(), concurrency,
  promptCounts, eventCounts, summonCounts, activatedOrSelectedCards: [...activeCards].map(code => ({ code, name: db.name(code) })), results }, null, 2));
if (!process.argv.includes('--concurrent-only')) for (const mode of ['easy', 'normal', 'hard'] as const) {
  for (let first = 0; first < 4; first++) for (let second = 0; second < 4; second++) {
    const seeds = [11, 42, 137];
    for (const seed of seeds) {
      const random = rng(seed), bots = [mode === 'easy' ? new EasyBot(random) : createBot(mode), mode === 'easy' ? new EasyBot(random) : createBot(mode)];
      let outcome = 'decision_cap', error: string | undefined, decisions = 0, turn = 0, phase = '';
      const progress = new BotProgress();
      const trace: ReturnType<typeof actionDiagnostic>[] = [];
      const duel = await createDuel({ decks: [decks[first], decks[second]], format: 'tcg', seed });
      try {
        for (; decisions < 4000; decisions++) {
          if (decisions % 100 === 99) {
            peakRss = Math.max(peakRss, process.memoryUsage().rss);
            await new Promise<void>(resolve => setImmediate(resolve));
          }
          const r = await duel.step();
          for (const e of r.events) {
            eventCounts[e.t] = (eventCounts[e.t] ?? 0) + 1;
            if (e.t === 'summon') summonCounts[e.kind] = (summonCounts[e.kind] ?? 0) + 1;
            if (e.t === 'activate' && e.card.code) activeCards.add(e.card.code);
          }
          if (r.ended) { outcome = 'completed'; break; }
          if (!r.pending) throw new Error('no prompt or ending');
          const { player, prompt } = r.pending, state = duel.stateFor(player); turn = state.turn; phase = state.phase;
          promptCounts[prompt.kind] = (promptCounts[prompt.kind] ?? 0) + 1;
          progress.observe([duel.stateFor(0), duel.stateFor(1)], player, prompt, r.events);
          const action = await bots[player].choose(state, prompt);
          const { choose } = action;
          duel.respond(player, action);
          const options = prompt.options.filter(o => choose.includes(o.id));
          options.forEach(o => { if (o.card?.code) activeCards.add(o.card.code); });
          trace.push(actionDiagnostic(player, prompt, action)); if (trace.length > 32) trace.shift();
        }
      } catch (e) { outcome = 'error'; error = String(e); }
      finally { duel.destroy(); }
      const result = { mode, decks: [names[first], names[second]], seed, outcome, decisions, turn, phase, error, trace: outcome === 'completed' ? undefined : trace };
      results.push(result); console.log(JSON.stringify(result)); save();
    }
  }
}
matrixMetrics = metrics();
delay.reset();
const concurrentStart = performance.now(), concurrentCpu = process.cpuUsage();
let maxHeartbeatDelayMs = 0, lastHeartbeat = performance.now();
const heartbeat = setInterval(() => {
  const now = performance.now();
  maxHeartbeatDelayMs = Math.max(maxHeartbeatDelayMs, now - lastHeartbeat - 10);
  lastHeartbeat = now;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 10);
const rooms = Array.from({ length: 8 }, (_, i) => {
  const room = new Room(createDuel, { seed: [11, 42, 137][i % 3] });
  const participant = (id: string) => ({ id, name: id, kind: 'bot' as const, bot: createBot(i % 2 ? 'hard' : 'normal'), send: () => {} });
  room.join(participant(`${i}:a`), decks[i % 4]);
  room.join(participant(`${i}:b`), decks[(i + 1) % 4]);
  return room;
});
try { await Promise.all(rooms.map(room => room.finished)); }
finally { clearInterval(heartbeat); await Promise.all(rooms.map(room => room.close())); }
concurrency = { rooms: rooms.length, naturalOutcomes: rooms.filter(room => room.winner !== undefined).length,
  rejectedActions: rooms.reduce((n, room) => n + room.diagnostics.rejectedActions, 0),
  failures: rooms.filter(room => room.diagnostics.failure).map(room => room.diagnostics),
  wallMs: performance.now() - concurrentStart, cpuMicros: process.cpuUsage(concurrentCpu), maxHeartbeatDelayMs,
  peakRss, memory: process.memoryUsage(), eventLoopDelayMs: { mean: delay.mean / 1e6, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 } };
save(); delay.disable();
const incomplete = results.filter(result => (result as { outcome: string }).outcome !== 'completed');
console.log(JSON.stringify({ total: results.length, completed: results.length - incomplete.length, incomplete: incomplete.length, concurrency }));
if (incomplete.length || rooms.some(room => room.winner === undefined || room.diagnostics.rejectedActions > 0)) process.exitCode = 1;
