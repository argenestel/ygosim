import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, safeId } from './storage.js';
import type { DeckInfo } from './types.js';

export function deckFingerprint(deck: { main: number[]; extra: number[] }): string {
  return createHash('sha256').update(JSON.stringify({ main: [...deck.main].sort((a, b) => a - b), extra: [...deck.extra].sort((a, b) => a - b) })).digest('hex');
}

export function saveDeckArtifacts(gameDir: string, playerId: string, deck: DeckInfo): void {
  safeId(playerId);
  const side = deck.side ?? [];
  const jsonPath = join(gameDir, `${playerId}.deck.json`);
  const ydkPath = join(gameDir, `${playerId}.deck.ydk`);
  atomicWrite(jsonPath, { ...deck, side, fingerprint: deckFingerprint(deck) });
  atomicWrite(ydkPath, ['#main', ...deck.main, '#extra', ...deck.extra, '!side', ...side, ''].join('\n'));
  chmodSync(jsonPath, 0o600); chmodSync(ydkPath, 0o600);
}
