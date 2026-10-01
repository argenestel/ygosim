import { motion } from "framer-motion";
import { memo, useState } from "react";
import type { CardRef } from "@ygosim/protocol";
import { imageFor, peekCard } from "../api";
import { CARD_H, CARD_W, type Pos } from "./layout";

export function CardBack({ small }: { small?: boolean }) {
  return (
    <div className={`card-back${small ? " small" : ""}`}>
      <div className="card-back-ring" />
      <div className="card-back-core" />
    </div>
  );
}

export function CardFace({ code }: { code: number }) {
  const [broken, setBroken] = useState(false);
  const data = peekCard(code);
  if (broken) {
    return (
      <div className="card-fallback">
        <b>{data?.name ?? `#${code}`}</b>
        {data?.atk !== undefined && <span>{data.atk}/{data.def ?? "-"}</span>}
      </div>
    );
  }
  return <img className="card-img" src={data?.imageUrl ?? imageFor(code)} alt={data?.name ?? String(code)} draggable={false} loading="lazy" onError={() => setBroken(true)} />;
}

interface Props {
  card: CardRef;
  pos: Pos;
  selectable?: boolean;
  selected?: boolean;
  mine: boolean;
  onClick?: () => void;
  onHover?: (c: CardRef | null) => void;
  hidePile?: boolean;
}

export const CardView = memo(function CardView({ card, pos, selectable, selected, mine, onClick, onHover, hidePile }: Props) {
  // Battle position only means something on the field; engines report raw positions for hand/deck too.
  const onBoard = card.location === "mzone" || card.location === "szone" || card.location === "emzone" || card.location === "fzone" || card.location === "pzone";
  const faceDown = card.code === undefined || (onBoard && (card.position === "facedown" || card.position === "facedown_def"))
    || ((card.location === "deck" || card.location === "extra") && card.position !== "faceup");
  const sideways = onBoard && (card.position === "def" || card.position === "facedown_def");
  const inHand = card.location === "hand";
  const onField = card.location === "mzone" || card.location === "emzone";
  const lift = inHand && mine ? 30 : 0;
  // Own face-down field cards stay peekable (a small inset), like the real games.
  const peek = faceDown && card.code !== undefined && (card.location === "mzone" || card.location === "szone");

  return (
    <motion.div
      className={`card${selectable ? " selectable" : ""}${selected ? " selected" : ""}${inHand && mine ? " in-hand" : ""}`}
      style={{ width: CARD_W, height: CARD_H, marginLeft: -CARD_W / 2, marginTop: -CARD_H / 2, zIndex: Math.round(pos.z), opacity: hidePile ? 0 : 1 }}
      initial={false}
      animate={{ x: pos.x, y: pos.y, z: lift, rotateX: inHand && mine ? -24 : 0, rotateZ: pos.rot + (sideways ? 90 : 0), rotateY: faceDown && !inHand ? 180 : 0 }}
      transition={{ type: "spring", stiffness: 170, damping: 22, mass: 0.9 }}
      whileHover={inHand && mine ? { z: 80, y: pos.y - 26, scale: 1.12 } : selectable ? { scale: 1.06 } : undefined}
      onClick={onClick}
      onMouseEnter={() => onHover?.(card)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div className="card-face front">{card.code !== undefined ? <CardFace code={card.code} /> : <CardBack />}</div>
      <div className="card-face back"><CardBack />{peek && <div className="peek"><CardFace code={card.code!} /></div>}</div>
      {onField && !faceDown && card.atk !== undefined && (
        <div className="stat-plate" style={{ transform: `rotateZ(${-(pos.rot + (sideways ? 90 : 0))}deg)` }}>
          <span className={card.position === "atk" ? "hi" : ""}>{card.atk}</span>
          <span className="sep">/</span>
          <span className={card.position !== "atk" ? "hi" : ""}>{card.def ?? "—"}</span>
        </div>
      )}
      {card.overlays && card.overlays.length > 0 && <div className="overlay-pips">{card.overlays.map((o) => <i key={o.uid} />)}</div>}
    </motion.div>
  );
});
