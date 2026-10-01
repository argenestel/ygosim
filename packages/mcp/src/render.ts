import type { CardRef, DuelEvent, DuelState, Location, PlayerIdx, Prompt } from "@ygosim/protocol";
import type { CardCache } from "./cards.js";

export function collectCodes(state?: DuelState | null, events: DuelEvent[] = [], prompt?: Prompt | null): number[] {
  const out: number[] = [];
  const add = (c?: CardRef) => { if (c) { if (c.code !== undefined) out.push(c.code); c.overlays?.forEach(add); } };
  state?.cards.forEach(add);
  state?.chain.forEach((l) => add(l.card));
  for (const e of events) {
    if ("card" in e) add(e.card);
    if (e.t === "draw") e.cards.forEach(add);
    if (e.t === "attack") { add(e.attacker); add(e.target); }
  }
  prompt?.options.forEach((o) => add(o.card));
  return out.filter((c) => c !== undefined);
}

export function cardName(c: CardRef | undefined, cards: CardCache): string {
  if (!c) return "?";
  if (c.code === undefined) return "(face-down)";
  return cards.nameSync(c.code) ?? `Unknown card (#${c.code})`;
}

const who = (p: PlayerIdx, you: PlayerIdx) => (p === you ? "You" : "Opp");
const POS: Record<CardRef["position"], string> = { atk: "ATK", def: "DEF", facedown_def: "SET-DEF", facedown: "SET", faceup: "UP" };

function stats(c: CardRef): string {
  const s: string[] = [];
  if (c.atk !== undefined || c.def !== undefined) s.push(`${c.atk ?? "?"}/${c.def ?? "?"}`);
  if (c.level) s.push(`L${c.level}`);
  if (c.overlays?.length) s.push(`${c.overlays.length} mat`);
  if (c.counters) for (const [k, v] of Object.entries(c.counters)) s.push(`${k}:${v}`);
  return s.join(" ");
}

function sideBlock(st: DuelState, p: PlayerIdx, cards: CardCache): string[] {
  const mine = st.cards.filter((c) => c.controller === p);
  const at = (l: Location) => mine.filter((c) => c.location === l).sort((a, b) => a.sequence - b.sequence);
  const lines: string[] = [];
  const label = p === st.you ? "YOU" : "OPPONENT";
  lines.push(`== ${label} (P${p}) LP ${st.lp[p]} | hand ${at("hand").length} | deck ${at("deck").length} | extra ${at("extra").length} | GY ${at("grave").length} | banished ${at("banished").length}`);
  const field = [...at("mzone"), ...at("emzone"), ...at("szone"), ...at("fzone"), ...at("pzone")];
  if (field.length) {
    lines.push("  zone   | card                         | pos     | stats");
    for (const c of field) {
      const z = { mzone: "M", emzone: "EMZ", szone: "S", fzone: "Field", pzone: "P" }[c.location as string] + (c.location === "fzone" ? "" : String(c.sequence + 1));
      lines.push(`  ${z.padEnd(6)} | ${cardName(c, cards).padEnd(28)} | ${POS[c.position].padEnd(7)} | ${stats(c)}`);
    }
  } else lines.push("  (no cards on field)");
  const hand = at("hand");
  if (p === st.you && hand.length) lines.push(`  Hand: ${hand.map((c) => cardName(c, cards)).join("; ")}`);
  const gy = at("grave");
  if (gy.length) lines.push(`  GY: ${gy.map((c) => cardName(c, cards)).join("; ")}`);
  const ban = at("banished");
  if (ban.length) lines.push(`  Banished: ${ban.map((c) => cardName(c, cards)).join("; ")}`);
  return lines;
}

export function renderState(st: DuelState, cards: CardCache): string {
  const opp = (1 - st.you) as PlayerIdx;
  const lines = [`Turn ${st.turn} | ${st.turnPlayer === st.you ? "YOUR" : "OPP'S"} turn | phase ${st.phase} | LP you ${st.lp[st.you]} vs opp ${st.lp[opp]}`];
  lines.push(...sideBlock(st, opp, cards), ...sideBlock(st, st.you, cards));
  if (st.chain.length) {
    lines.push("Chain:");
    st.chain.forEach((l, i) => lines.push(`  CL${i + 1}: ${cardName(l.card, cards)} (${who(l.card.controller, st.you)}) - ${l.desc}`));
  }
  return lines.join("\n");
}

export function renderEvent(e: DuelEvent, you: PlayerIdx, cards: CardCache): string | null {
  const n = (c?: CardRef) => cardName(c, cards);
  switch (e.t) {
    case "draw": return `${who(e.player, you)} drew ${e.cards.length}${e.player === you ? `: ${e.cards.map(n).join("; ")}` : ""}`;
    case "move": return `${n(e.card)} (${who(e.card.controller, you)}) ${e.from.location ?? "?"} -> ${e.card.location}${e.reason ? ` [${e.reason}]` : ""}`;
    case "summon": return `${who(e.card.controller, you)} ${e.kind} summoned ${n(e.card)}`;
    case "activate": return `${who(e.card.controller, you)} activated ${n(e.card)} (CL${e.chainLink})`;
    case "chain_solved": return `CL${e.chainLink} resolved`;
    case "attack": return `${n(e.attacker)} (${who(e.attacker.controller, you)}) attacks ${e.target ? n(e.target) : "directly"}`;
    case "damage": return `${who(e.player, you)} took ${e.amount} damage -> LP ${e.lp}`;
    case "recover": return `${who(e.player, you)} gained ${e.amount} LP -> ${e.lp}`;
    case "phase": return null; // shown in header; too noisy
    case "new_turn": return `--- Turn ${e.turn} (${who(e.turnPlayer, you)}) ---`;
    case "shuffle": return null;
    case "pos_change": return `${n(e.card)} changed to ${POS[e.card.position]}`;
    case "win": return `DUEL OVER: ${e.winner === null ? "draw" : e.winner === you ? "YOU WIN" : "YOU LOSE"} (${e.reason})`;
    case "hint": return `hint: ${e.text}`;
  }
}

export function renderEvents(events: DuelEvent[], you: PlayerIdx, cards: CardCache, max = 40): string {
  const lines = events.map((e) => renderEvent(e, you, cards)).filter((l): l is string => !!l);
  const skipped = lines.length > max ? lines.length - max : 0;
  return [...(skipped ? [`(${skipped} earlier events omitted)`] : []), ...lines.slice(-max)].join("\n");
}

export function renderPrompt(p: Prompt, cards: CardCache): string {
  const lines = [`PROMPT [${p.kind}] ${p.text} (promptId: ${p.promptId})`];
  if (p.min !== undefined || p.max !== undefined) lines.push(`Choose ${p.min ?? 1}..${p.max ?? 1} option(s). Numbers are 1-based; quoted strings are exact ids.`);
  for (const [i, o] of p.options.entries()) {
    let label = o.label;
    if (o.card) {
      const name = cardName(o.card, cards);
      if (!label.includes(name)) label += ` — ${name}`;
      if (o.card.location) label += ` @${o.card.location}`;
    }
    lines.push(`  ${i + 1}. ${label} [id: ${JSON.stringify(o.id)}]`);
  }
  return lines.join("\n");
}
