import { useEffect, useRef, useState } from "react";
import type { CardData, Deck, Format } from "@ygosim/protocol";
import { getBanlist, listFormats, searchCards, validateDeck } from "../api";
import { activeDeckName, loadDecks, parseYdk, prefFormat, saveDecks, setActiveDeck, setPrefFormat, toYdk } from "../deck";
import { CardFace } from "../duel/CardView";
import { Inspector, useCardData } from "../duel/Inspector";

const EXTRA_TYPES = ["Fusion", "Synchro", "Xyz", "Link"];
const isExtra = (c?: CardData) => !!c && c.type.some((t) => EXTRA_TYPES.includes(t));

const LIMIT_LABEL = ["Forbidden", "Limited", "Semi-Limited"] as const;
function Ban({ limit }: { limit?: 0 | 1 | 2 }) {
  if (limit === undefined) return null;
  return <i className={`ban ban-${limit}`} title={LIMIT_LABEL[limit]}>{limit === 0 ? "✕" : limit}</i>;
}

function Slot({ code, limit, onRemove, onHover }: { code: number; limit?: 0 | 1 | 2; onRemove: () => void; onHover: (c: number) => void }) {
  useCardData(code);
  return (
    <button className="db-card" onClick={onRemove} onContextMenu={(e) => { e.preventDefault(); onRemove(); }} onMouseEnter={() => onHover(code)} title="Click to remove">
      <CardFace code={code} />
      <Ban limit={limit} />
    </button>
  );
}

export function DeckBuilder({ onBack }: { onBack: () => void }) {
  const [all, setAll] = useState(loadDecks());
  const [name, setName] = useState(activeDeckName());
  const [deck, setDeck] = useState<Deck>(all[name] ?? { main: [], extra: [], side: [] });
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CardData[]>([]);
  const [hover, setHover] = useState<number | undefined>();
  const [issues, setIssues] = useState<string[] | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [formats, setFormats] = useState<Format[]>([]);
  const [format, setFormat] = useState(prefFormat());
  const [ban, setBan] = useState<Record<number, 0 | 1 | 2>>({});
  useEffect(() => { listFormats().then(setFormats); }, []);
  useEffect(() => { setPrefFormat(format); getBanlist(format).then(setBan); setIssues(null); }, [format]);
  const fmt = formats.find((f) => f.id === format);
  const whitelist = !!fmt?.whitelist;
  // Whitelist formats (Goat/Edison): unlisted cards are illegal. Traditional: forbidden counts as limited.
  const limitOf = (code: number): 0 | 1 | 2 | 3 => {
    const l = ban[code];
    if (l === undefined) return whitelist && Object.keys(ban).length ? 0 : 3;
    return fmt?.traditional && l === 0 ? 1 : l;
  };

  useEffect(() => {
    const t = setTimeout(() => { if (q.trim().length >= 2) searchCards(q.trim()).then(setResults); }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const count = (code: number) => [...deck.main, ...deck.extra, ...deck.side].filter((c) => c === code).length;
  const add = (c: CardData, side = false) => {
    if (count(c.code) >= limitOf(c.code)) return;
    const key: keyof Deck = side ? "side" : isExtra(c) ? "extra" : "main";
    const cap = key === "main" ? fmt?.deck.mainMax ?? 60 : key === "extra" ? fmt?.deck.extraMax ?? 15 : fmt?.deck.sideMax ?? 15;
    if (deck[key].length >= cap) return;
    setDeck({ ...deck, [key]: [...deck[key], c.code] });
  };
  const remove = (key: keyof Deck, i: number) => setDeck({ ...deck, [key]: deck[key].filter((_, j) => j !== i) });
  const save = () => { const next = { ...all, [name]: deck }; saveDecks(next); setAll(next); setActiveDeck(name); };
  const load = (n: string) => { setName(n); setDeck(all[n]); };
  const del = () => { const next = { ...all }; delete next[name]; saveDecks(next); setAll(next); const first = Object.keys(next)[0]; if (first) load(first); };
  const exportYdk = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([toYdk(deck)], { type: "text/plain" }));
    a.download = `${name.replace(/[^\w-]+/g, "_")}.ydk`;
    a.click();
  };
  const importYdk = async (f: File) => { setDeck(parseYdk(await f.text())); setName(f.name.replace(/\.ydk$/i, "")); };

  return (
    <div className="deckbuilder">
      <div className="db-bar">
        <button className="ghost" onClick={onBack}>← Back</button>
        <select value={all[name] ? name : ""} onChange={(e) => load(e.target.value)}>
          {!all[name] && <option value="">(unsaved)</option>}
          {Object.keys(all).map((d) => <option key={d}>{d}</option>)}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Deck name" />
        <button className="primary" onClick={save}>Save</button>
        <select value={format} onChange={(e) => setFormat(e.target.value)} title="Format">
          {formats.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <button onClick={() => validateDeck(deck, format).then((r) => setIssues(r.ok ? [] : r.errors))}>Validate</button>
        <button onClick={() => file.current?.click()}>Import .ydk</button>
        <button onClick={exportYdk}>Export .ydk</button>
        <button className="danger" onClick={del}>Delete</button>
        <input ref={file} type="file" accept=".ydk" hidden onChange={(e) => e.target.files?.[0] && importYdk(e.target.files[0])} />
      </div>
      {issues && <div className={`db-issues${issues.length ? "" : " ok"}`} onClick={() => setIssues(null)}>{issues.length ? issues.join(" · ") : `Deck is legal in ${fmt?.name ?? format} ✓`}</div>}

      <div className="db-body">
        <Inspector code={hover} />
        <div className="db-deck">
          {(["main", "extra", "side"] as const).map((k) => (
            <section key={k}>
              <h3>{k} <small>{deck[k].length}{k === "main" && fmt ? ` / ${fmt.deck.mainMin}–${fmt.deck.mainMax}` : ""}</small></h3>
              <div className="db-grid">{deck[k].map((c, i) => <Slot key={`${c}-${i}`} code={c} limit={ban[c]} onRemove={() => remove(k, i)} onHover={setHover} />)}</div>
            </section>
          ))}
        </div>
        <div className="db-search">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cards by name…" />
          <p className="muted">Click to add · Shift+click to side deck</p>
          <div className="db-results">
            {results.map((c) => (
              <button key={c.code} className={`db-result${limitOf(c.code) === 0 ? " illegal" : ""}`} onClick={(e) => add(c, e.shiftKey)} onMouseEnter={() => setHover(c.code)}>
                <span className="thumb"><CardFace code={c.code} /><Ban limit={ban[c.code]} /></span>
                <span><b>{c.name}</b><small>{c.type.join(" ")}{c.atk !== undefined ? ` · ${c.atk}/${c.def ?? "-"}` : ""}</small></span>
                {count(c.code) > 0 && <em>{count(c.code)}</em>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
