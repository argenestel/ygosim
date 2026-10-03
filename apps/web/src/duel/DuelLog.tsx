import { useEffect, useRef, useState } from "react";
import type { CardRef, DuelEvent, PlayerIdx } from "@ygosim/protocol";
import { useCardData } from "./Inspector";
import type { LogEntry } from "./useDuel";

function Name({ card }: { card?: Partial<CardRef> }) {
  const d = useCardData(card?.code);
  if (!card || card.code === undefined) return <i className="log-hidden">a set card</i>;
  return <b className="log-card">{d?.name ?? `#${card.code}`}</b>;
}

const SUMMON: Record<string, string> = {
  normal: "Normal Summoned", set: "Set", flip: "Flip Summoned", special: "Special Summoned",
  fusion: "Fusion Summoned", synchro: "Synchro Summoned", xyz: "Xyz Summoned", link: "Link Summoned",
  pendulum: "Pendulum Summoned", ritual: "Ritual Summoned",
};
const MOVE: Record<string, string> = { destroy: "destroyed", banish: "banished", resolve: "sent to GY", material: "used as material", tribute: "tributed" };

/** One human-readable line per duel event. Returns null for events not worth logging. */
function Line({ ev, who }: { ev: DuelEvent; who: (p: PlayerIdx) => string }) {
  switch (ev.t) {
    case "new_turn": return <span className="log-turn">— Turn {ev.turn} · {who(ev.turnPlayer)} —</span>;
    case "draw": return <span>{who(ev.player)} drew {ev.cards.length === 1 ? <Name card={ev.cards[0]} /> : `${ev.cards.length} cards`}</span>;
    case "summon": return <span>{who(ev.card.controller)} {SUMMON[ev.kind] ?? "summoned"} <Name card={ev.card} /></span>;
    case "activate": return <span>{who(ev.card.controller)} activated <Name card={ev.card} /> <em className="log-chain">CL{ev.chainLink}</em></span>;
    case "chain_solved": return <span className="log-dim">Chain Link {ev.chainLink} resolved</span>;
    case "attack": return <span>{who(ev.attacker.controller)} attacked with <Name card={ev.attacker} /> → {ev.target ? <Name card={ev.target} /> : "directly"}</span>;
    case "damage": return <span className="log-dmg">{who(ev.player)} took {ev.amount} damage</span>;
    case "recover": return <span className="log-heal">{who(ev.player)} gained {ev.amount} LP</span>;
    case "pay_lp": return <span className="log-cost">{who(ev.player)} paid {ev.amount} LP</span>;
    case "move": {
      const verb = MOVE[ev.reason];
      if (!verb && ev.card.location !== "grave" && ev.card.location !== "banished") return null;
      return <span><Name card={ev.card} /> {verb ?? (ev.card.location === "banished" ? "banished" : "sent to GY")}</span>;
    }
    case "pos_change": return <span><Name card={ev.card} /> changed position</span>;
    case "win": return <span className="log-turn">{ev.winner === null ? "Draw" : `${who(ev.winner)} won`} · {ev.reason}</span>;
    default: return null;
  }
}

const KEY_EVENTS = new Set(["new_turn", "summon", "activate", "attack", "damage", "recover", "pay_lp", "win"]);

/** Retained duel log + LP history drawer (EDOPro-style field log). */
export function DuelLog({ log, you, names }: { log: LogEntry[]; you: PlayerIdx; names: string[] }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const who = (p: PlayerIdx) => (p === you ? "You" : names[p] ?? "Opponent");
  const shown = all ? log : log.filter((e) => KEY_EVENTS.has(e.ev.t));
  useEffect(() => { if (open) end.current?.scrollIntoView({ block: "end" }); }, [open, shown.length]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.key === "l" || e.key === "L") && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) setOpen((o) => !o);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  return (
    <>
      <button className="log-toggle" onClick={() => setOpen((o) => !o)} title="Duel log (L)">Log{log.length ? ` · ${shown.length}` : ""}</button>
      {open && (
        <aside className="duel-log" aria-label="Duel log">
          <header>
            <b>Duel Log</b>
            <div className="seg"><button className={!all ? "on" : ""} onClick={() => setAll(false)}>Key plays</button><button className={all ? "on" : ""} onClick={() => setAll(true)}>Everything</button></div>
            <button className="ghost" onClick={() => setOpen(false)}>✕</button>
          </header>
          <ol>
            {shown.map((e) => {
              const lpEv = e.ev.t === "damage" || e.ev.t === "recover" || e.ev.t === "pay_lp";
              return (
                <li key={e.id} className={e.ev.t === "new_turn" ? "turn" : ""}>
                  <Line ev={e.ev} who={who} />
                  {lpEv && <span className="log-lp">{e.lp[you]} / {e.lp[(1 - you) as PlayerIdx]}</span>}
                </li>
              );
            })}
            {shown.length === 0 && <li className="log-dim">Nothing has happened yet.</li>}
          </ol>
          <div ref={end} />
        </aside>
      )}
    </>
  );
}
