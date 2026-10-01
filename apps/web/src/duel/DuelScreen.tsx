import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CardRef, Deck, FormatId, MatchType, PlayerIdx, PromptOption, ServerMsg } from "@ygosim/protocol";
import { isMock } from "../api";
import { createMockConn } from "../mock";
import { connect, type Conn } from "../net";
import { Board3D } from "../duel3d/Scene3D";
import { CardFace } from "./CardView";
import { Inspector } from "./Inspector";
import { CardMenu, PromptPanel, isBoardMenu, isMulti } from "./PromptPanel";
import { SideDeck } from "./SideDeck";
import { useDuel } from "./useDuel";

export type DuelLaunch = (
  | { mode: "ai"; level: "easy" | "normal" | "hard" }
  | { mode: "create" }
  | { mode: "join"; roomId: string }
) & { format?: FormatId; match?: MatchType };

const PHASES = [["draw", "DP"], ["standby", "SP"], ["main1", "M1"], ["battle", "BP"], ["main2", "M2"], ["end", "EP"]] as const;

function useTween(target: number, ms = 700) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now(), a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms), e = 1 - Math.pow(1 - k, 3);
      const cur = Math.round(a + (target - a) * e);
      setV(cur); from.current = cur;
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function LpBar({ name, lp, mine, active, hits }: { name: string; lp: number; mine: boolean; active: boolean; hits: { id: number; amount: number; heal: boolean }[] }) {
  const shown = useTween(lp);
  return (
    <div className={`lp ${mine ? "me" : "op"}${active ? " active" : ""}`}>
      <div className="lp-name">{name}</div>
      <div className="lp-num">{shown}</div>
      <div className="lp-track"><div className="lp-fill" style={{ width: `${Math.max(0, Math.min(1, shown / 8000)) * 100}%` }} /></div>
      <AnimatePresence>
        {hits.map((h) => (
          <motion.div key={h.id} className={`lp-pop${h.heal ? " heal" : ""}`} initial={{ opacity: 0, y: 0, scale: 0.6 }} animate={{ opacity: 1, y: mine ? -46 : 46, scale: 1.2 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
            {h.heal ? "+" : "−"}{h.amount}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function DuelScreen({ launch, deck, name, onExit }: { launch: DuelLaunch; deck: Deck; name: string; onExit: () => void }) {
  const open = useCallback((onMsg: (m: ServerMsg) => void, onClose: (why: string) => void): Conn => {
    const c = isMock ? createMockConn(onMsg) : connect(onMsg, onClose);
    c.send({ type: "hello", name, kind: "human" });
    const rules = { format: launch.format, match: launch.match };
    if (launch.mode === "ai") c.send({ type: "create_room", vsAI: true, aiLevel: launch.level, deck, ...rules });
    else if (launch.mode === "create") c.send({ type: "create_room", deck, ...rules });
    else c.send({ type: "join_room", roomId: launch.roomId, deck });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { view, send, respond, setSpeed, clearError } = useDuel(open);
  const { state, prompt, fx } = view;

  const [hover, setHover] = useState<CardRef | null>(null);
  const [pinned, setPinned] = useState<number | undefined>();
  const [menu, setMenu] = useState<PromptOption[] | null>(null);
  const [pile, setPile] = useState<{ owner: PlayerIdx; loc: CardRef["location"] } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [speed, setSpd] = useState(1);
  const [chatText, setChatText] = useState("");

  useEffect(() => { setSelected([]); setMenu(null); }, [prompt?.promptId]);

  // uid -> options that reference that card
  const byCard = useMemo(() => {
    const m = new Map<string, PromptOption[]>();
    for (const o of prompt?.options ?? []) if (o.card) (m.get(o.card.uid) ?? m.set(o.card.uid, []).get(o.card.uid)!).push(o);
    return m;
  }, [prompt]);
  const selectable = useMemo(() => new Set(byCard.keys()), [byCard]);
  const selectedUids = useMemo(() => new Set(prompt?.options.filter((o) => selected.includes(o.id) && o.card).map((o) => o.card!.uid)), [prompt, selected]);

  const submit = (ids: string[]) => { if (prompt) respond(prompt.promptId, ids); setMenu(null); setPile(null); };
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < (prompt?.max ?? 1) ? [...s, id] : s));

  const onCard = (c: CardRef) => {
    if (c.code !== undefined) setPinned(c.code);
    const opts = byCard.get(c.uid);
    if (!prompt || !opts) return;
    if (isBoardMenu(prompt)) { setPile(null); return setMenu(opts); }
    if (isMulti(prompt)) return toggle(opts[0].id);
    submit([opts[0].id]);
  };

  const hits = (p: PlayerIdx) => fx.flatMap((f) => (f.ev.t === "damage" || f.ev.t === "recover") && f.ev.player === p ? [{ id: f.id, amount: f.ev.amount, heal: f.ev.t === "recover" }] : []);
  const chainNow = state?.chain ?? [];

  if (view.roomStatus === "siding") {
    return <SideDeck deck={deck} score={view.score} game={view.game} onDone={(d) => send({ type: "side_deck", deck: d })} />;
  }

  if (!state) {
    return (
      <div className="duel-wait">
        <div className="spinner" />
        <h2>{view.roomId ? `Room ${view.roomId}` : "Connecting…"}</h2>
        <p>{view.roomId ? (view.players.length < 2 ? "Waiting for an opponent. Share the room code, or point your agent at it." : "Shuffling decks…") : "Contacting the duel server"}</p>
        {view.error && <p className="err">{view.error}</p>}
        <button className="ghost" onClick={onExit}>Back</button>
      </div>
    );
  }

  const you = state.you, opp = (1 - you) as PlayerIdx;
  const pileCards = pile ? state.cards.filter((c) => c.controller === pile.owner && c.location === pile.loc).sort((a, b) => b.sequence - a.sequence) : [];

  return (
    <div className="duel">
      <div className="duel-top">
        <LpBar name={view.players[opp] ?? "Opponent"} lp={state.lp[opp]} mine={false} active={state.turnPlayer === opp} hits={hits(opp)} />
        <div className="phase-bar">
          {view.match === "match" && view.score && <span className="score">G{(view.game ?? 0) + 1} · {view.score[you]}–{view.score[opp]}</span>}
          <span className="turn-no">T{state.turn}</span>
          {PHASES.map(([k, l]) => <span key={k} className={state.phase === k ? `on ${state.turnPlayer === you ? "me" : "op"}` : ""}>{l}</span>)}
        </div>
        <div className="top-tools">
          {[1, 2, 4].map((s) => <button key={s} className={speed === s ? "on" : ""} onClick={() => { setSpd(s); setSpeed(s); }}>{s}×</button>)}
          <button className="danger" onClick={() => send({ type: "surrender" })}>Surrender</button>
        </div>
      </div>

      <Inspector code={hover?.code ?? pinned} />

      <Board3D state={state} fx={fx} shake={view.shake} selectable={selectable} selected={selectedUids}
        onCard={onCard} onHover={setHover} onPile={(owner, loc) => setPile({ owner, loc })} />

      <LpBar name={view.players[you] ?? name} lp={state.lp[you]} mine active={state.turnPlayer === you} hits={hits(you)} />

      {chainNow.length > 0 && (
        <div className="chain-stack">
          <div className="chain-head">CHAIN</div>
          {chainNow.map((c, i) => (
            <motion.div key={i} className="chain-link" initial={{ x: 60, opacity: 0 }} animate={{ x: 0, opacity: 1 }}>
              <b>{i + 1}</b>{c.card.code !== undefined && <span className="thumb"><CardFace code={c.card.code} /></span>}
            </motion.div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {view.banner && (
          <motion.div key={view.banner.id} className="turn-banner" initial={{ opacity: 0, scaleX: 0.2 }} animate={{ opacity: [0, 1, 1, 0], scaleX: [0.2, 1, 1, 1.1] }} transition={{ duration: 1.3 / speed, times: [0, 0.2, 0.8, 1] }}>
            <h1>{view.banner.text}</h1>{view.banner.sub && <p>{view.banner.sub}</p>}
          </motion.div>
        )}
      </AnimatePresence>

      {prompt && !view.result && (
        <PromptPanel prompt={prompt} selected={selected} toggle={toggle} submit={submit} />
      )}
      {!prompt && !view.result && view.busy && <div className="opp-thinking">…</div>}
      {!prompt && !view.result && !view.busy && <div className="opp-thinking">Opponent is thinking…</div>}

      {menu && <CardMenu options={menu} onPick={(id) => submit([id])} onClose={() => setMenu(null)} />}

      {pile && (
        <div className="modal-backdrop" onClick={() => setPile(null)}>
          <div className="pile-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{pile.owner === you ? "Your" : "Opponent's"} {pile.loc} · {pileCards.length}</h3>
            <div className="pile-grid">
              {pileCards.map((c) => {
                const opts = byCard.get(c.uid);
                return (
                  <button key={c.uid} className={`pile-card${opts ? " selectable" : ""}${selectedUids.has(c.uid) ? " selected" : ""}`}
                    onMouseEnter={() => setHover(c)} onClick={() => (opts ? onCard(c) : c.code !== undefined && setPinned(c.code))}>
                    {c.code !== undefined ? <CardFace code={c.code} /> : <div className="card-back small" />}
                  </button>
                );
              })}
              {!pileCards.length && <p className="muted">Empty</p>}
            </div>
          </div>
        </div>
      )}

      <form className="chat" onSubmit={(e) => { e.preventDefault(); if (chatText.trim()) { send({ type: "chat", text: chatText }); setChatText(""); } }}>
        <div className="chat-log">{view.chat.slice(-5).map((m, i) => <div key={i}><b>{m.from}:</b> {m.text}</div>)}</div>
        <input value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="Chat…" />
      </form>

      {view.error && <div className="toast" onClick={clearError}>{view.error}</div>}

      <AnimatePresence>
        {view.result && (
          <motion.div className={`result ${view.result.winner === you ? "win" : view.result.winner === null ? "draw" : "lose"}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }}>
            <motion.h1 initial={{ scale: 2.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.8, type: "spring", stiffness: 120 }}>
              {view.result.winner === you ? "VICTORY" : view.result.winner === null ? "DRAW" : "DEFEAT"}
            </motion.h1>
            <p>{view.result.reason}</p>
            {view.match === "match" && view.score && <p className="score-line">Match {view.score[you]} – {view.score[opp]}</p>}
            {view.match === "match" && view.roomStatus !== "done" ? <p className="muted">Next game starting…</p> : <button onClick={onExit}>Return</button>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
