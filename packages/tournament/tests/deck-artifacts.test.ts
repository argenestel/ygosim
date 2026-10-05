import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { parseYdk } from '@ygosim/mcp/deck';
import { deckFingerprint, saveDeckArtifacts } from '../src/deck-artifacts.js';
import { agentPrompt } from '../src/agent-prompt.js';
import { makeGame } from '../src/schedule.js';
import { getRosterPlayer } from '../src/roster.js';
import type { Tournament } from '../src/types.js';

it('persists the complete deck, reason and stable identity as private JSON and importable YDK', () => {
  const root = mkdtempSync(join(tmpdir(), 'tournament-deck-artifact-'));
  try {
    const deck = { name: 'Fixture', source: 'custom' as const, reason: 'Independent card selection', main: [3, 1, 1], extra: [5, 4], side: [9] };
    saveDeckArtifacts(root, 'player-a', deck);
    const json = JSON.parse(readFileSync(join(root, 'player-a.deck.json'), 'utf8'));
    expect(json).toEqual({ ...deck, fingerprint: deckFingerprint(deck) });
    expect(parseYdk(readFileSync(join(root, 'player-a.deck.ydk'), 'utf8'))).toEqual({ main: deck.main, extra: deck.extra, side: deck.side });
    expect(deckFingerprint({ main: [1, 3, 1], extra: [4, 5] })).toBe(json.fingerprint);
    expect(statSync(join(root, 'player-a.deck.json')).mode & 0o777).toBe(0o600);
    expect(() => saveDeckArtifacts(root, '../outside', deck)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('makes building mandatory in the custom-only prompt without requiring filesystem tools', () => {
  const players = [getRosterPlayer('pi-grok-46')!, getRosterPlayer('pi-luna-max')!];
  const game = makeGame('g1', [players[0].id, players[1].id], 1);
  const tournament: Tournament = { id: 'fixture', name: 'Fixture', createdAt: '2026-01-01', status: 'running', format: 'round-robin+final', players, games: [game], deckPolicy: 'custom-only' };
  const prompt = agentPrompt(tournament, game, players[0]);
  expect(prompt).toContain('MUST independently build'); expect(prompt).toContain('list_decks does not exist');
  expect(prompt).toContain('card_info with code, name, or query'); expect(prompt).toContain('Forbidden/Limited/Semi-Limited');
  expect(prompt).toContain('40–60 main'); expect(prompt).toContain('Fusion/Synchro/Xyz/Link'); expect(prompt).toContain('monster/spell/trap ratio');
  expect(prompt).toContain('main/extra/side passcode arrays or YDK'); expect(prompt).toContain('archetype'); expect(prompt).toContain('staples'); expect(prompt).toContain('extra-deck plan');
  expect(prompt).toContain('exact game validation error'); expect(prompt).toContain('fix and retry'); expect(prompt).toContain('DUEL OVER');
  expect(prompt).toContain('JSON and YDK'); expect(prompt).not.toContain('Choose a legal deck using list_decks or');
});
