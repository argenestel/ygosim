import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDuel, parseYdk } from '@ygosim/engine';
import { Room, type Participant } from '../src/room.js';
import { createBot } from '../src/ai/index.js';

const deck = (name: string) => parseYdk(readFileSync(new URL(`../../engine/decks/${name}.ydk`, import.meta.url), 'utf8'));

describe('real-core bot/room regressions with complex decks', () => {
  for (const level of ['normal', 'hard'] as const) for (const first of ['blue-eyes-fusion', 'utopia-xyz']) {
    it(`${level}: ${first} vs Blue Eyes should finish without engine-rejected actions (seed 42)`, async () => {
      const errors: string[] = [];
      const room = new Room(createDuel, { seed: 42 }, undefined, 'tcg');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const participant = (id: string): Participant => ({ id, name: id, kind: 'bot', bot: createBot(level),
        send: m => { if (m.type === 'error') errors.push(m.message); } });
      const timeout = setTimeout(() => { void room.close(); }, 1500);
      try {
        room.join(participant('a'), deck(first)); room.join(participant('b'), deck('blue-eyes-fusion'));
        await room.finished;
        expect(errors, errors.slice(0, 4).join('\n')).toEqual([]);
        expect(room.winner, 'room stopped without a natural duel outcome').not.toBeUndefined();
      } finally { clearTimeout(timeout); await room.close(); consoleError.mockRestore(); }
    }, 10000);
  }
});
