import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { CardData, Deck } from "@ygosim/protocol";
import { artUrl, browseCards, getCard, validateDeck, type CardQuery } from "../api";
import { prefFormat, setPrefFormat } from "../deck";
import { toYdk, toYdke } from "../decks/importers";
import { getProfile, saveProfile, setActiveProfile, type DeckProfile } from "../decks/store";
import { useCardData } from "../duel/Inspector";
import { CardThumb, useBanlist, useCopy, useFormats, type Limit } from "../ui/kit";

type Zone = keyof Deck;
const EXTRA_T = ["Fusion", "Synchro", "Xyz", "Link"];
const isExtra = (c?: CardData) => !!c && c.type.some((t) => EXTRA_T.includes(t));
const ATTRS = ["DARK", "LIGHT", "EARTH", "WATER", "FIRE", "WIND", "DIVINE"];
const RACES = ["Aqua", "Beast", "Beast-Warrior", "Cyberse", "Dinosaur", "Divine-Beast", "Dragon", "Fairy", "Fiend", "Fish", "Illusion", "Insect", "Machine", "Plant", "Psychic", "Pyro", "Reptile", "Rock", "Sea Serpent", "Spellcaster", "Thunder", "Warrior", "Winged Beast", "Wyrm", "Zombie"];
const PAGE = 60;

function typeRank(c?: CardData) {
  if (!c) return 9;
  if (c.type.includes("Monster")) return c.type.some((t) => EXTRA_T.includes(t)) ? 3 : 0;
  return c.type.includes("Spell") ? 1 : 2;
}

export function DeckEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const [profile, setProfile] = useState<DeckProfile | undefined>(() => getProfile(id));
  const [selected, setSelected] = useState<number | undefined>(profile?.cover);
  const [format, setFormat] = useState(prefFormat());
  const formats = useFormats();
  const ban = useBanlist(format);
  const fmt = formats.find((f) => f.id === format);
  const [issues, setIssues] = useState<string[] | null>(null);
  const [dropZone, setDropZone] = useState<Zone | null>(null);
  const [copied, copy] = useCopy();

  // Autosave on every change.
  const update = useCallback((fn: (d: Deck) => Deck, cover?: number) => {
    setProfile((p) => {
      if (!p) return p;
      const next = { ...p, deck: fn(p.deck), ...(cover !== undefined ? { cover } : {}) };
      saveProfile(next);
      return next;
    });
  }, []);

  // Live legality check (debounced).
  useEffect(() => {
    if (!profile) return;
    const t = setTimeout(() => validateDeck(profile.deck, format).then((r) => setIssues(r.ok ? [] : r.errors)), 500);
    return () => clearTimeout(t);
  }, [profile, format]);
  useEffect(() => setPrefFormat(format), [format]);

  const counts = useMemo(() => {
    const m = new Map<number, number>();
    if (profile) for (const c of [...profile.deck.main, ...profile.deck.extra, ...profile.deck.side]) m.set(c, (m.get(c) ?? 0) + 1);
    return m;
  }, [profile]);

  const whitelist = !!fmt?.whitelist && Object.keys(ban).length > 0;
  const limitOf = (code: number): number => {
    const l = ban[code];
    if (l === undefined) return whitelist ? 0 : 3;
    return fmt?.traditional && l === 0 ? 1 : l;
  };
  const caps: Record<Zone, number> = { main: fmt?.deck.mainMax ?? 60, extra: fmt?.deck.extraMax ?? 15, side: fmt?.deck.sideMax ?? 15 };

  const add = async (code: number, toSide = false) => {
    if (!profile) return;
    const card = await getCard(code);
    if ((counts.get(code) ?? 0) >= limitOf(code)) return;
    const zone: Zone = toSide ? "side" : isExtra(card) ? "extra" : "main";
    if (profile.deck[zone].length >= caps[zone]) return;
    update((d) => ({ ...d, [zone]: [...d[zone], code] }), profile.cover ?? code);
  };
  const removeAt = (zone: Zone, i: number) => update((d) => ({ ...d, [zone]: d[zone].filter((_, j) => j !== i) }));
  const removeOne = (code: number) => {
    if (!profile) return;
    for (const z of ["side", "extra", "main"] as Zone[]) {
      const i = profile.deck[z].lastIndexOf(code);
      if (i >= 0) return removeAt(z, i);
    }
  };
  const move = async (from: Zone, i: number, to: Zone) => {
    if (!profile || from === to) return;
    const code = profile.deck[from][i];
    const card = await getCard(code);
    if (to !== "side" && (to === "extra") !== isExtra(card)) return;
    if (profile.deck[to].length >= caps[to]) return;
    update((d) => { const f = d[from].filter((_, j) => j !== i); return { ...d, [from]: f, [to]: [...d[to], code] }; });
  };
  const sortDeck = async () => {
    if (!profile) return;
    const all = [...new Set([...profile.deck.main, ...profile.deck.extra, ...profile.deck.side])];
    const data = new Map((await Promise.all(all.map(getCard))).map((c) => [c.code, c]));
    const key = (c: number) => { const d = data.get(c); return [typeRank(d), -(d?.level ?? 0), d?.name ?? ""] as const; };
    const cmp = (a: number, b: number) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); };
    update((d) => ({ main: [...d.main].sort(cmp), extra: [...d.extra].sort(cmp), side: [...d.side].sort(cmp) }));
  };

  // Delete removes the selected card; drag data carries origin.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selected && !(e.target instanceof HTMLInputElement)) removeOne(selected);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const onDrop = (zone: Zone) => (e: DragEvent) => {
    e.preventDefault(); setDropZone(null);
    const code = Number(e.dataTransfer.getData("code"));
    const from = e.dataTransfer.getData("from") as Zone | "";
    const idx = Number(e.dataTransfer.getData("index"));
    if (!code) return;
    if (from) move(from, idx, zone); else add(code, zone === "side");
  };

  if (!profile) return <div className="duel-wait"><p>Deck not found.</p><button onClick={onBack}>Back</button></div>;
  const d = profile.deck;
  const zoneMeta: { z: Zone; label: string; wide: boolean; warn?: string }[] = [
    { z: "main", label: "Main Deck", wide: false, warn: fmt && (d.main.length < fmt.deck.mainMin || d.main.length > fmt.deck.mainMax) ? `needs ${fmt.deck.mainMin}–${fmt.deck.mainMax}` : undefined },
    { z: "extra", label: "Extra Deck", wide: true },
    { z: "side", label: "Side Deck", wide: true },
  ];

  return (
    <div className="editor">
      <div className="editor-bar">
        <button className="ghost" onClick={onBack}>← Decks</button>
        <input className="name" value={profile.name} onChange={(e) => { const next = { ...profile, name: e.target.value }; setProfile(next); saveProfile(next); }} />
        {issues === null ? <span className="chip">Checking…</span> : issues.length === 0 ? <span className="chip ok">Legal in {fmt?.name ?? format}</span> : <span className="chip bad" title={issues.join("\n")}>{issues.length} issue{issues.length > 1 ? "s" : ""}</span>}
        <span className="spacer" />
        <select value={format} onChange={(e) => setFormat(e.target.value)} title="Format">{formats.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
        <button onClick={sortDeck}>Sort</button>
        <button onClick={() => copy(toYdke(d))}>{copied === toYdke(d) ? "Copied ✓" : "Copy ydke"}</button>
        <button onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([toYdk(d)], { type: "text/plain" })); a.download = `${profile.name.replace(/[^\w-]+/g, "_")}.ydk`; a.click(); }}>Export .ydk</button>
        <button className="primary" onClick={() => { setActiveProfile(profile.id); onBack(); }}>Use this deck</button>
      </div>
      <div className="editor-body">
        <CardDetail code={selected} count={selected ? counts.get(selected) ?? 0 : 0} limit={selected ? limitOf(selected) : 3}
          isCover={selected === profile.cover}
          onAdd={() => selected && add(selected)} onSide={() => selected && add(selected, true)} onRemove={() => selected && removeOne(selected)}
          onCover={() => selected && update((x) => x, selected)} />

        <div className="zones">
          {issues && issues.length > 0 && <div className="unresolved">{issues.slice(0, 4).join(" · ")}{issues.length > 4 ? ` · +${issues.length - 4} more` : ""}</div>}
          {zoneMeta.map(({ z, label, wide, warn }) => (
            <div className="zone-block" key={z}>
              <h4>{label} <b>{d[z].length}</b>{warn && <span className="warn">{warn}</span>}</h4>
              <div className={`zone-grid${wide ? " wide" : ""}${dropZone === z ? " drop" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDropZone(z); }} onDragLeave={() => setDropZone(null)} onDrop={onDrop(z)}>
                {d[z].length === 0 && <div className="hint">Drag cards here, or click a card on the right to add it.</div>}
                {d[z].map((c, i) => (
                  <CardThumb key={`${z}${i}`} code={c} limit={ban[c] as Limit | undefined} className={selected === c ? "sel" : ""}
                    title="Click to inspect · Right-click to remove · Drag to move"
                    onClick={() => setSelected(c)} onContextMenu={() => removeAt(z, i)} onMouseEnter={() => setSelected(c)}
                    draggable onDragStart={(e) => { e.dataTransfer.setData("code", String(c)); e.dataTransfer.setData("from", z); e.dataTransfer.setData("index", String(i)); }} />
                ))}
              </div>
            </div>
          ))}
          <p className="muted">Tip: right-click removes a card, <b>Shift</b>-click in the browser adds to the Side Deck, <b>Del</b> removes the selected card.</p>
        </div>

        <CardBrowser counts={counts} ban={ban} limitOf={limitOf} onAdd={add} onInspect={setSelected} />
      </div>
    </div>
  );
}

function CardDetail({ code, count, limit, isCover, onAdd, onSide, onRemove, onCover }: { code?: number; count: number; limit: number; isCover: boolean; onAdd: () => void; onSide: () => void; onRemove: () => void; onCover: () => void }) {
  const c = useCardData(code);
  if (code === undefined) return <aside className="detail empty">Hover or click a card to see its details.</aside>;
  return (
    <aside className="detail">
      <div className="art"><img src={artUrl(code)} alt={c?.name ?? ""} /></div>
      <h3>{c?.name ?? "…"}</h3>
      {c && <div className="meta">{c.type.join(" / ")}{c.attribute && ` · ${c.attribute}`}{c.race && ` · ${c.race}`}{c.level !== undefined && ` · ${c.type.includes("Xyz") ? "Rank" : c.linkMarkers ? "Link" : "Lv"} ${c.level}`}</div>}
      {c && c.type.includes("Monster") && (c.atk !== undefined || c.atkUnknown) && <div className="stats">ATK {c.atkUnknown ? "?" : c.atk}{!c.linkMarkers && (c.def !== undefined || c.defUnknown) ? ` / DEF ${c.defUnknown ? "?" : c.def}` : ""}</div>}
      <div className="actions">
        <button onClick={onAdd} disabled={count >= limit}>+ Add</button>
        <button onClick={onSide} disabled={count >= limit}>+ Side</button>
        <button onClick={onRemove} disabled={!count}>− Remove</button>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="chip">{count} / {limit} in deck</span>
        <button className="ghost" style={{ marginLeft: "auto", padding: "4px 8px", fontSize: "0.78rem" }} disabled={isCover} onClick={onCover}>{isCover ? "★ Cover card" : "Set as cover"}</button>
      </div>
      <div className="desc">{c?.desc}</div>
    </aside>
  );
}

function CardBrowser({ counts, ban, limitOf, onAdd, onInspect }: { counts: Map<number, number>; ban: Record<number, Limit>; limitOf: (c: number) => number; onAdd: (c: number, side?: boolean) => void; onInspect: (c: number) => void }) {
  const [q, setQ] = useState<CardQuery>({ sort: "name" });
  const [cards, setCards] = useState<CardData[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async (reset: boolean, offset: number) => {
    const id = ++reqId.current;
    setLoading(true);
    const r = await browseCards({ ...q, offset, limit: PAGE });
    if (id !== reqId.current) return;
    setTotal(r.total);
    setCards((prev) => (reset ? r.cards : [...prev, ...r.cards]));
    setLoading(false);
  }, [q]);

  useEffect(() => {
    const t = setTimeout(() => { box.current?.scrollTo({ top: 0 }); load(true, 0); }, q.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q.q]);

  const onScroll = () => {
    const el = box.current;
    if (!el || loading || cards.length >= total) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 300) load(false, cards.length);
  };
  const set = (patch: Partial<CardQuery>) => setQ((p) => ({ ...p, ...patch }));
  const isMonster = !q.kind || q.kind === "monster" || q.kind === "extra";

  return (
    <aside className="browser">
      <div className="browser-head">
        <div className="search"><input autoFocus placeholder="Search card name or text…" value={q.q ?? ""} onChange={(e) => set({ q: e.target.value })} /></div>
        <div className="seg" style={{ width: "100%" }}>
          {([["", "All"], ["monster", "Monster"], ["spell", "Spell"], ["trap", "Trap"], ["extra", "Extra"]] as const).map(([k, l]) => (
            <button key={k} style={{ flex: 1 }} className={(q.kind ?? "") === k ? "on" : ""} onClick={() => set({ kind: (k || undefined) as CardQuery["kind"], ...(k === "spell" || k === "trap" ? { attribute: undefined, race: undefined, level: undefined } : {}) })}>{l}</button>
          ))}
        </div>
        <div className="filters">
          {isMonster && <>
            <select value={q.attribute ?? ""} onChange={(e) => set({ attribute: e.target.value || undefined })}><option value="">Attribute</option>{ATTRS.map((a) => <option key={a}>{a}</option>)}</select>
            <select value={q.race ?? ""} onChange={(e) => set({ race: e.target.value || undefined })}><option value="">Type</option>{RACES.map((a) => <option key={a}>{a}</option>)}</select>
            <select value={q.level ?? ""} onChange={(e) => set({ level: e.target.value ? Number(e.target.value) : undefined })}><option value="">Level</option>{Array.from({ length: 13 }, (_, i) => <option key={i} value={i}>{i}</option>)}</select>
          </>}
          <select value={q.sort} onChange={(e) => set({ sort: e.target.value as CardQuery["sort"] })}><option value="name">Sort: Name</option><option value="atk">Sort: ATK</option><option value="level">Sort: Level</option></select>
        </div>
      </div>
      <div className="result-grid" ref={box} onScroll={onScroll}>
        {cards.map((c) => (
          <CardThumb key={c.code} code={c.code} limit={ban[c.code]} count={counts.get(c.code)}
            className={(counts.get(c.code) ?? 0) >= limitOf(c.code) ? "dim" : ""}
            title={`${c.name}\nClick: add · Shift-click: side · Right-click: inspect`}
            onClick={(e) => (e.shiftKey ? onAdd(c.code, true) : onAdd(c.code))} onContextMenu={() => onInspect(c.code)} onMouseEnter={() => onInspect(c.code)}
            draggable onDragStart={(e) => e.dataTransfer.setData("code", String(c.code))} />
        ))}
        <div className="result-foot">{loading ? "Loading…" : cards.length === 0 ? "No cards match." : cards.length >= total ? `${total} cards` : ""}</div>
      </div>
    </aside>
  );
}
