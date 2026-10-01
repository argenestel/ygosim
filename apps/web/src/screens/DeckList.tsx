import { useEffect, useState } from "react";
import { cropUrl } from "../api";
import { toYdk } from "../decks/importers";
import { activeProfileId, coverOf, createProfile, deleteProfile, duplicateProfile, listProfiles, onDecksChanged, setActiveProfile } from "../decks/store";
import { ImportDeck } from "./ImportDeck";

export function DeckList({ onEdit }: { onEdit: (id: string) => void }) {
  const [decks, setDecks] = useState(listProfiles());
  const [active, setActive] = useState(activeProfileId());
  const [importing, setImporting] = useState(false);
  useEffect(() => onDecksChanged(() => { setDecks(listProfiles()); setActive(activeProfileId()); }), []);

  const download = (name: string, text: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `${name.replace(/[^\w-]+/g, "_")}.ydk`;
    a.click();
  };

  return (
    <div className="decks-page">
      <div className="page-head">
        <h1>Decks</h1>
        <button onClick={() => setImporting(true)}>Import</button>
        <button className="primary" onClick={() => onEdit(createProfile("New Deck").id)}>New Deck</button>
      </div>
      <div className="deck-grid">
        {decks.map((d) => {
          const cover = coverOf(d);
          return (
            <div key={d.id} className={`deck-tile${d.id === active ? " active" : ""}`} role="button" tabIndex={0}
              onClick={() => onEdit(d.id)} onKeyDown={(e) => e.key === "Enter" && onEdit(d.id)}>
              {d.id === active && <span className="chip gold badge-active">In use</span>}
              <div className="tile-actions" onClick={(e) => e.stopPropagation()}>
                {d.id !== active && <button onClick={() => setActiveProfile(d.id)}>Use</button>}
                <button onClick={() => duplicateProfile(d.id)} title="Duplicate">⧉</button>
                <button onClick={() => download(d.name, toYdk(d.deck))} title="Export .ydk">⤓</button>
                <button className="danger" onClick={() => { if (confirm(`Delete "${d.name}"?`)) deleteProfile(d.id); }} title="Delete">✕</button>
              </div>
              <div style={{ overflow: "hidden" }}><div className="art" style={cover ? { backgroundImage: `url(${cropUrl(cover)})` } : undefined} /></div>
              <div className="meta">
                <b>{d.name}</b>
                <div className="counts"><span><b>{d.deck.main.length}</b> M</span><span><b>{d.deck.extra.length}</b> E</span><span><b>{d.deck.side.length}</b> S</span></div>
              </div>
            </div>
          );
        })}
        <button className="deck-tile new" onClick={() => setImporting(true)}><span>＋</span>Import a deck</button>
      </div>
      {importing && <ImportDeck onClose={() => setImporting(false)} onDone={(id) => { setImporting(false); onEdit(id); }} />}
    </div>
  );
}
