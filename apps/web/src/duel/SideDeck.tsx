import { useState } from "react";
import type { Deck } from "@ygosim/protocol";
import { peekCard } from "../api";
import { CardFace } from "./CardView";
import { useCardData } from "./Inspector";

const EXTRA = ["Fusion", "Synchro", "Xyz", "Link"];

function Pick({ code, on, onClick }: { code: number; on: boolean; onClick: () => void }) {
  useCardData(code);
  return <button className={`db-card${on ? " picked" : ""}`} onClick={onClick}><CardFace code={code} /></button>;
}

/** Between games of a match: swap cards between main/extra and side, keeping sizes equal. */
export function SideDeck({ deck, score, game, onDone }: { deck: Deck; score?: [number, number]; game?: number; onDone: (d: Deck) => void }) {
  const [d, setD] = useState<Deck>(deck);
  const [sel, setSel] = useState<{ from: keyof Deck; i: number } | null>(null);
  const [sent, setSent] = useState(false);

  const click = (from: keyof Deck, i: number) => {
    if (!sel) return setSel({ from, i });
    if (sel.from === from) return setSel(sel.i === i ? null : { from, i });
    // Only swap side <-> main/extra, and extra-deck monsters must stay in the extra deck.
    const pair = [sel, { from, i }];
    const side = pair.find((p) => p.from === "side");
    const other = pair.find((p) => p.from !== "side");
    if (!side || !other) return setSel({ from, i });
    const sideCode = d.side[side.i];
    const isEx = peekCard(sideCode)?.type.some((t) => EXTRA.includes(t));
    if ((other.from === "extra") !== !!isEx) return setSel({ from, i });
    const next: Deck = { main: [...d.main], extra: [...d.extra], side: [...d.side] };
    next.side[side.i] = d[other.from][other.i];
    next[other.from][other.i] = sideCode;
    setD(next); setSel(null);
  };

  return (
    <div className="side-screen">
      <h2>Side Deck · Game {(game ?? 1) + 1}</h2>
      {score && <p className="score-line">Score {score[0]} – {score[1]}</p>}
      <p className="muted">Click a card, then a card in the other section to swap them.</p>
      {(["main", "extra", "side"] as const).map((k) => (
        <section key={k}>
          <h3>{k} <small>{d[k].length}</small></h3>
          <div className="db-grid">{d[k].map((c, i) => <Pick key={`${k}${i}`} code={c} on={sel?.from === k && sel.i === i} onClick={() => click(k, i)} />)}</div>
        </section>
      ))}
      <div className="row">
        <button onClick={() => { setD(deck); setSel(null); }}>Reset</button>
        <button className="primary" disabled={sent} onClick={() => { setSent(true); onDone(d); }}>{sent ? "Waiting for opponent…" : "Ready"}</button>
      </div>
    </div>
  );
}
