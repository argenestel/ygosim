import { useCallback, useEffect, useReducer, useRef } from "react";
import type { CardRef, ClientMsg, DuelEvent, DuelState, Prompt, ServerMsg } from "@ygosim/protocol";
import type { Conn } from "../net";
import { playEvent } from "../sfx";

export interface Fx { id: number; ev: DuelEvent; }

export interface View {
  roomId?: string;
  roomStatus?: string;
  players: string[];
  format?: string;
  match?: string;
  score?: [number, number];
  game?: number;
  state?: DuelState;          // what is currently drawn (mid-animation)
  prompt?: Prompt;            // revealed only once animations catch up
  fx: Fx[];
  banner?: { id: number; text: string; sub?: string };
  shake: number;
  result?: { winner: number | null; reason: string };
  chat: { from: string; text: string }[];
  agents: Partial<Record<number, { agent: string; status: string; detail?: string }>>;
  error?: string;
  fatalError?: string;
  busy: boolean;              // animations playing
}

type Act =
  | { k: "set"; patch: Partial<View> }
  | { k: "state"; fn: (s: DuelState) => DuelState }
  | { k: "fx+"; fx: Fx } | { k: "fx-"; id: number }
  | { k: "chat"; from: string; text: string }
  | { k: "agent"; seat: number; info: { agent: string; status: string; detail?: string } };

function reducer(v: View, a: Act): View {
  switch (a.k) {
    case "set": return { ...v, ...a.patch };
    case "state": return v.state ? { ...v, state: a.fn(v.state) } : v;
    case "fx+": return { ...v, fx: [...v.fx, a.fx] };
    case "fx-": return { ...v, fx: v.fx.filter((f) => f.id !== a.id) };
    case "chat": return { ...v, chat: [...v.chat.slice(-50), { from: a.from, text: a.text }] };
    case "agent": return { ...v, agents: { ...v.agents, [a.seat]: a.info } };
  }
}

const upsert = (cards: CardRef[], c: CardRef) => {
  const i = cards.findIndex((x) => x.uid === c.uid);
  if (i < 0) return [...cards, c];
  const next = cards.slice();
  next[i] = { ...cards[i], ...c };
  return next;
};

/** Pure event application used to step the visual state between server snapshots. */
export function applyEvent(s: DuelState, e: DuelEvent): DuelState {
  switch (e.t) {
    case "draw": return { ...s, cards: e.cards.reduce(upsert, s.cards) };
    case "move": case "summon": case "pos_change": return { ...s, cards: upsert(s.cards, e.card) };
    case "damage": case "recover": case "pay_lp": {
      const lp = [...s.lp] as [number, number]; lp[e.player] = e.lp; return { ...s, lp };
    }
    case "phase": return { ...s, phase: e.phase, turnPlayer: e.turnPlayer };
    case "new_turn": return { ...s, turn: e.turn, turnPlayer: e.turnPlayer };
    case "activate": return { ...s, chain: [...s.chain, { card: e.card, desc: "" }] };
    case "chain_solved": return { ...s, chain: s.chain.slice(0, Math.max(0, e.chainLink - 1)) };
    default: return s;
  }
}

const SPECIAL = new Set(["fusion", "synchro", "xyz", "pendulum", "link", "ritual", "special"]);

/** Base duration (ms) the queue waits on each event. */
export function durationOf(e: DuelEvent): number {
  switch (e.t) {
    case "draw": return 380;
    case "move": return e.reason === "destroy" ? 750 : 480;
    case "summon": return SPECIAL.has(e.kind) && e.kind !== "special" ? 1500 : e.kind === "special" ? 900 : 700;
    case "activate": return 950;
    case "chain_solved": return 320;
    case "attack": return 950;
    case "damage": return 900;
    case "recover": return 700;
    case "pay_lp": return 550;
    case "phase": return 650;
    case "new_turn": return 1300;
    case "shuffle": return 450;
    case "pos_change": return 450;
    case "hint": return 0;
    case "win": return 0;
  }
}

export function useDuel(open: (onMsg: (m: ServerMsg) => void, onClose: (why: string) => void) => Conn) {
  const [view, dispatch] = useReducer(reducer, { players: [], fx: [], shake: 0, chat: [], busy: false, agents: {} });
  const conn = useRef<Conn | null>(null);
  const queue = useRef<{ events: DuelEvent[]; state: DuelState; prompt?: Prompt }[]>([]);
  const running = useRef(false);
  const speed = useRef(1);
  const fxId = useRef(1);
  const stateRef = useRef<DuelState | undefined>(undefined);
  const gameRef = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const timers = useRef(new Map<ReturnType<typeof setTimeout>, () => void>());
  const pendingResponse = useRef<Prompt | undefined>(undefined);
  const currentPrompt = useRef<Prompt | undefined>(undefined);
  currentPrompt.current = view.prompt;
  const halt = useCallback(() => {
    generation.current++;
    queue.current = [];
    running.current = false;
    for (const [timer, resolve] of timers.current) { clearTimeout(timer); resolve(); }
    timers.current.clear();
  }, []);

  const pump = useCallback(async () => {
    if (running.current) return;
    const version = generation.current;
    running.current = true;
    dispatch({ k: "set", patch: { busy: true, prompt: undefined } });
    while (queue.current.length) {
      const batch = queue.current.shift()!;
      if (!stateRef.current) stateRef.current = batch.state;
      for (const e of batch.events) {
        if (version !== generation.current) return;
        const fast = speed.current;
        if (stateRef.current) playEvent(e, stateRef.current.you);
        if (e.t === "win") { dispatch({ k: "set", patch: { result: { winner: e.winner, reason: e.reason } } }); continue; }
        if (e.t === "hint") continue;
        stateRef.current = applyEvent(stateRef.current, e);
        dispatch({ k: "set", patch: { state: stateRef.current } });
        const id = fxId.current++;
        dispatch({ k: "fx+", fx: { id, ev: e } });
        const dur = durationOf(e);
        const timer = setTimeout(() => { timers.current.delete(timer); if (version === generation.current) dispatch({ k: "fx-", id }); }, dur * 1.6 / fast + 200);
        timers.current.set(timer, () => {});
        if (e.t === "new_turn") dispatch({ k: "set", patch: { banner: { id, text: e.turnPlayer === stateRef.current.you ? "YOUR TURN" : "OPPONENT'S TURN", sub: `Turn ${e.turn}` } } });
        if (e.t === "damage" || (e.t === "summon" && e.kind !== "normal" && e.kind !== "set") || (e.t === "move" && e.reason === "destroy"))
          dispatch({ k: "set", patch: { shake: id } });
        if (fast < 50) await new Promise<void>(resolve => {
          const wait = setTimeout(() => { timers.current.delete(wait); resolve(); }, dur / fast);
          timers.current.set(wait, resolve);
        });
      }
      if (version !== generation.current) return;
      // Snap to the authoritative snapshot so any drift is corrected.
      stateRef.current = batch.state;
      dispatch({ k: "set", patch: { state: batch.state, ...(batch.prompt && !queue.current.length ? { prompt: batch.prompt } : {}) } });
    }
    running.current = false;
    dispatch({ k: "set", patch: { busy: false } });
  }, []);

  useEffect(() => {
    let active = true;
    const c = open(
      (m) => {
        if (!active) return;
        switch (m.type) {
          case "room": {
            const patch: Partial<View> = { roomId: m.roomId, players: m.players, roomStatus: m.status, format: m.format, match: m.match, score: m.score, game: m.game };
            // A new game of a match starts from a clean board.
            if (m.status === "dueling" && m.game !== undefined && m.game !== gameRef.current) {
              if (gameRef.current !== undefined) { halt(); stateRef.current = undefined; pendingResponse.current = undefined; Object.assign(patch, { state: undefined, result: undefined, prompt: undefined, fx: [], busy: false }); }
              gameRef.current = m.game;
            }
            dispatch({ k: "set", patch });
            break;
          }
          case "events": pendingResponse.current = undefined; queue.current.push({ events: m.events, state: m.state }); pump(); break;
          case "prompt": pendingResponse.current = undefined; queue.current.push({ events: [], state: m.state, prompt: m.prompt }); pump(); break;
          case "chat": dispatch({ k: "chat", from: m.from, text: m.text }); break;
          case "agent_status": dispatch({ k: "agent", seat: m.seat, info: { agent: m.agent, status: m.status, detail: m.detail } }); break;
          case "error": {
            if (m.message.startsWith("duel aborted:")) {
              halt();
              dispatch({ k: "set", patch: { error: m.message, fatalError: m.message, prompt: undefined, busy: false, fx: [] } });
            } else dispatch({ k: "set", patch: { error: m.message, ...(pendingResponse.current ? { prompt: pendingResponse.current } : {}) } });
            break;
          }
        }
      },
      (why) => { if (!active) return; halt(); dispatch({ k: "set", patch: { error: why, fatalError: why, prompt: undefined, busy: false, fx: [] } }); },
    );
    conn.current = c;
    return () => { active = false; c.close(); halt(); conn.current = null; };
  }, [open, pump, halt]);

  const send = useCallback((m: ClientMsg) => conn.current?.send(m), []);
  const respond = useCallback((promptId: string, choose: string[]) => {
    pendingResponse.current = currentPrompt.current;
    dispatch({ k: "set", patch: { prompt: undefined } });
    send({ type: "action", action: { promptId, choose } });
  }, [send]);
  const setSpeed = useCallback((s: number) => { speed.current = s; }, []);
  const clearError = useCallback(() => dispatch({ k: "set", patch: { error: undefined } }), []);

  return { view, send, respond, setSpeed, clearError };
}
