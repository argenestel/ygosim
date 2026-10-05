import type { DeckStat, Game, Leaderboard, Player, Standing, Tournament } from "./types.js";

export const STARTING_ELO = 1500;
export const ELO_K = 32;
/** Backwards-compatible name for callers that use the contract's K factor. */
export const K_FACTOR = ELO_K;

type Result = "win" | "loss" | "draw";

interface Accumulator {
  player: Player;
  elo: number;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  points: number;
  turnsTotal: number;
  turnsGames: number;
  decisions: number;
  decisionMs: number;
  timedDecisions: number;
  invalid: number;
  reasonsGiven: number;
  crashes: number;
  decks: Map<string, { name: string; played: number; wins: number }>;
}

interface DeckAccumulator extends DeckStat {}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function playerList(players: readonly Player[]): Player[] {
  const seen = new Set<string>();
  const result: Player[] = [];
  for (const player of players) {
    if (!player || typeof player.id !== "string" || !player.id || seen.has(player.id)) continue;
    seen.add(player.id);
    result.push(player);
  }
  return result;
}

function isTournament(value: readonly Player[] | Tournament): value is Tournament {
  return !Array.isArray(value);
}

function makeAccumulator(player: Player): Accumulator {
  return {
    player,
    elo: STARTING_ELO,
    played: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    points: 0,
    turnsTotal: 0,
    turnsGames: 0,
    decisions: 0,
    decisionMs: 0,
    timedDecisions: 0,
    invalid: 0,
    reasonsGiven: 0,
    crashes: 0,
    decks: new Map(),
  };
}

function finishedGames(games: readonly Game[]): Game[] {
  return games
    .map((game, index) => ({ game, index }))
    .filter(({ game }) => game.status === "done")
    .sort((a, b) => {
      const aTime = a.game.endedAt ? Date.parse(a.game.endedAt) : Number.NaN;
      const bTime = b.game.endedAt ? Date.parse(b.game.endedAt) : Number.NaN;
      const aHas = Number.isFinite(aTime);
      const bHas = Number.isFinite(bTime);
      if (aHas && bHas && aTime !== bTime) return aTime - bTime;
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ game }) => game);
}

function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/** Return this player's post-game rating using both pre-game ratings. */
export function updateElo(
  ratingA: number,
  ratingB: number,
  scoreOrResult: number | Result,
): number {
  const score = typeof scoreOrResult === 'number' ? scoreOrResult
    : scoreOrResult === 'win' ? 1 : scoreOrResult === 'loss' ? 0 : 0.5;
  if (![ratingA, ratingB, score].every(Number.isFinite) || score < 0 || score > 1) {
    throw new Error("invalid Elo update values");
  }
  return ratingA + ELO_K * (score - expectedScore(ratingA, ratingB));
}

function result(game: Game): {
  winner: string | null;
  first: Result;
  second: Result;
} | null {
  const [first, second] = game.seats;
  if (game.winner === null) return { winner: null, first: "draw", second: "draw" };
  if (game.winner === first) return { winner: first, first: "win", second: "loss" };
  if (game.winner === second) return { winner: second, first: "loss", second: "win" };
  return null;
}

function addGameStats(acc: Accumulator, game: Game, id: string): void {
  const stats = game.stats?.[id];
  if (!stats) return;
  const decisions = Math.max(0, finite(stats.decisions));
  acc.decisions += decisions;
  const timed = stats.latencyKind === 'response' ? Math.max(0, finite(stats.timedDecisions)) : decisions;
  acc.timedDecisions += timed;
  acc.decisionMs += timed * Math.max(0, finite(stats.avgDecisionMs));
  acc.invalid += Math.max(0, finite(stats.invalid));
  acc.reasonsGiven += Math.max(0, finite(stats.reasonsGiven));
}

function addDeck(acc: Accumulator, game: Game, id: string, won: boolean): void {
  const deck = game.decks?.[id];
  if (!deck || typeof deck.name !== "string" || !deck.name) return;
  const existing = acc.decks.get(deck.name);
  if (existing) {
    existing.played++;
    if (won) existing.wins++;
    return;
  }
  acc.decks.set(deck.name, { name: deck.name, played: 1, wins: won ? 1 : 0 });
}

function toStanding(acc: Accumulator): Standing {
  return {
    id: acc.player.id,
    label: acc.player.label,
    model: acc.player.model,
    elo: acc.elo,
    played: acc.played,
    wins: acc.wins,
    losses: acc.losses,
    draws: acc.draws,
    points: acc.points,
    winRate: acc.played ? acc.wins / acc.played : 0,
    avgTurns: acc.turnsGames ? acc.turnsTotal / acc.turnsGames : 0,
    avgDecisionMs: acc.timedDecisions ? acc.decisionMs / acc.timedDecisions : 0,
    invalidRate: acc.decisions ? acc.invalid / acc.decisions : 0,
    reasonRate: acc.decisions ? acc.reasonsGiven / acc.decisions : 0,
    crashes: acc.crashes,
    decks: [...acc.decks.values()],
  };
}

/** Sort standings by points, then Elo, wins, and stable player id. */
export function sortStandings(rows: readonly Standing[]): Standing[] {
  return [...rows].sort((a, b) => b.points - a.points || b.elo - a.elo || b.wins - a.wins || a.id.localeCompare(b.id));
}

/**
 * Calculate standings from completed games. Elo updates are deliberately
 * applied in endedAt order, as required by the tournament contract.
 */
export function computeStandings(players: readonly Player[], games?: readonly Game[]): Standing[];
export function computeStandings(tournament: Tournament): Standing[];
export function computeStandings(
  playersOrTournament: readonly Player[] | Tournament,
  gamesArgument?: readonly Game[],
): Standing[] {
  const players = isTournament(playersOrTournament)
    ? playerList(playersOrTournament.players)
    : playerList(playersOrTournament);
  const games = isTournament(playersOrTournament)
    ? playersOrTournament.games
    : gamesArgument ?? [];
  const byId = new Map(players.map((player) => [player.id, makeAccumulator(player)] as const));

  for (const game of finishedGames(games)) {
    const outcome = result(game);
    if (!outcome) continue;
    const [firstId, secondId] = game.seats;
    const first = byId.get(firstId);
    const second = byId.get(secondId);
    if (!first || !second || firstId === secondId) continue;

    const firstRating = first.elo;
    const secondRating = second.elo;
    const firstScore = outcome.first === "win" ? 1 : outcome.first === "loss" ? 0 : 0.5;
    first.elo = updateElo(firstRating, secondRating, firstScore);
    second.elo = updateElo(secondRating, firstRating, 1 - firstScore);

    first.played++;
    second.played++;
    if (outcome.first === "win") {
      first.wins++;
      second.losses++;
      first.points += 3;
    } else if (outcome.first === "loss") {
      first.losses++;
      second.wins++;
      second.points += 3;
    } else {
      first.draws++;
      second.draws++;
      first.points++;
      second.points++;
    }

    if (game.turns !== undefined && Number.isFinite(game.turns)) {
      const turns = Math.max(0, game.turns);
      first.turnsTotal += turns;
      second.turnsTotal += turns;
      first.turnsGames++;
      second.turnsGames++;
    }
    addGameStats(first, game, firstId);
    addGameStats(second, game, secondId);
    addDeck(first, game, firstId, outcome.first === "win");
    addDeck(second, game, secondId, outcome.second === "win");

    if (game.reason === "agent-crash") {
      if (outcome.first === "loss") first.crashes++;
      if (outcome.second === "loss") second.crashes++;
      // A crash with no winner means both agents failed to finish.
      if (outcome.first === "draw") {
        first.crashes++;
        second.crashes++;
      }
    }
  }

  return sortStandings([...byId.values()].map(toStanding));
}

/** Return the top two players for a final, or null when fewer than two exist. */
export function selectFinalists(rows: readonly Standing[]): [string, string] | null {
  const ranked = sortStandings(rows);
  return ranked.length >= 2 ? [ranked[0].id, ranked[1].id] : null;
}

function deckStats(games: readonly Game[], knownPlayers: ReadonlySet<string>): DeckStat[] {
  const byDeck = new Map<string, DeckAccumulator>();
  for (const game of finishedGames(games)) {
    const outcome = result(game);
    if (!outcome) continue;
    for (const id of game.seats) {
      if (!knownPlayers.has(id)) continue;
      const deck = game.decks?.[id];
      if (!deck || !deck.name || (deck.source !== "sample" && deck.source !== "custom")) continue;
      const key = `${deck.source}:${deck.name}`;
      let stat = byDeck.get(key);
      if (!stat) {
        stat = { name: deck.name, source: deck.source, picks: 0, wins: 0, pickedBy: {} };
        byDeck.set(key, stat);
      }
      stat.picks++;
      if (outcome.winner === id) stat.wins++;
      stat.pickedBy[id] = (stat.pickedBy[id] ?? 0) + 1;
    }
  }
  return [...byDeck.values()];
}

/** Aggregate all completed games from one or more tournaments in Elo order. */
export function computeLeaderboard(
  tournaments: readonly Tournament[],
  updatedAt = new Date().toISOString(),
): Leaderboard {
  const players: Player[] = [];
  const seen = new Set<string>();
  const games: Game[] = [];
  for (const tournament of tournaments) {
    if (tournament.scored === false) continue;
    for (const player of tournament.players) {
      if (!seen.has(player.id)) {
        seen.add(player.id);
        players.push(player);
      }
    }
    games.push(...tournament.games);
  }
  return { players: computeStandings(players, games), decks: deckStats(games, seen), updatedAt };
}
