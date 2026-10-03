import { describe, expect, it } from "vitest";
import { OcgLocation as L, OcgMessageType as M, OcgPosition as P, type OcgCardLocPos, type OcgCoreSync, type OcgDuelHandle, type OcgMessage } from "ocgcore-wasm";
import { SqlCardDb } from "../src/carddb.js";
import { translatePrompt, type PromptContext } from "../src/prompts.js";
import { DuelTracker } from "../src/state.js";

const secret = "Secret Alpha";
const strings = { system: new Map(), victory: new Map(), counter: new Map(), setname: new Map() };
const target: OcgCardLocPos = { code: 100, controller: 1, location: L.SZONE, sequence: 1, position: P.FACEDOWN_DEFENSE };

function setup(loc = target, first: 0 | 1 = 0, isPublic = false) {
  const db = new SqlCardDb();
  db.raw.set(100, { code: 100, alias: 0, setcode: 0n, type: 1 | 0x20, atk: 1000, def: 1000,
    level: 4, race: 1, attribute: 1, ot: 1, name: secret, desc: `${secret} effect`, strs: [`${secret} effect`] });
  const tracker = new DuelTracker(db, strings, 8000, first);
  const core = { duelQueryLocation: (_handle: unknown, query: { controller: number; location: number }) =>
    query.controller === loc.controller && query.location === loc.location
      ? Array.from({ length: loc.sequence + 1 }, (_, sequence) => sequence === loc.sequence
        ? { code: loc.code, position: loc.position, owner: loc.controller, attack: 1000, defense: 1000, level: 4, isPublic }
        : null) : [] } as unknown as OcgCoreSync;
  tracker.refresh(core, {} as OcgDuelHandle);
  const context: PromptContext = {
    db, strings, promptId: "privacy", viewer: tracker.player(0),
    card: card => tracker.promptCard(card, 0),
    cardByCode: code => tracker.promptCardByCode(code, 0),
  };
  return { tracker, context };
}

const decisions: Array<[string, (card: OcgCardLocPos) => OcgMessage]> = [
  ["select_card", card => ({ type: M.SELECT_CARD, player: 0, can_cancel: false, min: 1, max: 1, selects: [card] })],
  ["select_tribute", card => ({ type: M.SELECT_TRIBUTE, player: 0, can_cancel: false, min: 1, max: 1, selects: [{ ...card, release_param: 1 }] })],
  ["select_sum", card => ({ type: M.SELECT_SUM, player: 0, select_max: 0, amount: 2, min: 1, max: 1,
    selects_must: [{ ...card, amount: 1 }], selects: [{ ...card, amount: 1 }] })],
  ["select_chain", card => ({ type: M.SELECT_CHAIN, player: 0, spe_count: 0, forced: false,
    hint_timing: 0, hint_timing_other: 0, selects: [{ ...card, description: 100n << 20n, client_mode: 0 }] }) as unknown as OcgMessage],
  ["select_effect_yn", card => ({ type: M.SELECT_EFFECTYN, player: 0, ...card, description: 100n << 20n })],
  ["select_yesno with location", card => ({ type: M.SELECT_YESNO, player: 0, ...card, description: 100n << 20n })],
  ["select_yesno with card", card => ({ type: M.SELECT_YESNO, player: 0, card, description: 100n << 20n })],
  ["sort_card", card => ({ type: M.SORT_CARD, player: 0, cards: [card] })],
  ["sort_chain", card => ({ type: M.SORT_CHAIN, player: 0, cards: [card] })],
  ["select_counter", card => ({ type: M.SELECT_COUNTER, player: 0, counter_type: 7, count: 1, cards: [{ ...card, count: 1 }] })],
  ["select_position", card => ({ type: M.SELECT_POSITION, player: 0, code: card.code, positions: P.FACEUP_ATTACK })],
  ["select_unselect_card", card => ({ type: M.SELECT_UNSELECT_CARD, player: 0, can_cancel: false, can_finish: false,
    min: 1, max: 1, select_cards: [card], unselect_cards: [card] })],
  ["idle", card => ({ type: M.SELECT_IDLECMD, player: 0, summons: [card], special_summons: [card],
    monster_sets: [card], spell_sets: [card], pos_changes: [card], activates: [{ ...card, description: 100n << 20n, client_mode: 0 }],
    to_bp: false, to_ep: false, shuffle: false })],
  ["battle_idle", card => ({ type: M.SELECT_BATTLECMD, player: 0, chains: [{ ...card, description: 100n << 20n, client_mode: 0 }],
    attacks: [{ ...card, can_direct: false }], to_m2: false, to_ep: false })],
];

describe("prompt viewer privacy", () => {
  it.each([L.DECK, L.EXTRA, L.HAND] as const)("names your own core-offered private selection in zone %s", location => {
    const card = { ...target, controller: 0 as const, location };
    const { tracker, context } = setup(card);
    const translated = translatePrompt(decisions[0][1](card), context)!;
    expect(translated.prompt.options[0].label).toBe(secret);
    expect(translated.prompt.options[0].card).toMatchObject({ code: 100, atk: 1000, def: 1000 });
    if (location === L.DECK) {
      expect(tracker.stateFor(0).cards[0].code).toBeUndefined();
      expect(tracker.stateFor(1).cards[0].code).toBeUndefined();
    }
  });

  it("permits an explicitly confirmed opponent card only for its recipient", () => {
    const card = { ...target, location: L.DECK };
    const { tracker, context } = setup(card);
    tracker.ingest({ type: M.CONFIRM_CARDS, player: 0, cards: [card] });
    expect(translatePrompt(decisions[0][1](card), context)!.prompt.options[0].label).toBe(secret);
    expect(tracker.stateFor(0).cards[0].code).toBeUndefined();
    expect(tracker.stateFor(1).cards[0].code).toBeUndefined();
    tracker.ingest({ type: M.SHUFFLE_DECK, player: 1 });
    expect(tracker.promptCard(card, 0).code).toBeUndefined();
  });

  it.each(decisions)("redacts opponent set identities and effect text in %s", (_kind, message) => {
    const { tracker, context } = setup();
    const translated = translatePrompt(message(target), context)!;
    expect(translated).toBeDefined();
    const serialized = JSON.stringify(translated.prompt);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/"(?:code|atk|def|level)":/);
    const options = translated.prompt.options.filter(option => option.card);
    expect(options.length).toBeGreaterThan(0);
    expect(options.every(option => option.card!.uid === tracker.stateFor(0).cards[0].uid)).toBe(true);
    if (translated.prompt.kind !== "select_effect_yn" && translated.prompt.kind !== "select_yesno") {
      expect(options[0].label).toContain("Opponent's set card (Spell/Trap Zone 2)");
    } else {
      expect(translated.prompt.text).toContain("Opponent's set card (Spell/Trap Zone 2)");
    }
  });

  it.each(decisions)("preserves your own face-down identity in %s", (_kind, message) => {
    const own = { ...target, controller: 0 as const };
    const { context } = setup(own);
    const translated = translatePrompt(message(own), context)!;
    const options = translated.prompt.options.filter(option => option.card);
    expect(options.length).toBeGreaterThan(0);
    expect(options.every(option => option.card?.code === own.code)).toBe(true);
    expect(JSON.stringify(translated.prompt)).toContain(secret);
  });

  it.each([
    [L.MZONE, 2, "Opponent's face-down monster (Monster Zone 3)"],
    [L.HAND, 1, "Opponent's hand card 2"],
    [L.DECK, 1, "Opponent's deck card 2"],
    [L.REMOVED, 1, "Opponent's face-down banished card 2"],
    [L.EXTRA, 1, "Opponent's extra deck card 2"],
  ] as const)("uses a location label for hidden cards in zone %s", (location, sequence, label) => {
    const card = { ...target, location, sequence };
    const { context } = setup(card);
    const translated = translatePrompt(decisions[0][1](card), context)!;
    expect(translated.prompt.options[0].label).toBe(label);
    expect(translated.prompt.options[0].card?.code).toBeUndefined();
    expect(translated.respond(["0"])).toMatchObject({ indicies: [0] });
  });

  it.each([0, 1] as const)("uses tracker visibility for public cards with firstPlayer %s", first => {
    const card = { ...target, location: L.HAND };
    const { tracker, context } = setup(card, first, true);
    const translated = translatePrompt(decisions[0][1](card), context)!;
    expect(translated.prompt.options[0].card).toEqual(tracker.stateFor(tracker.player(0)).cards[0]);
    expect(translated.prompt.options[0].label).toBe(secret);
  });

  it.each([100n << 20n, 100n << 4n])("redacts packed yes/no effect identities (%s)", description => {
    const { context } = setup();
    expect(translatePrompt({ type: M.SELECT_YESNO, player: 0, description }, context)?.prompt.text).toBe("Effect");
  });

  it("fails closed for an untracked or ambiguous code-only position target", () => {
    const { tracker, context } = setup();
    tracker.card({ ...target, controller: 0, location: L.HAND });
    for (const code of [100, 200]) {
      const translated = translatePrompt({ type: M.SELECT_POSITION, player: 0, code, positions: P.FACEUP_ATTACK }, context)!;
      expect(translated.prompt.text).toBe("Choose a position for the selected card.");
      expect(translated.prompt.options[0].card).toBeUndefined();
      expect(JSON.stringify(translated.prompt)).not.toContain(secret);
    }
  });
});
