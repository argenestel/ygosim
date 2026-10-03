import type {
  CardRef,
  PlayerIdx,
  Prompt,
  PromptOption,
} from "@ygosim/protocol";
import {
  OcgLocation,
  OcgMessageType,
  OcgOpCode,
  OcgPosition,
  OcgResponseType,
} from "ocgcore-wasm";
import type {
  OcgCardLoc,
  OcgCardLocActive,
  OcgCardLocCounter,
  OcgCardLocPos,
  OcgCardLocSum,
  OcgCardLocTribute,
  OcgCardData,
  OcgMessage,
  OcgAttribute,
  OcgRace,
  OcgResponse,
} from "ocgcore-wasm";
import { toOcgCard, type SqlCardDb } from "./carddb.js";
import type { SystemStrings } from "./data.js";

export interface PromptContext {
  db: SqlCardDb;
  strings: SystemStrings;
  /** Returns a card already redacted for the deciding player. */
  card: (loc: OcgCardLoc) => CardRef;
  cardByCode?: (code: number) => CardRef | undefined;
  viewer?: PlayerIdx;
  promptId: string;
}

export interface TranslatedPrompt {
  player: PlayerIdx;
  prompt: Prompt;
  respond: (ids: string[]) => OcgResponse;
}

const IDLE = {
  summon: 0,
  specialSummon: 1,
  position: 2,
  monsterSet: 3,
  spellSet: 4,
  activate: 5,
  battle: 6,
  end: 7,
  shuffle: 8,
} as const;

const BATTLE = {
  activate: 0,
  attack: 1,
  main2: 2,
  end: 3,
} as const;

const LOCATION_NAMES: Record<number, string> = {
  [OcgLocation.DECK]: "Deck",
  [OcgLocation.HAND]: "Hand",
  [OcgLocation.MZONE]: "Monster Zone",
  [OcgLocation.SZONE]: "Spell/Trap Zone",
  [OcgLocation.GRAVE]: "Graveyard",
  [OcgLocation.REMOVED]: "Banished",
  [OcgLocation.EXTRA]: "Extra Deck",
  [OcgLocation.OVERLAY]: "Xyz Materials",
  [OcgLocation.FZONE]: "Field Zone",
  [OcgLocation.PZONE]: "Pendulum Zone",
};

const ATTRIBUTE_NAMES = ["EARTH", "WATER", "FIRE", "WIND", "LIGHT", "DARK", "DIVINE"];
const RACE_NAMES = [
  "Warrior", "Spellcaster", "Fairy", "Fiend", "Zombie", "Machine", "Aqua", "Pyro", "Rock",
  "Winged Beast", "Plant", "Insect", "Thunder", "Dragon", "Beast", "Beast-Warrior", "Dinosaur",
  "Fish", "Sea Serpent", "Reptile", "Psychic", "Divine-Beast", "Creator God", "Wyrm", "Cyberse",
  "Illusion", "Cyborg", "Magical Knight", "High Dragon", "Omega Psychic", "Celestial Warrior", "Galaxy",
];

const fail = (message: string): never => { throw new Error(`invalid prompt response: ${message}`); };

function player(value: number): PlayerIdx | undefined {
  return value === 0 || value === 1 ? value : undefined;
}

function bounded(value: number, floor = 0): number {
  return Number.isFinite(value) ? Math.max(floor, Math.trunc(value)) : floor;
}

function textForDescription(ctx: PromptContext, description: bigint | number, code?: number): string | undefined {
  const raw = typeof description === "bigint" ? description : BigInt(description);
  const numeric = Number(raw);
  // Small values are system-string ids (for example 90 asks whether to use
  // an additional normal summon).  Check this before interpreting the value
  // as an encoded card effect id.
  if (Number.isSafeInteger(numeric)) {
    const system = ctx.strings.system.get(numeric);
    if (system) return system;
  }
  const candidates: bigint[] = [raw];
  if (code !== undefined) {
    // Old card databases use code * 16 + effect index.  Recent scripts use
    // aux.Stringid's code << 20 representation.  Supporting both keeps the
    // prompt layer independent of the core build used by the room.
    candidates.push((BigInt(code) << 4n) | (raw & 0xfn));
    candidates.push((BigInt(code) << 20n) | (raw & 0xfffffn));
  }
  for (const candidate of candidates) {
    try {
      const text = ctx.db.effectString(candidate);
      if (text) return text;
    } catch {
      // A malformed description should still produce a readable fallback.
    }
  }
  return undefined;
}

function descriptionLabel(ctx: PromptContext, description: bigint | number, code?: number): string {
  // Some yes/no messages identify a card only through its packed effect id.
  // Resolve that identity through the tracker before reading private text.
  const raw = BigInt(description);
  if (code === undefined && ctx.cardByCode && !ctx.strings.system.has(Number(raw))) {
    const effectCode = [Number(raw >> 20n), Number(raw >> 4n)].find(candidate => ctx.db.raw.has(candidate));
    if (effectCode !== undefined && !ctx.cardByCode(effectCode)?.code) return "Effect";
  }
  return textForDescription(ctx, description, code) ?? "Effect";
}

function locationLabel(location: number): string {
  return LOCATION_NAMES[location] ?? `Location ${location}`;
}

function controllerLabel(controller: number, asker: PlayerIdx): string {
  return controller === asker ? "Your" : "Opponent's";
}

function hiddenCardLabel(card: CardRef, side: string): string {
  const zone = {
    mzone: "Monster Zone", emzone: "Extra Monster Zone", szone: "Spell/Trap Zone",
    fzone: "Field Zone", pzone: "Pendulum Zone",
  }[card.location as "mzone" | "emzone" | "szone" | "fzone" | "pzone"];
  if (zone) {
    const kind = card.location === "mzone" || card.location === "emzone" ? "face-down monster" : "set card";
    return `${side}${kind} (${zone} ${card.sequence + 1})`;
  }
  const pile = card.location === "banished" ? "face-down banished" : card.location === "extra" ? "extra deck" : card.location;
  return `${side}${pile} card ${card.sequence + 1}`;
}

function cardLabel(ctx: PromptContext, loc: OcgCardLoc, asker: PlayerIdx, suffix?: string): { card: CardRef; label: string } {
  const card = ctx.card(loc);
  const side = `${controllerLabel(loc.controller, asker)} `;
  if (!card.code) return { card, label: `${hiddenCardLabel(card, side)}${suffix ? `; ${suffix}` : ""}` };
  const name = ctx.db.name(card.code);
  const where = `${side}${locationLabel(loc.location)} ${loc.sequence + 1}`;
  return { card, label: `${name} (${where}${suffix ? `; ${suffix}` : ""})` };
}

function actionCardLabel(ctx: PromptContext, loc: OcgCardLoc, cards: OcgCardLoc[], asker: PlayerIdx): { card: CardRef; label: string } {
  const card = ctx.card(loc);
  if (!card.code) return { card, label: hiddenCardLabel(card, `${controllerLabel(loc.controller, asker)} `) };
  const name = ctx.db.name(card.code);
  const ambiguous = cards.some((other) => other.code === card.code && other.location !== loc.location);
  const where = loc.location === OcgLocation.GRAVE ? "Grave" : locationLabel(loc.location);
  return { card, label: ambiguous ? `${name} (${where})` : name };
}

function positionAction(name: string, position: number): string {
  const target = position & (OcgPosition.FACEUP_DEFENSE | OcgPosition.FACEDOWN_DEFENSE) ? "DEF" : "ATK";
  const hidden = position & (OcgPosition.FACEDOWN_ATTACK | OcgPosition.FACEDOWN_DEFENSE) ? " (face-down)" : "";
  return `Change ${name} to ${target} position${hidden}`;
}

function option(id: string, label: string, card?: CardRef): PromptOption {
  return card ? { id, label, card } : { id, label };
}

function assertIds(ids: string[], options: PromptOption[], min: number, max: number): void {
  if (!Array.isArray(ids)) fail("choices must be an array");
  if (ids.some((id) => typeof id !== "string")) fail("choice ids must be strings");
  if (new Set(ids).size !== ids.length) fail("duplicate choice ids");
  if (ids.length < min || ids.length > max) fail(`expected ${min}-${max} choices`);
  const allowed = new Set(options.map((o) => o.id));
  for (const id of ids) if (!allowed.has(id)) fail(`unknown choice ${id}`);
}

function prompt(
  context: PromptContext,
  kind: Prompt["kind"],
  text: string,
  options: PromptOption[],
  min = 1,
  max = min,
): Prompt {
  return { promptId: context.promptId, kind, text, min, max, options };
}

function selectedIndices(ids: string[], options: PromptOption[], min: number, max: number): number[] {
  assertIds(ids, options, min, max);
  return ids.map((id) => Number(id));
}

function cardOptions(ctx: PromptContext, cards: OcgCardLocPos[], asker: PlayerIdx): PromptOption[] {
  return cards.map((loc, index) => {
    const rendered = actionCardLabel(ctx, loc, cards, asker);
    return option(String(index), rendered.label, rendered.card);
  });
}

function activeOptions(ctx: PromptContext, cards: OcgCardLocActive[], asker: PlayerIdx, action = "Activate", peers: OcgCardLoc[] = cards): PromptOption[] {
  return cards.map((loc, index) => {
    const rendered = actionCardLabel(ctx, loc, peers, asker);
    const effect = rendered.card.code ? textForDescription(ctx, loc.description, rendered.card.code) : undefined;
    return option(String(index), `${action} ${rendered.label}${effect ? `: ${effect}` : ""}`, rendered.card);
  });
}

function boundedCardSelection(message: {
  can_cancel: boolean;
  min: number;
  max: number;
  selects: OcgCardLocPos[];
}, context: PromptContext, playerId: PlayerIdx): TranslatedPrompt {
  const cards = cardOptions(context, message.selects, playerId);
  const requestedMin = bounded(message.min);
  const max = Math.min(bounded(message.max), message.selects.length);
  const min = Math.min(requestedMin, max);
  if (message.can_cancel) cards.push(option("cancel", "Cancel selection"));
  const p = prompt(context, "select_card", "Select card(s).", cards, min, max);
  p.constraints = { kind: "count", ...(message.can_cancel ? { cancel: "cancel" } : {}) };
  return {
    player: playerId,
    prompt: p,
    respond: (ids) => {
      if (ids.length === 1 && ids[0] === "cancel" && message.can_cancel) {
        return { type: OcgResponseType.SELECT_CARD, indicies: null };
      }
      const indices = selectedIndices(ids, cards.filter((o) => o.id !== "cancel"), message.can_cancel ? min : min, max);
      return { type: OcgResponseType.SELECT_CARD, indicies: indices };
    },
  };
}

function fieldPlaces(message: { player: number; field_mask: number }, asker: PlayerIdx): Array<{ id: string; player: PlayerIdx; location: number; sequence: number; label: string }> {
  const flag = message.field_mask >>> 0;
  const out: Array<{ id: string; player: PlayerIdx; location: number; sequence: number; label: string }> = [];
  for (const side of [0, 1] as const) {
    const target = (side === 0 ? asker : (1 - asker)) as PlayerIdx;
    for (const [location, shift, count] of [
      [OcgLocation.MZONE, 0, 7],
      [OcgLocation.SZONE, 8, 8],
    ] as const) {
      for (let sequence = 0; sequence < count; sequence++) {
        const bit = 1 << (shift + sequence + (side ? 16 : 0));
        if ((flag & bit) !== 0) continue;
        const zone = location === OcgLocation.MZONE ? "Monster" : "Spell/Trap";
        out.push({
          id: `place:${target}:${location}:${sequence}`,
          player: target,
          location,
          sequence,
          label: `${target === asker ? "Your" : "Opponent's"} ${zone} Zone ${sequence + 1}`,
        });
      }
    }
  }
  return out;
}

function placePrompt(
  message: { player: number; count: number; field_mask: number },
  context: PromptContext,
  responseType: OcgResponseType.SELECT_PLACE | OcgResponseType.SELECT_DISFIELD,
  text: string,
): TranslatedPrompt | undefined {
  const playerId = player(message.player);
  if (playerId === undefined) return undefined;
  const places = fieldPlaces(message, playerId);
  const count = bounded(message.count);
  const options = places.map((p) => option(p.id, p.label));
  const p = prompt(context, "select_place", text, options, count, count);
  return {
    player: playerId,
    prompt: p,
    respond: (ids) => {
      assertIds(ids, options, count, count);
      const selected = ids.map((id) => places.find((place) => place.id === id)!);
      if (new Set(selected.map((s) => `${s.player}:${s.location}:${s.sequence}`)).size !== selected.length) {
        fail("duplicate field place");
      }
      return {
        type: responseType,
        places: selected.map((s) => ({ player: s.player, location: s.location, sequence: s.sequence })),
      } as OcgResponse;
    },
  };
}

function tributePrompt(
  message: { player: number; can_cancel: boolean; min: number; max: number; selects: OcgCardLocTribute[] },
  context: PromptContext,
): TranslatedPrompt | undefined {
  const playerId = player(message.player);
  if (playerId === undefined) return undefined;
  const options = message.selects.map((loc, index) => {
    const rendered = cardLabel(context, loc, playerId, `tributes ${loc.release_param}`);
    return option(String(index), rendered.label, rendered.card);
  });
  if (message.can_cancel || message.min === 0) options.push(option("cancel", "Cancel selection"));
  const maxCards = Math.min(Math.max(0, bounded(message.max)), message.selects.length);
  // `min` and `max` are tribute values in the core; release_param is the
  // weight of each card.  The UI bounds are cardinality bounds, while the
  // callback below enforces the weighted lower bound exactly.
  const uiMin = message.min === 0 ? 0 : Math.min(1, maxCards);
  const p = prompt(context, "select_tribute", "Select tributes.", options, uiMin, maxCards);
  p.constraints = {
    kind: "tribute", required: message.min,
    values: Object.fromEntries(message.selects.map((loc, index) => [String(index), loc.release_param])),
    ...(message.can_cancel || message.min === 0 ? { cancel: "cancel" } : {}),
  };
  return {
    player: playerId,
    prompt: p,
    respond: (ids) => {
      const cancelable = message.can_cancel || message.min === 0;
      if (ids.length === 1 && ids[0] === "cancel" && cancelable) {
        return { type: OcgResponseType.SELECT_TRIBUTE, indicies: null };
      }
      const choices = options.filter((o) => o.id !== "cancel");
      assertIds(ids, choices, uiMin, maxCards);
      const total = ids.reduce((sum, id) => sum + (message.selects[Number(id)]?.release_param ?? 0), 0);
      if (total < message.min) fail(`tributes provide ${total}, need at least ${message.min}`);
      return { type: OcgResponseType.SELECT_TRIBUTE, indicies: ids.map(Number) };
    },
  };
}

function sumParameters(amount: number): number[] {
  const n = amount >>> 0;
  const low = n & 0xffff;
  const high = n >>> 16;
  return high ? [low, high] : [low];
}

function exactSum(parameters: number[][], target: number): boolean {
  if (!parameters.length || target <= 0) return false;
  const walk = (index: number, left: number): boolean => {
    if (index === parameters.length) return left === 0;
    for (const value of parameters[index]!) {
      if (value <= 0 || value > left) continue;
      if (walk(index + 1, left - value)) return true;
    }
    return false;
  };
  return walk(0, target);
}

function atLeastSum(parameters: number[][], target: number): boolean {
  if (!parameters.length || target <= 0) return false;
  let sum = 0;
  let max = 0;
  let smallest = Number.POSITIVE_INFINITY;
  for (const values of parameters) {
    const low = values.length > 1 && values[1]! > 0 && values[1]! < values[0]! ? values[1]! : values[0]!;
    const high = Math.max(...values);
    sum += low;
    max += high;
    smallest = Math.min(smallest, low);
  }
  return max >= target && sum - smallest < target;
}

function sumPrompt(
  message: {
    player: number;
    select_max: number;
    amount: number;
    min: number;
    max: number;
    selects_must: OcgCardLocSum[];
    selects: OcgCardLocSum[];
  },
  context: PromptContext,
): TranslatedPrompt | undefined {
  const playerId = player(message.player);
  if (playerId === undefined) return undefined;
  const mustText = message.selects_must.length
    ? ` Mandatory: ${message.selects_must.map((loc) => cardLabel(context, loc, playerId).label).join(", ")}.`
    : "";
  const options = message.selects.map((loc, index) => {
    const values = sumParameters(loc.amount);
    const amountText = values.length === 1 ? `${values[0]}` : `${values[0]} or ${values[1]}`;
    const rendered = cardLabel(context, loc, playerId, `value ${amountText}`);
    return option(String(index), rendered.label, rendered.card);
  });
  // In the core's no-maximum mode, `min` is retained in the wire message but
  // is intentionally not checked by the validator.  Keep the public bounds
  // aligned with that behavior so mandatory cards may satisfy an empty pick.
  const min = message.max ? bounded(message.min) : 0;
  const max = message.max ? Math.min(bounded(message.max), options.length) : options.length;
  const p = prompt(context, "select_sum", `Select cards totaling ${message.amount}.${mustText}`, options, min, Math.max(min, max));
  const exact = message.select_max === 0;
  p.constraints = {
    kind: "sum", target: message.amount, mode: exact ? "exact" : "at_least",
    values: Object.fromEntries(message.selects.map((loc, index) => [String(index), sumParameters(loc.amount)])),
    mandatory: message.selects_must.map((loc) => sumParameters(loc.amount)),
  };
  return {
    player: playerId,
    prompt: p,
    respond: (ids) => {
      assertIds(ids, options, min, Math.max(min, max));
      const parameters = [
        ...message.selects_must.map((loc) => sumParameters(loc.amount)),
        ...ids.map((id) => sumParameters(message.selects[Number(id)]!.amount)),
      ];
      const valid = exact ? exactSum(parameters, message.amount) : atLeastSum(parameters, message.amount);
      if (!valid) fail("selected cards do not satisfy the required sum");
      return { type: OcgResponseType.SELECT_SUM, indicies: ids.map(Number) };
    },
  };
}

function counterPrompt(
  message: { player: number; counter_type: number; count: number; cards: OcgCardLocCounter[] },
  context: PromptContext,
): TranslatedPrompt | undefined {
  const playerId = player(message.player);
  if (playerId === undefined) return undefined;
  const counterName = context.strings.counter.get(message.counter_type) ?? `Counter ${message.counter_type}`;
  const options: PromptOption[] = [];
  const choiceMap = new Map<string, { card: number; amount: number }>();
  message.cards.forEach((loc, cardIndex) => {
    const rendered = cardLabel(context, loc, playerId, `${loc.count} ${counterName}`);
    for (let amount = 1; amount <= loc.count; amount++) {
      const id = `counter:${cardIndex}:${amount}`;
      choiceMap.set(id, { card: cardIndex, amount });
      options.push(option(id, `${rendered.label} — remove ${amount}`, rendered.card));
    }
  });
  const p = prompt(context, "select_counter", `Remove ${message.count} ${counterName}.`, options, 1, message.cards.length);
  p.constraints = {
    kind: "sum", target: message.count, mode: "exact", mandatory: [],
    values: Object.fromEntries([...choiceMap].map(([id, choice]) => [id, [choice.amount]])),
    exclusiveGroups: message.cards.map((_, index) => [...choiceMap].filter(([, choice]) => choice.card === index).map(([id]) => id)),
  };
  return {
    player: playerId,
    prompt: p,
    respond: (ids) => {
      assertIds(ids, options, 1, message.cards.length);
      const taken = new Array<number>(message.cards.length).fill(0);
      for (const id of ids) {
        const choice = choiceMap.get(id);
        if (!choice) fail(`unknown counter choice ${id}`);
        const picked = choice!;
        if (taken[picked.card] !== 0) fail("choose one counter amount per card");
        taken[picked.card] = picked.amount;
      }
      const total = taken.reduce((sum, amount) => sum + amount, 0);
      if (total !== message.count) fail(`selected ${total} counters, need ${message.count}`);
      return { type: OcgResponseType.SELECT_COUNTER, counters: taken };
    },
  };
}

function bitsPrompt(
  message: { player: number; count: number; available: number | bigint },
  context: PromptContext,
  race: boolean,
): TranslatedPrompt | undefined {
  const playerId = player(message.player);
  if (playerId === undefined) return undefined;
  const available = typeof message.available === "bigint" ? message.available : BigInt(message.available);
  const names = race ? RACE_NAMES : ATTRIBUTE_NAMES;
  const options: PromptOption[] = [];
  for (let bit = 0; bit < 64; bit++) {
    const mask = 1n << BigInt(bit);
    if ((available & mask) === 0n) continue;
    const label = names[bit] ?? `${race ? "Race" : "Attribute"} ${mask}`;
    options.push(option(String(mask), label));
  }
  const count = bounded(message.count);
  const p = prompt(context, "announce", `Announce ${race ? "race" : "attribute"}(s).`, options, count, count);
  return {
    player: playerId,
    prompt: p,
    respond: (ids) => {
      assertIds(ids, options, count, count);
      let selected = 0n;
      for (const id of ids) selected |= BigInt(id);
      if ((selected & ~available) !== 0n || popcount(selected) !== count) fail("invalid announced bits");
      if (race) return { type: OcgResponseType.ANNOUNCE_RACE, races: ids.map((id) => BigInt(id) as OcgRace) };
      return { type: OcgResponseType.ANNOUNCE_ATTRIB, attributes: ids.map(Number) as OcgAttribute[] };
    },
  };
}

function popcount(value: bigint): number {
  let n = value;
  let count = 0;
  while (n) {
    n &= n - 1n;
    count++;
  }
  return count;
}

/** Evaluate the core's RPN card-declaration filter without accepting an
 * arbitrary code from the caller.  The wasm helper in older package builds
 * has treated ISATTRIBUTE as a code test, so keep this small validator local
 * to the prompt boundary. */
function cardMatchesOpcodes(card: OcgCardData, opcodes: bigint[]): boolean {
  const stack: bigint[] = [];
  let allowAliases = false;
  let allowTokens = false;
  const popBinary = (operation: (lhs: bigint, rhs: bigint) => bigint) => {
    if (stack.length < 2) return;
    const rhs = stack.pop()!;
    const lhs = stack.pop()!;
    stack.push(BigInt.asIntN(64, operation(lhs, rhs)));
  };
  const popUnary = (operation: (value: bigint) => bigint) => {
    if (stack.length < 1) return;
    stack.push(BigInt.asIntN(64, operation(stack.pop()!)));
  };
  for (const opcode of opcodes) {
    if (opcode === OcgOpCode.ADD) popBinary((lhs, rhs) => lhs + rhs);
    else if (opcode === OcgOpCode.SUB) popBinary((lhs, rhs) => lhs - rhs);
    else if (opcode === OcgOpCode.MUL) popBinary((lhs, rhs) => lhs * rhs);
    else if (opcode === OcgOpCode.DIV) popBinary((lhs, rhs) => rhs === 0n ? 0n : lhs / rhs);
    else if (opcode === OcgOpCode.AND) popBinary((lhs, rhs) => lhs !== 0n && rhs !== 0n ? 1n : 0n);
    else if (opcode === OcgOpCode.OR) popBinary((lhs, rhs) => lhs !== 0n || rhs !== 0n ? 1n : 0n);
    else if (opcode === OcgOpCode.NEG) popUnary((value) => -value);
    else if (opcode === OcgOpCode.NOT) popUnary((value) => value === 0n ? 1n : 0n);
    else if (opcode === OcgOpCode.BAND) popBinary((lhs, rhs) => lhs & rhs);
    else if (opcode === OcgOpCode.BOR) popBinary((lhs, rhs) => lhs | rhs);
    else if (opcode === OcgOpCode.BNOT) popUnary((value) => ~value);
    else if (opcode === OcgOpCode.BXOR) popBinary((lhs, rhs) => lhs ^ rhs);
    else if (opcode === OcgOpCode.LSHIFT) popBinary((lhs, rhs) => lhs << rhs);
    else if (opcode === OcgOpCode.RSHIFT) popBinary((lhs, rhs) => lhs >> rhs);
    else if (opcode === OcgOpCode.ALLOW_ALIASES) allowAliases = true;
    else if (opcode === OcgOpCode.ALLOW_TOKENS) allowTokens = true;
    else if (opcode === OcgOpCode.ISCODE) popUnary((value) => BigInt(card.code) === value ? 1n : 0n);
    else if (opcode === OcgOpCode.ISSETCARD) popUnary((value) => {
      const setCode = Number(value) & 0xffff;
      const setType = setCode & 0xfff;
      const setSubtype = setCode & 0xf000;
      return card.setcodes.some((candidate) => {
        const candidateType = candidate & 0xfff;
        const candidateSubtype = candidate & 0xf000;
        return candidateType === setType && (candidateSubtype & setSubtype) === setSubtype;
      }) ? 1n : 0n;
    });
    else if (opcode === OcgOpCode.ISTYPE) popUnary((value) => (BigInt(card.type) & value) !== 0n ? 1n : 0n);
    else if (opcode === OcgOpCode.ISRACE) popUnary((value) => (card.race & value) !== 0n ? 1n : 0n);
    else if (opcode === OcgOpCode.ISATTRIBUTE) popUnary((value) => (BigInt(card.attribute) & value) !== 0n ? 1n : 0n);
    else if (opcode === OcgOpCode.GETCODE) stack.push(BigInt(card.code));
    else if (opcode === OcgOpCode.GETSETCARD) {
      // Deprecated by the core; it has no useful card-specific value.
      stack.push(0n);
    } else if (opcode === OcgOpCode.GETTYPE) stack.push(BigInt(card.type));
    else if (opcode === OcgOpCode.GETRACE) stack.push(card.race);
    else if (opcode === OcgOpCode.GETATTRIBUTE) stack.push(BigInt(card.attribute));
    else stack.push(opcode);
  }
  if (stack.length !== 1 || stack[0] === 0n) return false;
  return card.code === 78734254 || card.code === 13857930 ||
    ((allowAliases || !card.alias) && (allowTokens || (card.type & (1 | 0x4000)) !== (1 | 0x4000)));
}

function announceCardPrompt(message: { player: number; opcodes: bigint[] }, context: PromptContext): TranslatedPrompt | undefined {
  const playerId = player(message.player);
  if (playerId === undefined) return undefined;
  const options: PromptOption[] = [];
  for (const raw of context.db.raw.values()) {
    let matches = false;
    try {
      matches = cardMatchesOpcodes(toOcgCard(raw), message.opcodes);
    } catch {
      matches = false;
    }
    if (matches) options.push(option(String(raw.code), context.db.name(raw.code)));
  }
  const p = prompt(context, "announce", "Announce a card.", options, 1, 1);
  return {
    player: playerId,
    prompt: p,
    respond: (ids) => {
      assertIds(ids, options, 1, 1);
      const code = Number(ids[0]);
      if (!Number.isSafeInteger(code) || !context.db.get(code)) fail("unknown announced card");
      return { type: OcgResponseType.ANNOUNCE_CARD, card: code };
    },
  };
}

function sortPrompt(
  message: { player: number; cards: OcgCardLoc[] },
  context: PromptContext,
  chain: boolean,
): TranslatedPrompt | undefined {
  const playerId = player(message.player);
  if (playerId === undefined) return undefined;
  const options = message.cards.map((loc, index) => {
    const rendered = cardLabel(context, loc, playerId);
    return option(String(index), rendered.label, rendered.card);
  });
  options.push(option("keep", "Keep current order"));
  const p = prompt(context, "select_card", `Choose the ${chain ? "chain" : "card"} order.`, options, message.cards.length, message.cards.length);
  p.constraints = { kind: "count", cancel: "keep" };
  return {
    player: playerId,
    prompt: p,
    respond: (ids) => {
      if (ids.length === 1 && ids[0] === "keep") return { type: OcgResponseType.SORT_CARD, order: null };
      assertIds(ids, options.filter((o) => o.id !== "keep"), message.cards.length, message.cards.length);
      // The client enumerates cards in the desired new order, while core
      // expects one destination rank for each card in its original order.
      const order = new Array<number>(message.cards.length);
      ids.forEach((id, rank) => { order[Number(id)] = rank; });
      return { type: OcgResponseType.SORT_CARD, order };
    },
  };
}

function unselectPrompt(
  message: {
    player: number;
    can_finish: boolean;
    can_cancel: boolean;
    select_cards: OcgCardLocPos[];
    unselect_cards: OcgCardLocPos[];
  },
  context: PromptContext,
): TranslatedPrompt | undefined {
  const playerId = player(message.player);
  if (playerId === undefined) return undefined;
  const options: PromptOption[] = [];
  const actions = new Map<string, number | null>();
  message.select_cards.forEach((loc, index) => {
    const rendered = cardLabel(context, loc, playerId, "select");
    const id = `select:${index}`;
    options.push(option(id, rendered.label, rendered.card));
    actions.set(id, index);
  });
  message.unselect_cards.forEach((loc, index) => {
    const rendered = cardLabel(context, loc, playerId, "unselect");
    const id = `unselect:${index}`;
    options.push(option(id, rendered.label, rendered.card));
    actions.set(id, message.select_cards.length + index);
  });
  if (message.can_finish) { options.push(option("finish", "Finish selection")); actions.set("finish", null); }
  if (message.can_cancel) { options.push(option("cancel", "Cancel selection")); actions.set("cancel", null); }
  const p = prompt(context, "select_card", "Select or unselect a card.", options, 1, 1);
  p.constraints = {
    kind: "interactive",
    actions: Object.fromEntries(options.map((o) => [o.id, o.id.startsWith("select:") ? "select" : o.id.startsWith("unselect:") ? "unselect" : o.id === "finish" ? "finish" : "cancel"])),
  };
  return {
    player: playerId,
    prompt: p,
    respond: (ids) => {
      assertIds(ids, options, 1, 1);
      if (!actions.has(ids[0]!)) fail(`unknown card action ${ids[0]}`);
      return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: actions.get(ids[0]!)! };
    },
  };
}

function idlePrompt(message: Extract<OcgMessage, { type: OcgMessageType.SELECT_IDLECMD }>, context: PromptContext): TranslatedPrompt | undefined {
  const playerId = player(message.player);
  if (playerId === undefined) return undefined;
  const options: PromptOption[] = [];
  const actions = new Map<string, { action: number; index: number }>();
  const cards = [...message.summons, ...message.special_summons, ...message.pos_changes, ...message.monster_sets, ...message.spell_sets, ...message.activates];
  const addCards = (prefix: string, choices: OcgCardLoc[], action: number, verb: string) => {
    choices.forEach((loc, index) => {
      const rendered = actionCardLabel(context, loc, cards, playerId);
      const id = `${prefix}:${index}`;
      let label = `${verb} ${rendered.label}`;
      if (action === IDLE.position) {
        const current = "position" in loc ? Number(loc.position) : rendered.card.position === "atk" ? OcgPosition.FACEUP_ATTACK : OcgPosition.FACEUP_DEFENSE;
        label = positionAction(rendered.label, current & 3 ? OcgPosition.FACEUP_DEFENSE : OcgPosition.FACEUP_ATTACK);
      } else if (action === IDLE.activate) {
        const effect = rendered.card.code ? textForDescription(context, (loc as OcgCardLocActive).description, rendered.card.code) : undefined;
        if (effect) label += `: ${effect}`;
      }
      options.push(option(id, label, rendered.card));
      actions.set(id, { action, index });
    });
  };
  addCards("summon", message.summons, IDLE.summon, "Normal Summon");
  addCards("special_summon", message.special_summons, IDLE.specialSummon, "Special Summon");
  addCards("position", message.pos_changes, IDLE.position, "Change");
  addCards("monster_set", message.monster_sets, IDLE.monsterSet, "Set");
  addCards("spell_set", message.spell_sets, IDLE.spellSet, "Set");
  addCards("activate", message.activates, IDLE.activate, "Activate");
  if (message.to_bp) { options.push(option("to_bp", "Go to Battle Phase")); actions.set("to_bp", { action: IDLE.battle, index: 0 }); }
  if (message.to_ep) { options.push(option("to_ep", "Go to End Phase")); actions.set("to_ep", { action: IDLE.end, index: 0 }); }
  if (message.shuffle) { options.push(option("shuffle", "Shuffle hand")); actions.set("shuffle", { action: IDLE.shuffle, index: 0 }); }
  const p = prompt(context, "idle", "Choose a main-phase action.", options, 1, 1);
  return {
    player: playerId,
    prompt: p,
    respond: (ids) => {
      assertIds(ids, options, 1, 1);
      const action = actions.get(ids[0]!);
      if (!action) fail(`unknown idle action ${ids[0]}`);
      const picked = action!;
      return { type: OcgResponseType.SELECT_IDLECMD, action: picked.action, index: picked.index };
    },
  };
}

function battlePrompt(message: Extract<OcgMessage, { type: OcgMessageType.SELECT_BATTLECMD }>, context: PromptContext): TranslatedPrompt | undefined {
  const playerId = player(message.player);
  if (playerId === undefined) return undefined;
  const options: PromptOption[] = [];
  const actions = new Map<string, { action: number; index: number }>();
  activeOptions(context, message.chains, playerId, "Activate", [...message.chains, ...message.attacks]).forEach((o, index) => {
    const id = `activate:${index}`;
    options.push({ ...o, id });
    actions.set(id, { action: BATTLE.activate, index });
  });
  message.attacks.forEach((loc, index) => {
    const rendered = actionCardLabel(context, loc, [...message.chains, ...message.attacks], playerId);
    const id = `attack:${index}`;
    options.push(option(id, `${loc.can_direct ? "Direct attack" : "Attack"} with ${rendered.label}`, rendered.card));
    actions.set(id, { action: BATTLE.attack, index });
  });
  if (message.to_m2) { options.push(option("to_m2", "Go to Main Phase 2")); actions.set("to_m2", { action: BATTLE.main2, index: 0 }); }
  if (message.to_ep) { options.push(option("to_ep", "Go to End Phase")); actions.set("to_ep", { action: BATTLE.end, index: 0 }); }
  const p = prompt(context, "battle_idle", "Choose a battle-phase action.", options, 1, 1);
  return {
    player: playerId,
    prompt: p,
    respond: (ids) => {
      assertIds(ids, options, 1, 1);
      const action = actions.get(ids[0]!);
      if (!action) fail(`unknown battle action ${ids[0]}`);
      const picked = action!;
      return { type: OcgResponseType.SELECT_BATTLECMD, action: picked.action, index: picked.index };
    },
  };
}

/** Convert one ocgcore decision message into the public, enumerable prompt model. */
export function translatePrompt(message: OcgMessage, context: PromptContext): TranslatedPrompt | undefined {
  switch (message.type) {
    case OcgMessageType.SELECT_IDLECMD:
      return idlePrompt(message, context);
    case OcgMessageType.SELECT_BATTLECMD:
      return battlePrompt(message, context);
    case OcgMessageType.SELECT_EFFECTYN: {
      const playerId = player(message.player);
      if (playerId === undefined) return undefined;
      const rendered = cardLabel(context, message, playerId);
      const options = [option("yes", "Yes", rendered.card), option("no", "No", rendered.card)];
      const p = prompt(context, "select_effect_yn", `${rendered.label}: ${rendered.card.code ? descriptionLabel(context, message.description, rendered.card.code) : "Effect"}`, options);
      return { player: playerId, prompt: p, respond: (ids) => {
        assertIds(ids, options, 1, 1);
        return { type: OcgResponseType.SELECT_EFFECTYN, yes: ids[0] === "yes" };
      } };
    }
    case OcgMessageType.SELECT_YESNO: {
      const playerId = player(message.player);
      if (playerId === undefined) return undefined;
      const target = message as typeof message & Partial<OcgCardLoc> & { card?: OcgCardLoc };
      const loc = target.card ?? (target.code !== undefined && target.controller !== undefined && target.location !== undefined && target.sequence !== undefined ? target as OcgCardLoc : undefined);
      const rendered = loc ? cardLabel(context, loc, playerId) : undefined;
      const options = [option("yes", "Yes", rendered?.card), option("no", "No", rendered?.card)];
      const description = rendered
        ? rendered.card.code ? descriptionLabel(context, message.description, rendered.card.code) : "Effect"
        : descriptionLabel(context, message.description);
      const p = prompt(context, "select_yesno", rendered ? `${rendered.label}: ${description}` : description, options);
      return { player: playerId, prompt: p, respond: (ids) => {
        assertIds(ids, options, 1, 1);
        return { type: OcgResponseType.SELECT_YESNO, yes: ids[0] === "yes" };
      } };
    }
    case OcgMessageType.SELECT_OPTION: {
      const playerId = player(message.player);
      if (playerId === undefined) return undefined;
      const options = message.options.map((description, index) => option(String(index), `Use effect ${index + 1}: ${descriptionLabel(context, description)}`));
      const p = prompt(context, "select_option", "Choose an option.", options);
      return { player: playerId, prompt: p, respond: (ids) => {
        assertIds(ids, options, 1, 1);
        return { type: OcgResponseType.SELECT_OPTION, index: Number(ids[0]) };
      } };
    }
    case OcgMessageType.SELECT_CARD:
      { const playerId = player(message.player); return playerId === undefined ? undefined : boundedCardSelection(message, context, playerId); }
    case OcgMessageType.SELECT_CHAIN: {
      const playerId = player(message.player);
      if (playerId === undefined) return undefined;
      const options = activeOptions(context, message.selects, playerId, "Chain");
      if (!message.forced) options.push(option("pass", "Do not activate / pass"));
      const p = prompt(context, "select_chain", "Choose a chain response.", options);
      return { player: playerId, prompt: p, respond: (ids) => {
        assertIds(ids, options, 1, 1);
        if (ids[0] === "pass") return { type: OcgResponseType.SELECT_CHAIN, index: null };
        return { type: OcgResponseType.SELECT_CHAIN, index: Number(ids[0]) };
      } };
    }
    case OcgMessageType.SELECT_PLACE:
      return placePrompt(message, context, OcgResponseType.SELECT_PLACE, `Choose ${message.count} field place(s).`);
    case OcgMessageType.SELECT_DISFIELD:
      return placePrompt(message, context, OcgResponseType.SELECT_DISFIELD, `Choose ${message.count} field place(s) to disable.`);
    case OcgMessageType.SELECT_POSITION: {
      const playerId = player(message.player);
      if (playerId === undefined) return undefined;
      const allowed = (message.positions & 0xf) || OcgPosition.FACEUP_ATTACK;
      const positions = [OcgPosition.FACEUP_ATTACK, OcgPosition.FACEDOWN_ATTACK, OcgPosition.FACEUP_DEFENSE, OcgPosition.FACEDOWN_DEFENSE]
        .filter((position) => (allowed & position) !== 0);
      const card = context.cardByCode?.(message.code);
      const name = card?.code ? context.db.name(card.code) : card
        ? hiddenCardLabel(card, context.viewer === undefined ? "Selected " : `${controllerLabel(card.controller, context.viewer)} `)
        : "the selected card";
      const options = positions.map((position) => option(String(position), positionAction(name, position), card));
      const p = prompt(context, "select_position", `Choose a position for ${name}.`, options);
      return { player: playerId, prompt: p, respond: (ids) => {
        assertIds(ids, options, 1, 1);
        return { type: OcgResponseType.SELECT_POSITION, position: Number(ids[0]) as OcgPosition };
      } };
    }
    case OcgMessageType.SELECT_TRIBUTE:
      return tributePrompt(message, context);
    case OcgMessageType.SELECT_COUNTER:
      return counterPrompt(message, context);
    case OcgMessageType.SELECT_SUM:
      return sumPrompt(message, context);
    case OcgMessageType.SELECT_UNSELECT_CARD:
      return unselectPrompt(message, context);
    case OcgMessageType.SORT_CARD:
      return sortPrompt(message, context, false);
    case OcgMessageType.SORT_CHAIN:
      return sortPrompt(message, context, true);
    case OcgMessageType.ANNOUNCE_RACE:
      return bitsPrompt(message, context, true);
    case OcgMessageType.ANNOUNCE_ATTRIB:
      return bitsPrompt(message, context, false);
    case OcgMessageType.ANNOUNCE_CARD:
      return announceCardPrompt(message, context);
    case OcgMessageType.ANNOUNCE_NUMBER: {
      const playerId = player(message.player);
      if (playerId === undefined) return undefined;
      const options = message.options.map((value, index) => option(String(index), `Declare ${value.toString()}`));
      const p = prompt(context, "announce", "Announce a number.", options);
      return { player: playerId, prompt: p, respond: (ids) => {
        assertIds(ids, options, 1, 1);
        return { type: OcgResponseType.ANNOUNCE_NUMBER, value: Number(ids[0]) };
      } };
    }
    case OcgMessageType.ROCK_PAPER_SCISSORS: {
      const playerId = player(message.player);
      if (playerId === undefined) return undefined;
      const options = [option("1", "Scissors"), option("2", "Rock"), option("3", "Paper")];
      const p = prompt(context, "rps", "Choose rock, paper, or scissors.", options);
      return { player: playerId, prompt: p, respond: (ids) => {
        assertIds(ids, options, 1, 1);
        return { type: OcgResponseType.ROCK_PAPER_SCISSORS, value: Number(ids[0]) as 1 | 2 | 3 };
      } };
    }
    default:
      return undefined;
  }
}
