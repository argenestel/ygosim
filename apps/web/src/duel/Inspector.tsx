import { useEffect, useState } from "react";
import type { CardData } from "@ygosim/protocol";
import { getCard, onCardCache, peekCard } from "../api";
import { CardFace } from "./CardView";

export function useCardData(code?: number): CardData | undefined {
  const [, force] = useState(0);
  useEffect(() => {
    if (code === undefined) return;
    const off = onCardCache(() => force((n) => n + 1));
    getCard(code);
    return off;
  }, [code]);
  return peekCard(code);
}

export function Inspector({ code }: { code?: number }) {
  const d = useCardData(code);
  if (code === undefined) return <aside className="inspector empty"><p>Hover a card to read it.</p></aside>;
  return (
    <aside className="inspector">
      <div className="insp-art"><CardFace code={code} /></div>
      <h3>{d?.name ?? "…"}</h3>
      {d && (
        <div className="insp-meta">
          {d.type.join(" / ")}
          {d.attribute && <> · {d.attribute}</>}
          {d.race && <> · {d.race}</>}
          {d.level !== undefined && <> · {d.type.includes("Xyz") ? "Rank" : "Lv"} {d.level}</>}
          {d.scale !== undefined && <> · Scale {d.scale}</>}
          {d.linkMarkers && <> · LINK-{d.linkMarkers.length}</>}
        </div>
      )}
      {d?.atk !== undefined && <div className="insp-stats">ATK {d.atk}{d.def !== undefined && !d.linkMarkers ? ` / DEF ${d.def}` : ""}</div>}
      <p className="insp-desc">{d?.desc}</p>
    </aside>
  );
}
