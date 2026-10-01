import { useEffect, useMemo, useRef } from "react";
import type { CardRef, DuelState, PlayerIdx } from "@ygosim/protocol";
import { CardView } from "./CardView";
import { CARD_H, CARD_W, isPile, layoutCards, slot, zoneFrames, type Pos } from "./layout";
import type { Fx } from "./useDuel";

interface Props {
  state: DuelState;
  fx: Fx[];
  selectable: Set<string>;
  selected: Set<string>;
  onCard: (c: CardRef) => void;
  onPile: (owner: PlayerIdx, loc: CardRef["location"]) => void;
  onHover: (c: CardRef | null) => void;
  shake: number;
}

const FRAMES = zoneFrames();

export function Board({ state, fx, selectable, selected, onCard, onPile, onHover, shake }: Props) {
  const pos = useMemo(() => layoutCards(state.cards, state.you), [state.cards, state.you]);
  const piles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of state.cards) if (isPile(c.location)) {
      const k = `${c.controller}:${c.location}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    // Only render the top few of each pile; hidden ones still exist so they can fly out later.
    const byPile = new Map<string, CardRef[]>();
    for (const c of state.cards) if (isPile(c.location)) {
      const k = `${c.controller}:${c.location}`;
      (byPile.get(k) ?? byPile.set(k, []).get(k)!).push(c);
    }
    const visible = new Set<string>();
    for (const [k, list] of byPile) {
      list.sort((a, b) => b.sequence - a.sequence).slice(0, 4).forEach((c) => visible.add(c.uid));
    }
    return { counts, visible };
  }, [state.cards]);

  // Cards listed as selectable that live inside piles make the pile itself glow.
  const glowingPiles = useMemo(() => {
    const s = new Set<string>();
    for (const c of state.cards) if (selectable.has(c.uid) && isPile(c.location)) s.add(`${c.controller}:${c.location}`);
    return s;
  }, [state.cards, selectable]);

  const boardEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fit = () => boardEl.current?.style.setProperty("--fit", String(Math.min(window.innerWidth / 1250, window.innerHeight / 960)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  useEffect(() => {
    const el = boardEl.current;
    if (!el || !shake) return;
    el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake");
  }, [shake]);

  const where = (c: CardRef | undefined): Pos | undefined => (c ? pos.get(c.uid) : undefined);

  return (
    <div className="board-stage">
      <div className="board" ref={boardEl}>
        <div className="mat">
          <div className="mat-divider" />
          {FRAMES.map((f) => (
            <div key={f.key} className={`zone ${f.kind}`} style={{ transform: `translate(${f.x - CARD_W / 2}px, ${f.y - CARD_H / 2}px)` }}>
              {f.label && <span>{f.label}</span>}
            </div>
          ))}
          {(["deck", "extra", "grave", "banished"] as const).flatMap((loc) => [0, 1].map((p) => {
            const mine = p === state.you;
            const s = slot(loc, 0, mine);
            const k = `${p}:${loc}`;
            const n = piles.counts.get(k) ?? 0;
            return (
              <button key={k} className={`pile-hit${glowingPiles.has(k) ? " glow" : ""}`}
                style={{ transform: `translate(${s.x - CARD_W / 2}px, ${s.y - CARD_H / 2}px)` }}
                onClick={() => onPile(p as PlayerIdx, loc)} title={`${mine ? "Your" : "Opponent's"} ${loc} (${n})`}>
                {n > 0 && <em>{n}</em>}
              </button>
            );
          }))}
        </div>
        <div className="card-layer">
          {state.cards.map((c) => {
            const p = pos.get(c.uid);
            if (!p) return null;
            const inPile = isPile(c.location);
            return (
              <CardView key={c.uid} card={c} pos={p} mine={c.controller === state.you}
                hidePile={inPile && !piles.visible.has(c.uid)}
                selectable={selectable.has(c.uid) && !inPile} selected={selected.has(c.uid)}
                onClick={() => (inPile ? onPile(c.controller, c.location) : onCard(c))} onHover={onHover} />
            );
          })}
        </div>
        <div className="fx-layer">
          {fx.map((f) => <BoardFx key={f.id} fx={f} where={where} you={state.you} />)}
        </div>
      </div>
    </div>
  );
}

function Particles({ n, cls }: { n: number; cls: string }) {
  const parts = useMemo(() => Array.from({ length: n }, (_, i) => ({
    a: (i / n) * 360 + Math.random() * 20, d: 60 + Math.random() * 90, s: 3 + Math.random() * 5, t: Math.random() * 0.25,
  })), [n]);
  return <>{parts.map((p, i) => <i key={i} className={cls} style={{ ["--a" as string]: `${p.a}deg`, ["--d" as string]: `${p.d}px`, ["--s" as string]: `${p.s}px`, animationDelay: `${p.t}s` }} />)}</>;
}

function BoardFx({ fx, where, you }: { fx: Fx; where: (c?: CardRef) => Pos | undefined; you: PlayerIdx }) {
  const e = fx.ev;
  const at = (p?: { x: number; y: number }) => (p ? { transform: `translate(${p.x}px, ${p.y}px)` } : { display: "none" });
  switch (e.t) {
    case "summon": {
      const p = where(e.card);
      return (
        <div className={`fx-anchor fx-summon fx-${e.kind}`} style={at(p)}>
          <div className="fx-ring" /><div className="fx-ring r2" /><div className="fx-ring r3" />
          <div className="fx-pillar" /><div className="fx-glyph" />
          <Particles n={e.kind === "normal" || e.kind === "set" ? 10 : 22} cls="fx-spark" />
          {!["normal", "set", "flip", "special"].includes(e.kind) && <div className="fx-title">{e.kind.toUpperCase()} SUMMON</div>}
        </div>
      );
    }
    case "activate": {
      const p = where(e.card);
      return (
        <div className="fx-anchor fx-activate" style={at(p)}>
          <div className="fx-aura" /><div className="fx-chain-badge">{e.chainLink}</div>
          <Particles n={12} cls="fx-spark" />
        </div>
      );
    }
    case "attack": {
      const a = where(e.attacker);
      const t = e.target ? where(e.target) : slot("hand", 0, e.attacker.controller !== you);
      if (!a || !t) return null;
      const dx = t.x - a.x, dy = t.y - a.y;
      const len = Math.hypot(dx, dy), ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      return (
        <>
          <div className="fx-anchor" style={at(a)}>
            <div className="fx-beam" style={{ width: len, transform: `rotate(${ang}deg)` }} />
          </div>
          <div className="fx-anchor fx-impact" style={at(t)}>
            <div className="fx-ring" /><Particles n={18} cls="fx-spark hot" />
          </div>
        </>
      );
    }
    case "move": {
      if (e.reason !== "destroy" || !e.from.location) return null;
      const p = slot(e.from.location, e.from.sequence ?? 0, e.card.controller === you);
      return <div className="fx-anchor fx-shatter" style={at(p)}><Particles n={26} cls="fx-shard" /></div>;
    }
    case "pos_change": {
      const p = where(e.card);
      return <div className="fx-anchor fx-flip" style={at(p)}><div className="fx-ring" /></div>;
    }
    default: return null;
  }
}
