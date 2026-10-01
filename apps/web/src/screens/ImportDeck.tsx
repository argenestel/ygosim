import { useEffect, useRef, useState } from "react";
import type { Deck } from "@ygosim/protocol";
import { getCard, resolveNames, thumbUrl } from "../api";
import { parseImport, type ImportKind } from "../decks/importers";
import { createProfile, setActiveProfile } from "../decks/store";
import { Modal } from "../ui/kit";

const EXTRA = ["Fusion", "Synchro", "Xyz", "Link"];
const KIND_LABEL: Record<ImportKind, string> = { ydk: ".ydk file", ydke: "ydke:// link", list: "Card list", unknown: "Unrecognised" };

export function ImportDeck({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [over, setOver] = useState(false);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [kind, setKind] = useState<ImportKind>("unknown");
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  // Parse (and resolve names for card lists) whenever the input settles.
  useEffect(() => {
    if (!text.trim()) { setDeck(null); setKind("unknown"); setMissing([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      const p = parseImport(text);
      setKind(p.kind);
      if (p.kind !== "list" || !p.names) { setDeck(p.kind === "unknown" ? null : p.deck); setMissing([]); return; }
      setBusy(true);
      const codes = await resolveNames(p.names.map((n) => n.name));
      if (!alive) return;
      const d: Deck = { main: [], extra: [], side: [] };
      const miss: string[] = [];
      await Promise.all(p.names.map(async (n, i) => {
        const code = codes[i];
        if (!code) { miss.push(n.name); return; }
        // Card lists often don't separate the Extra Deck; place by card type.
        let section = n.section;
        if (section === "main") { const c = await getCard(code); if (c.type.some((t) => EXTRA.includes(t))) section = "extra"; }
        for (let k = 0; k < n.count; k++) d[section].push(code);
      }));
      if (!alive) return;
      setDeck(d); setMissing(miss); setBusy(false);
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [text]);

  const readFile = async (f: File) => { setText(await f.text()); if (!name) setName(f.name.replace(/\.(ydk|txt)$/i, "")); };
  const total = deck ? deck.main.length + deck.extra.length + deck.side.length : 0;
  const save = () => {
    if (!deck) return;
    const p = createProfile(name.trim() || "Imported Deck", deck);
    setActiveProfile(p.id);
    onDone(p.id);
  };

  return (
    <Modal title="Import Deck" subtitle="Paste a .ydk file, a ydke:// link, or a card list like “3 Ash Blossom & Joyous Spring”." onClose={onClose} width={680}
      footer={<>
        {deck && <span className="muted"><b style={{ color: "var(--text)" }}>{deck.main.length}</b> main · <b style={{ color: "var(--text)" }}>{deck.extra.length}</b> extra · <b style={{ color: "var(--text)" }}>{deck.side.length}</b> side</span>}
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!deck || !total || busy} onClick={save}>Import deck</button>
      </>}>
      <label className="field"><span>Deck name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Deck" /></label>
      <div className={`dropzone${over ? " over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) readFile(f); }}>
        Drop a .ydk or .txt file here, or <button className="ghost" style={{ padding: "2px 6px", color: "var(--gold)" }} onClick={() => file.current?.click()}>browse</button>
        <input ref={file} type="file" accept=".ydk,.txt" hidden onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
      </div>
      <label className="field">
        <span>Or paste {text && <span className="chip" style={{ marginLeft: 6 }}>{KIND_LABEL[kind]}</span>}</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
          placeholder={"ydke://…\n\nor\n\n3 Blue-Eyes White Dragon\n2 Sage with Eyes of Blue\nExtra Deck:\n1 Blue-Eyes Ultimate Dragon"} />
      </label>
      {busy && <span className="muted">Matching card names…</span>}
      {missing.length > 0 && <div className="unresolved">Couldn’t find {missing.length} card{missing.length > 1 ? "s" : ""}: {missing.join(", ")}</div>}
      {deck && total > 0 && (
        <div className="mini-strip">{[...new Set([...deck.main, ...deck.extra])].slice(0, 18).map((c) => <img key={c} src={thumbUrl(c)} alt="" />)}</div>
      )}
    </Modal>
  );
}
