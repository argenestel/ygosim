// Offline demo "server": a tiny scripted duel that exercises every animation
// and prompt type so the client is demoable without the engine (?mock=1).
import type { Action, CardRef, ClientMsg, DuelEvent, DuelState, Location, PlayerIdx, Prompt, PromptOption, ServerMsg } from "@ygosim/protocol";
import type { Conn } from "./net";
import { MOCK_CARDS, MOCK_DECK } from "./mockCards";

const name = (c: CardRef) => (c.code && MOCK_CARDS[c.code]?.name) || "a card";
const isMonster = (c: CardRef) => !!c.code && MOCK_CARDS[c.code]?.type.includes("Monster");
const stat = (c: CardRef) => (c.code ? MOCK_CARDS[c.code] : undefined);

export function createMockConn(onMsg: (m: ServerMsg) => void): Conn {
  let cards: CardRef[] = [];
  let lp: [number, number] = [8000, 8000];
  let turn = 0, tp: PlayerIdx = 0;
  let phase: DuelState["phase"] = "draw";
  let ev: DuelEvent[] = [];
  let pid = 0;
  let handler: ((a: Action) => void) | null = null;
  let over = false;
  const attacked = new Set<string>();
  let summoned = false;

  const deckFor = (p: PlayerIdx) => {
    const main = [...MOCK_DECK.main].sort(() => Math.random() - 0.5);
    main.forEach((code, i) => cards.push({ uid: `${p}d${i}`, code, owner: p, controller: p, location: "deck", sequence: i, position: "facedown" }));
    MOCK_DECK.extra.forEach((code, i) => cards.push({ uid: `${p}x${i}`, code, owner: p, controller: p, location: "extra", sequence: i, position: "facedown" }));
  };
  deckFor(0); deckFor(1);

  const at = (p: PlayerIdx, loc: Location) => cards.filter((c) => c.controller === p && c.location === loc).sort((a, b) => a.sequence - b.sequence);
  const freeSeq = (p: PlayerIdx, loc: Location) => { for (let i = 0; i < 5; i++) if (!at(p, loc).some((c) => c.sequence === i)) return i; return -1; };
  const put = (c: CardRef, patch: Partial<CardRef>) => { const from = { location: c.location, sequence: c.sequence }; Object.assign(c, patch); return from; };
  const snapshot = (): DuelState => ({
    duelId: "mock", turn, turnPlayer: tp, phase, lp: [...lp] as [number, number], chain: [], you: 0,
    cards: cards.map((c) => {
      const hidden = c.location === "deck" || (c.controller === 1 && (c.location === "hand" || c.location === "extra" || c.position === "facedown" || c.position === "facedown_def"));
      const s = stat(c);
      return { ...c, code: hidden ? undefined : c.code, atk: hidden ? undefined : s?.atk, def: hidden ? undefined : s?.def, level: hidden ? undefined : s?.level };
    }),
  });
  const redactRef = (c: CardRef) => snapshot().cards.find((x) => x.uid === c.uid)!;
  const flush = (prompt?: Prompt) => {
    onMsg({ type: "events", events: ev, state: snapshot() });
    ev = [];
    if (prompt) onMsg({ type: "prompt", prompt, state: snapshot() });
  };
  const ask = (kind: Prompt["kind"], text: string, options: PromptOption[], h: (a: Action) => void, min = 1, max = 1) => {
    handler = h;
    flush({ promptId: `p${++pid}`, kind, text, options, min, max });
  };

  const draw = (p: PlayerIdx, n: number) => {
    const drawn: CardRef[] = [];
    for (let i = 0; i < n; i++) {
      const top = at(p, "deck").pop(); if (!top) break;
      put(top, { location: "hand", sequence: at(p, "hand").length, position: "faceup" });
      drawn.push(redactRef(top));
    }
    ev.push({ t: "draw", player: p, cards: drawn });
  };
  const toGrave = (c: CardRef, reason: string) => {
    const from = put(c, { location: "grave", sequence: at(c.owner, "grave").length, position: "faceup", controller: c.owner, overlays: undefined });
    ev.push({ t: "move", card: redactRef(c), from, reason });
  };
  const damage = (p: PlayerIdx, n: number) => {
    lp[p] = Math.max(0, lp[p] - n);
    ev.push({ t: "damage", player: p, amount: n, lp: lp[p] });
    if (lp[p] === 0) { over = true; ev.push({ t: "win", winner: (1 - p) as PlayerIdx, reason: "LP reached 0" }); flush(); }
  };
  const setPhase = (ph: DuelState["phase"]) => { phase = ph; ev.push({ t: "phase", phase: ph, turnPlayer: tp }); };

  const specialFromExtra = (p: PlayerIdx, kind: "fusion" | "synchro" | "xyz" | "link", code: number, mats: number) => {
    const ex = at(p, "extra").find((c) => c.code === code);
    const field = at(p, "mzone");
    if (!ex) return;
    for (const m of field.slice(0, mats)) {
      if (kind === "xyz") { put(m, { location: "grave" }); continue; }
      toGrave(m, "material");
    }
    if (kind === "xyz") cards = cards.filter((c) => !(c.location === "grave" && c.controller === p && field.slice(0, mats).includes(c)));
    const emzFree = !cards.some((c) => c.location === "mzone" && c.sequence >= 5);
    const seq = kind === "link" || kind === "xyz" ? (emzFree ? 5 : freeSeq(p, "mzone")) : freeSeq(p, "mzone");
    const from = put(ex, { location: "mzone", sequence: seq, position: "atk", overlays: kind === "xyz" ? field.slice(0, mats).map((m) => ({ ...m, location: "mzone" as Location })) : undefined });
    ev.push({ t: "move", card: redactRef(ex), from, reason: "summon" });
    ev.push({ t: "summon", card: redactRef(ex), kind });
  };
  const summonFromHand = (c: CardRef, kind: "normal" | "set" | "pendulum" | "ritual" | "special") => {
    const seq = freeSeq(c.controller, "mzone"); if (seq < 0) return;
    const from = put(c, { location: "mzone", sequence: seq, position: kind === "set" ? "facedown_def" : "atk" });
    ev.push({ t: "move", card: redactRef(c), from, reason: "summon" });
    ev.push({ t: "summon", card: redactRef(c), kind });
  };
  const fetchToHand = (p: PlayerIdx, code: number) => {
    const c = cards.find((x) => x.controller === p && x.code === code && (x.location === "deck" || x.location === "grave"));
    if (c) { const from = put(c, { location: "hand", sequence: at(p, "hand").length, position: "faceup" }); ev.push({ t: "move", card: redactRef(c), from, reason: "add" }); }
    return c;
  };
  const ensureMats = (n: number) => {
    while (at(0, "mzone").filter((c) => c.sequence < 5).length < n) {
      const c = cards.find((x) => x.controller === 0 && x.location === "deck" && isMonster(x) && (stat(x)?.level ?? 9) <= 4)
        ?? cards.find((x) => x.controller === 0 && x.location === "deck" && isMonster(x));
      if (!c) return;
      summonFromHand(c, "special");
    }
  };

  const idle = () => {
    if (over) return;
    const hand = at(0, "hand");
    const opts: PromptOption[] = [];
    for (const c of hand) {
      const s = stat(c);
      if (s?.type.includes("Monster") && !summoned && !s.type.includes("Ritual") && !s.type.includes("Pendulum")) {
        opts.push({ id: `ns:${c.uid}`, label: `Normal Summon ${s.name}`, card: redactRef(c) });
        opts.push({ id: `set:${c.uid}`, label: `Set ${s.name}`, card: redactRef(c) });
      }
      if (s?.type.includes("Pendulum")) opts.push({ id: `pend:${c.uid}`, label: `Pendulum Summon ${s.name}`, card: redactRef(c) });
      if (s?.type.includes("Ritual")) opts.push({ id: `rit:${c.uid}`, label: `Ritual Summon ${s.name}`, card: redactRef(c) });
      if (s?.type.includes("Spell")) opts.push({ id: `act:${c.uid}`, label: `Activate ${s.name}`, card: redactRef(c) });
      if (s?.type.includes("Trap")) opts.push({ id: `sett:${c.uid}`, label: `Set ${s.name}`, card: redactRef(c) });
    }
    for (const c of at(0, "extra")) opts.push({ id: `ex:${c.uid}`, label: `${stat(c)?.type[1]} Summon ${name(c)}`, card: redactRef(c) });
    for (const c of at(0, "mzone")) if (c.position === "facedown_def") opts.push({ id: `flip:${c.uid}`, label: `Flip Summon ${name(c)}`, card: redactRef(c) });
    if (turn > 1) opts.push({ id: "bp", label: "Enter Battle Phase" });
    opts.push({ id: "end", label: "End Turn" });
    ask("idle", "Main Phase 1 — choose an action", opts, onIdle);
  };

  const onIdle = (a: Action) => {
    const [op, uid] = a.choose[0].split(":");
    const c = cards.find((x) => x.uid === uid)!;
    switch (op) {
      case "ns": summoned = true; summonFromHand(c, "normal"); break;
      case "set": summoned = true; summonFromHand(c, "set"); break;
      case "flip": put(c, { position: "atk" }); ev.push({ t: "pos_change", card: redactRef(c) }); ev.push({ t: "summon", card: redactRef(c), kind: "flip" }); break;
      case "pend": summonFromHand(c, "pendulum"); break;
      case "rit": ensureMats(1); toGrave(at(0, "mzone")[0], "tribute"); summonFromHand(c, "ritual"); break;
      case "sett": { const seq = freeSeq(0, "szone"); const from = put(c, { location: "szone", sequence: seq, position: "facedown" }); ev.push({ t: "move", card: redactRef(c), from, reason: "set" }); break; }
      case "act": return activateSpell(c);
      case "ex": {
        const kind = stat(c)!.type[1].toLowerCase() as "fusion" | "synchro" | "xyz" | "link";
        const mats = kind === "fusion" ? 3 : kind === "link" ? 2 : 2;
        ensureMats(mats); specialFromExtra(0, kind, c.code!, mats); break;
      }
      case "bp": return battle();
      case "end": return endTurn();
    }
    idle();
  };

  const activateSpell = (c: CardRef) => {
    const seq = freeSeq(0, "szone");
    const from = put(c, { location: "szone", sequence: seq, position: "faceup" });
    ev.push({ t: "move", card: redactRef(c), from, reason: "activate" });
    ev.push({ t: "activate", card: redactRef(c), chainLink: 1 });
    const s = stat(c)!;
    const resolve = () => {
      ev.push({ t: "chain_solved", chainLink: 1 });
      toGrave(c, "resolve");
      idle();
    };
    if (s.name === "Pot of Greed") { flushWith(() => { draw(0, 2); resolve(); }); return; }
    if (s.name === "Monster Reborn") {
      const gy = cards.filter((x) => x.location === "grave" && isMonster(x));
      if (!gy.length) { resolve(); return; }
      ask("select_card", "Monster Reborn: choose a monster in either GY to Special Summon", gy.map((g) => ({ id: g.uid, label: `${name(g)} (${g.controller === 0 ? "your" : "opp"} GY)`, card: redactRef(g) })), (a) => {
        const t = cards.find((x) => x.uid === a.choose[0])!;
        put(t, { controller: 0 }); summonFromHand(t, "special"); resolve();
      });
      return;
    }
    if (s.name === "Mystical Space Typhoon") {
      const t = at(1, "szone")[0];
      if (t) toGrave(t, "destroy");
      resolve(); return;
    }
    if (s.name === "Polymerization") { ensureMats(3); specialFromExtra(0, "fusion", 23995346, 3); resolve(); return; }
    resolve();
  };
  const flushWith = (fn: () => void) => fn();

  const battle = () => {
    setPhase("battle");
    const atkers = at(0, "mzone").filter((c) => c.position === "atk" && !attacked.has(c.uid));
    const opts: PromptOption[] = atkers.map((c) => ({ id: `atk:${c.uid}`, label: `Attack with ${name(c)} (${stat(c)?.atk})`, card: redactRef(c) }));
    opts.push({ id: "m2", label: "Go to Main Phase 2 / End" });
    ask("battle_idle", "Battle Phase — choose an attacker", opts, (a) => {
      if (a.choose[0] === "m2") { setPhase("main2"); return idle(); }
      const atk = cards.find((x) => x.uid === a.choose[0].split(":")[1])!;
      const targets = at(1, "mzone");
      const doAttack = (tgtUid?: string) => {
        attacked.add(atk.uid);
        const tgt = tgtUid ? cards.find((x) => x.uid === tgtUid) : undefined;
        ev.push({ t: "attack", attacker: redactRef(atk), target: tgt && redactRef(tgt) });
        const A = stat(atk)?.atk ?? 0;
        if (!tgt) damage(1, A);
        else {
          const wasDown = tgt.position === "facedown_def";
          if (wasDown) { put(tgt, { position: "def" }); ev.push({ t: "pos_change", card: redactRef(tgt) }); }
          const D = tgt.position === "atk" ? stat(tgt)?.atk ?? 0 : stat(tgt)?.def ?? 0;
          if (A > D) { toGrave(tgt, "destroy"); if (tgt.position === "atk") damage(1, A - D); }
          else if (A < D) { if (tgt.position === "atk") toGrave(atk, "destroy"); damage(0, D - A); }
          else if (tgt.position === "atk") { toGrave(tgt, "destroy"); toGrave(atk, "destroy"); }
        }
        battle();
      };
      if (!targets.length) return doAttack();
      ask("select_card", `Choose an attack target for ${name(atk)}`, targets.map((t) => ({ id: t.uid, label: t.code ? name(t) : "Face-down monster", card: redactRef(t) })), (b) => doAttack(b.choose[0]));
    });
  };

  const endTurn = () => {
    setPhase("end");
    opponentTurn();
  };

  const startTurn = (p: PlayerIdx) => {
    turn++; tp = p; summoned = false; attacked.clear();
    ev.push({ t: "new_turn", turn, turnPlayer: p });
    setPhase("draw");
    if (turn > 1) draw(p, 1);
    setPhase("standby"); setPhase("main1");
  };

  const opponentTurn = () => {
    startTurn(1);
    const mon = at(1, "hand").filter(isMonster).sort((a, b) => (stat(b)?.atk ?? 0) - (stat(a)?.atk ?? 0))[0];
    if (mon) summonFromHand(mon, (stat(mon)?.level ?? 4) > 4 ? "special" : "normal");
    const trap = at(1, "hand").find((c) => stat(c)?.type[0] === "Trap");
    if (trap) { const seq = freeSeq(1, "szone"); const from = put(trap, { location: "szone", sequence: seq, position: "facedown" }); ev.push({ t: "move", card: redactRef(trap), from, reason: "set" }); }
    setPhase("battle");
    const atker = at(1, "mzone").find((c) => c.position === "atk");
    const myTrap = at(0, "szone").find((c) => c.position === "facedown" && stat(c)?.name === "Mirror Force");
    const resolveAttack = () => {
      if (!atker || atker.location !== "mzone") return finishOpp();
      const tgt = at(0, "mzone").sort((a, b) => (stat(a)?.atk ?? 0) - (stat(b)?.atk ?? 0))[0];
      ev.push({ t: "attack", attacker: redactRef(atker), target: tgt && redactRef(tgt) });
      const A = stat(atker)?.atk ?? 0;
      if (!tgt) damage(0, A);
      else {
        const D = tgt.position === "atk" ? stat(tgt)?.atk ?? 0 : stat(tgt)?.def ?? 0;
        if (A > D) { toGrave(tgt, "destroy"); if (tgt.position === "atk") damage(0, A - D); }
        else if (A < D) { toGrave(atker, "destroy"); if (tgt.position === "atk") damage(1, D - A); }
      }
      if (!over) finishOpp();
    };
    if (atker && myTrap) {
      ask("select_effect_yn", `${name(atker)} declares an attack. Activate Mirror Force?`, [{ id: "yes", label: "Yes, activate", card: redactRef(myTrap) }, { id: "no", label: "No" }], (a) => {
        if (a.choose[0] === "yes") {
          put(myTrap, { position: "faceup" });
          ev.push({ t: "activate", card: redactRef(myTrap), chainLink: 1 });
          for (const m of at(1, "mzone").filter((c) => c.position === "atk")) toGrave(m, "destroy");
          ev.push({ t: "chain_solved", chainLink: 1 });
          toGrave(myTrap, "resolve");
          return finishOpp();
        }
        resolveAttack();
      });
      return;
    }
    resolveAttack();
  };
  const finishOpp = () => { setPhase("end"); startTurn(0); idle(); };

  const start = () => {
    onMsg({ type: "room", roomId: "DEMO", players: ["You", "Demo Bot"], status: "dueling" });
    ask("rps", "Rock, paper, scissors!", [{ id: "r", label: "✊ Rock" }, { id: "p", label: "✋ Paper" }, { id: "s", label: "✌ Scissors" }], () => {
      ask("first_turn", "You won! Go first or second?", [{ id: "first", label: "Go first" }, { id: "second", label: "Go second" }], () => {
        draw(0, 5); draw(1, 5);
        fetchToHand(0, 89631139);
        startTurn(0);
        idle();
      });
    });
  };

  setTimeout(() => onMsg({ type: "welcome", clientId: "mock" }), 0);
  return {
    send(m: ClientMsg) {
      if (m.type === "create_room" || m.type === "join_room") setTimeout(start, 150);
      if (m.type === "action" && handler) { const h = handler; handler = null; setTimeout(() => h(m.action), 0); }
      if (m.type === "surrender") { over = true; ev.push({ t: "win", winner: 1, reason: "surrender" }); flush(); }
      if (m.type === "chat") onMsg({ type: "chat", from: "You", text: m.text });
    },
    close() { over = true; },
  };
}
