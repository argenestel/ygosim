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
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("ygosim.inspector") !== "0"; } catch { return true; } });
  const toggle = () => { const v = !open; setOpen(v); try { localStorage.setItem("ygosim.inspector", v ? "1" : "0"); } catch {} };
  if (!open) return <button className="insp-toggle" onClick={toggle} title="Show card details">Card details ▸</button>;
  if (code === undefined) return <aside className="inspector empty"><p>Hover a card to read it.</p></aside>;
  return (
    <aside className="inspector">
      <button className="insp-collapse ghost" onClick={toggle} aria-label="Hide card details">✕</button>
      <div className="insp-art"><CardFace code={code} /></div>
      <h3>{d?.name ?? "…"}</h3>
      {d && (
        <div className="insp-meta">
          {d.type.join(" / ")}
          {d.attribute && <> · {d.attribute}</>}
          {d.race && <> · {d.race}</>}
          {d.level !== undefined && !d.linkMarkers && <> · {d.type.includes("Xyz") ? "Rank" : "Lv"} {d.level}</>}
          {d.scale !== undefined && <> · Scale {d.scale}</>}
          {d.linkMarkers && <> · LINK-{d.linkMarkers.length}</>}
        </div>
      )}
      {d && d.type.includes("Monster") && (d.atk !== undefined || d.atkUnknown) && <div className="insp-stats">ATK {d.atkUnknown ? "?" : d.atk}{!d.linkMarkers && (d.def !== undefined || d.defUnknown) ? ` / DEF ${d.defUnknown ? "?" : d.def}` : ""}</div>}
      <p className="insp-desc">{d?.desc}</p>
    </aside>
  );
}
