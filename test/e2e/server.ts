import { startServer } from '../../packages/server/src/server.js';
import { loadEngine } from '../../packages/server/src/engine.js';
import { controlledDuel, L, type SetupCard } from '../../packages/engine/test/helpers/controlled-duel.js';

const hand = (code: number): SetupCard => ({ code, player: 0, location: L.HAND });
const field = (code: number, sequence = 0): SetupCard => ({ code, player: 0, location: L.MZONE, sequence });
const extra = (code: number): SetupCard => ({ code, player: 0, location: L.EXTRA });
const openings: Record<string, SetupCard[]> = {
  tribute: [hand(89631139), field(69140098), field(46986414, 1)],
  'double-tribute': [hand(89631139), field(17444133)],
  fusion: [hand(24094653), hand(89631139), hand(89631139), extra(2129638)],
  synchro: [field(63977008), field(9365703, 1), extra(60800381)],
  xyz: [field(69140098), field(69140098, 1), extra(84013237)],
  link: [field(63977008), field(70095154, 1), extra(2857636)],
  ritual: [hand(55761792), hand(5405694), hand(89631139)],
  pendulum: [hand(15146890), hand(51531505), hand(16178681), hand(46986414)],
};

const engine = await loadEngine();
if (!engine) throw new Error('Real engine is required for browser E2E');
const server = await startServer({
  port: 0,
  engine,
  seed: 42,
  botDelayMs: 0,
  turnTimeoutMs: 120_000,
  createDuel: async options => openings[process.env.E2E_SCENARIO ?? '']
    ? (await controlledDuel(openings[process.env.E2E_SCENARIO!])).duel
    : engine.createDuel(options),
});
console.log(`E2E_READY ${server.port}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
