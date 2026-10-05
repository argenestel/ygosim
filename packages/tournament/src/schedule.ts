import type { Game } from './types.js';
export function makeGame(id: string, seats: [string, string], round: number, stage: Game['stage'] = 'round-robin'): Game {
  return { id, seats, round, stage, status: 'pending', winner: null, decks: {}, stats: {} };
}
function validateSeed(seed?: number): void {
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) throw new Error('Seed must be a uint32 integer');
}
/** Circle schedule; a cyclic orientation balances first-chooser seats to within one. */
export function roundRobin(players: string[], options: { cycles?: number; mirrored?: boolean; seed?: number } = {}): Game[] {
  if (new Set(players).size !== players.length || players.length < 2) throw new Error('Need at least two distinct players');
  const cycles = options.cycles === undefined ? 1 : options.cycles;
  if (!Number.isSafeInteger(cycles) || cycles < 1) throw new Error('Cycles must be a positive safe integer');
  validateSeed(options.seed);
  const roundsPerCycle = players.length % 2 ? players.length : players.length - 1;
  const games: Game[] = [];
  let seed = options.seed;
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const ring: (string | null)[] = [...players];
    if (ring.length % 2) ring.push(null);
    const cycleGames: Game[] = [];
    const roundOffset = (cycle - 1) * roundsPerCycle * (options.mirrored ? 2 : 1);
    for (let round = 1; round <= roundsPerCycle; round++) {
      for (let i = 0; i < ring.length / 2; i++) {
        const a = ring[i], b = ring[ring.length - 1 - i];
        if (!a || !b) continue;
        const ai = players.indexOf(a), bi = players.indexOf(b);
        const distance = (bi - ai + players.length) % players.length;
        const aFirst = distance < players.length / 2 || (distance === players.length / 2 && ai < bi);
        const game = makeGame(`g${String(games.length + 1).padStart(3, '0')}`, aFirst ? [a, b] : [b, a], roundOffset + round);
        if (cycles > 1 || options.mirrored || options.seed !== undefined) game.cycle = cycle;
        if (seed !== undefined) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          game.seed = seed;
        }
        games.push(game);
        cycleGames.push(game);
      }
      ring.splice(1, 0, ring.pop()!);
    }
    if (options.mirrored) {
      for (const game of cycleGames) {
        const mirroredGame = makeGame(`g${String(games.length + 1).padStart(3, '0')}`, [game.seats[1], game.seats[0]], game.round + roundsPerCycle);
        mirroredGame.cycle = cycle;
        if (game.seed !== undefined) mirroredGame.seed = game.seed;
        games.push(mirroredGame);
      }
    }
  }
  return games;
}
export function finalGame(seats: [string, string], round: number, seed?: number): Game {
  validateSeed(seed);
  const game = makeGame('final', seats, round, 'final');
  if (seed !== undefined) game.seed = seed;
  return game;
}
export function runnableGames(games: Game[], activePlayers: Set<string>): Game[] {
  return games.filter(g => g.status === 'pending' && g.seats.every(id => !activePlayers.has(id)));
}

export function seriesGame(players: [string, string], round: number, seed: number): Game {
  if (players[0] === players[1] || !Number.isInteger(round) || round < 1 || round > 3) throw new Error('Best-of-three requires two players and rounds 1–3');
  validateSeed(seed);
  const game = makeGame(`g${String(round).padStart(3, '0')}`, round % 2 ? [...players] : [players[1], players[0]], round, 'series');
  game.seed = (Math.imul(seed, 1664525) + Math.imul(round, 1013904223)) >>> 0;
  return game;
}

export function seriesResult(players: string[], games: Game[], seed: number): NonNullable<import('./types.js').Tournament['series']> {
  const wins = Object.fromEntries(players.map(id => [id, games.filter(game => game.status === 'done' && game.winner === id).length]));
  const winner = players.find(id => wins[id] >= 2) ?? null;
  return { bestOf: 3, seed, wins, winner, complete: winner !== null || games.filter(game => game.status === 'done').length >= 3 };
}
