import { AnimatePresence, motion } from "framer-motion";
import type { DuelState, PlayerIdx } from "@ygosim/protocol";
import { thumbUrl } from "../api";
import { useCardData } from "./Inspector";

type Link = DuelState["chain"][number];

function ChainEntry({ link, n, you, top }: { link: Link; n: number; you: PlayerIdx; top: boolean }) {
  const data = useCardData(link.card.code);
  const mine = link.card.controller === you;
  return (
    <motion.div
      layout
      className={`chain-entry ${mine ? "me" : "op"}${top ? " top" : ""}`}
      initial={{ x: 80, opacity: 0, scale: 0.9 }}
      animate={{ x: 0, opacity: 1, scale: 1 }}
      exit={{ x: 40, opacity: 0, scale: 0.85, filter: "brightness(2.2)", transition: { duration: 0.45 } }}
      transition={{ type: "spring", stiffness: 260, damping: 24 }}
    >
      <div className="chain-num">{n}</div>
      <div className="chain-art">{link.card.code !== undefined ? <img src={thumbUrl(link.card.code)} alt="" /> : <div className="card-back small" />}</div>
      <div className="chain-text">
        <b>{data?.name ?? "Set card"}</b>
        <span>{link.desc || data?.desc?.slice(0, 120) || ""}</span>
        {link.targets && link.targets.length > 0 && <Targets cards={link.targets} />}
      </div>
    </motion.div>
  );
}

function TargetName({ code }: { code?: number }) {
  const d = useCardData(code);
  return <>{code === undefined ? "a set card" : d?.name ?? `#${code}`}</>;
}

function Targets({ cards }: { cards: NonNullable<Link["targets"]> }) {
  return (
    <em className="chain-targets">
      → {cards.map((c, i) => <span key={c.uid}>{i > 0 && ", "}<TargetName code={c.code} /></span>)}
    </em>
  );
}

/** Master Duel-style chain stack: newest link on top, resolves top-down with a flash. */
export function ChainPanel({ chain, you }: { chain: DuelState["chain"]; you: PlayerIdx }) {
  return (
    <div className="chain-panel" aria-live="polite">
      <AnimatePresence>
        {chain.length > 0 && (
          <motion.div key="head" className="chain-title" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            CHAIN <em>{chain.length}</em>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="chain-list">
        {chain.length > 1 && <div className="chain-spine" />}
        <AnimatePresence initial={false}>
          {[...chain].map((l, i) => ({ l, n: i + 1 })).reverse().map(({ l, n }) => (
            <ChainEntry key={`${n}-${l.card.uid}`} link={l} n={n} you={you} top={n === chain.length} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Brief centre callout when a card is chained ("CHAIN 2 · Ash Blossom"). */
export function ChainCallout({ id, n, code, mine }: { id: number; n: number; code?: number; mine: boolean }) {
  const data = useCardData(code);
  return (
    <motion.div key={id} className={`chain-callout ${mine ? "me" : "op"}`}
      initial={{ opacity: 0, y: 12, scale: 0.95 }} animate={{ opacity: [0, 1, 1, 0], y: [12, 0, 0, -6], scale: 1 }}
      transition={{ duration: 1.3, times: [0, 0.15, 0.8, 1] }}>
      <span className="cc-num">{n}</span>
      <span className="cc-label">{n > 1 ? "Chain" : "Activate"}</span>
      <b>{data?.name ?? "Set card"}</b>
    </motion.div>
  );
}
