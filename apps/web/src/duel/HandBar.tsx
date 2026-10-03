import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { CardRef, PromptOption } from "@ygosim/protocol";
import { artUrl } from "../api";

interface Props {
  cards: CardRef[];
  byCard: Map<string, PromptOption[]>;
  selected: Set<string>;
  onCard: (c: CardRef, at: { x: number; y: number }) => void;
  onHover: (c: CardRef | null) => void;
}

/**
 * Master Duel-style hand: large, readable 2D cards fanned along the bottom edge.
 * Playable cards get a gold edge; hovering lifts a card; clicking opens its actions.
 */
export function HandBar({ cards, byCard, selected, onCard, onHover }: Props) {
  const hand = [...cards].sort((a, b) => a.sequence - b.sequence);
  const n = hand.length;
  const [vw, setVw] = useState(window.innerWidth);
  useEffect(() => { const r = () => setVw(window.innerWidth); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, []);
  // The hand lives between the player plate (left) and the action dock (right);
  // cards overlap more as the hand grows so it never spills into either.
  const cardW = vw < 760 ? 92 : vw < 1200 ? 112 : 132;
  const room = Math.max(cardW * 2, vw - (vw < 760 ? 24 : 2 * 300));
  const step = n > 1 ? Math.min(cardW * 0.9, Math.max(28, (room - cardW) / (n - 1))) : 0;
  return (
    <div className="hand-bar" style={{ width: step * Math.max(n - 1, 0) + cardW, ["--card-w" as string]: `${cardW}px` }} aria-label="Your hand">
      {hand.map((c, i) => {
        const off = i - (n - 1) / 2;
        const playable = byCard.has(c.uid);
        return (
          <motion.button
            key={c.uid}
            layout
            className={`hand-card${playable ? " playable" : ""}${selected.has(c.uid) ? " picked" : ""}`}
            style={{ left: i * step, zIndex: 10 + i }}
            initial={{ y: 140, opacity: 0 }}
            animate={{ y: Math.abs(off) * 5, rotate: off * 2.4, opacity: 1 }}
            exit={{ y: -80, opacity: 0, scale: 0.9 }}
            whileHover={{ y: -46, rotate: 0, scale: 1.18, zIndex: 60 }}
            transition={{ type: "spring", stiffness: 300, damping: 26 }}
            onMouseEnter={() => onHover(c)}
            onMouseLeave={() => onHover(null)}
            onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onCard(c, { x: r.left + r.width / 2, y: r.top - 8 }); }}
            title={playable ? byCard.get(c.uid)!.map((o) => o.label).join("\n") : undefined}
          >
            {c.code !== undefined ? <img src={artUrl(c.code)} alt="" draggable={false} /> : <div className="card-back small" />}
            {playable && <span className="hand-actions">{byCard.get(c.uid)!.length}</span>}
          </motion.button>
        );
      })}
    </div>
  );
}
