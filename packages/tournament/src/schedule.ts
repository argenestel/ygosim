import type { Game } from './types.js';
export function makeGame(id: string, seats: [string, string], round: number, stage: Game['stage'] = 'round-robin'): Game {
  return { id, seats, round, stage, status: 'pending', winner: null, decks: {}, stats: {} };
}
/** Circle schedule; a cyclic orientation balances first-chooser seats to within one. */
export function roundRobin(players: string[]): Game[] {
  if (new Set(players).size !== players.length || players.length < 2) throw new Error('Need at least two distinct players');
  const ring: (string | null)[] = [...players];
  if (ring.length % 2) ring.push(null);
  const games: Game[] = [];
  for (let round = 1; round < ring.length; round++) {
    for (let i = 0; i < ring.length / 2; i++) {
      const a = ring[i], b = ring[ring.length - 1 - i];
      if (!a || !b) continue;
      const ai = players.indexOf(a), bi = players.indexOf(b);
      const distance = (bi - ai + players.length) % players.length;
      const aFirst = distance < players.length / 2 || (distance === players.length / 2 && ai < bi);
      games.push(makeGame(`g${String(games.length + 1).padStart(3, '0')}`, aFirst ? [a, b] : [b, a], round));
    }
    ring.splice(1, 0, ring.pop()!);
  }
  return games;
}
export function finalGame(seats: [string, string], round: number): Game { return makeGame('final', seats, round, 'final'); }
export function runnableGames(games: Game[], activePlayers: Set<string>): Game[] {
  return games.filter(g => g.status === 'pending' && g.seats.every(id => !activePlayers.has(id)));
}
