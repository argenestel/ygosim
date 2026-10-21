import { Fragment, memo, useMemo, useState } from "react";
import { CardThumb, Modal } from "../ui/kit";
import { deckTitle, duration, getGame, getRawLog, getTimeline, organizerToken, phaseText, reasonText, secs, setOrganizerToken, signatureCard,
  type GameView, type TDeck, type TPlayer, type TimelineEvent } from "./api";
import { BrandMark } from "./brandMarks";
import { useFollow, usePoll, useTimeline } from "./hooks";
import { parseTranscript, type LogLine } from "./rawlog";
import { Agent, ArtBg, Back, Empty, KindTag, StatePill, brandOf, isRoutinePass, useCards, useNow } from "./ui";

type Tab = "play" | "decks" | "logs";
const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export function MatchPage({ tid, gid, onBack, onReplay }: { tid: string; gid: string; onBack: (name?: string) => void; onReplay: (v: GameView) => void }) {
  const [view, err] = usePoll(() => getGame(tid, gid), [tid, gid], (v) => (v && v.game.status === "running" && v.tournament.state === "live" ? 3000 : false));
  const live = !!view && view.game.status === "running" && view.tournament.state === "live";
  const tl = useTimeline((cursor) => getTimeline(tid, gid, cursor, true), `${tid}/${gid}`, live);
  const [tab, setTab] = useState<Tab>("play");
  if (err && !view) return <div className="ar"><Back onClick={() => onBack()}>Tournament</Back><p className="err">{err}</p></div>;
  if (!view) return <div className="ar"><Back onClick={() => onBack()}>Tournament</Back><div className="spinner" /></div>;
  const { game: g, players, tournament: t } = view;
  const toolCount = tl.events.filter((e) => e.type === "tool").length;
  const moveCount = tl.events.filter((e) => e.type === "decision").length;

  return (
    <div className="ar ar-match-page">
      <Back onClick={() => onBack(t.name)}>{t.name}</Back>
      <div className="ar-tags"><KindTag kind={t.kind} /><StatePill state={live ? "live" : t.state === "paused" && g.status === "running" ? "paused" : "finished"} /></div>
      <Scoreboard view={view} live={live} onReplay={() => onReplay(view)} />
      {g.error && <div className="ar-callout bad"><b>This match didn't finish:</b> {g.error}</div>}

      <div className="ar-tabs" role="tablist">
        {([["play", "Play-by-play", moveCount], ["decks", "Decks", Object.keys(g.decks).length], ["logs", "Agent logs", toolCount]] as const).map(([k, l, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}{n ? <small>{n}</small> : null}</button>
        ))}
      </div>
      {tab === "play" && <PlayByPlay events={tl.events} players={players} live={live} startedAt={g.startedAt} loaded={tl.loaded} error={tl.error} />}
      {tab === "decks" && <Decks view={view} />}
      {tab === "logs" && <Logs view={view} events={tl.events} />}
    </div>
  );
}

function Scoreboard({ view, live, onReplay }: { view: GameView; live: boolean; onReplay: () => void }) {
  const { game: g, players, tournament: t } = view;
  const now = useNow(live);
  const elapsed = live && g.startedAt ? now - Date.parse(g.startedAt) : 0;
  const cap = (t.maxMinutes ?? 0) * 60_000;
  const dur = g.durationMs ?? (g.startedAt && g.endedAt ? Date.parse(g.endedAt) - Date.parse(g.startedAt) : 0);
  const winner = g.winner ? players.find((p) => p.id === g.winner) : undefined;
  const headline = g.status === "done" ? (winner ? `${winner.label} wins` : "Draw") : live ? "Live" : g.status === "error" ? "No result" : g.status === "running" ? "Stopped" : "Waiting to start";
  const detail = g.status === "done"
    ? [reasonText(g.reason), g.turns ? `${g.turns} turns` : "", duration(dur)].filter(Boolean).join(" · ")
    : live ? [g.live ? `Turn ${g.live.turn} · ${phaseText(g.live.phase)}` : Object.keys(g.decks).length < 2 ? "Agents are building decks" : "Duel starting", duration(elapsed)].filter(Boolean).join(" · ")
    : "";
  return (
    <section className={`ar-board${live ? " live" : ""}`}>
      <SeatPanel view={view} i={0} live={live} />
      <div className="ar-board-mid">
        <span className="eyebrow">{g.stage === "final" ? "Final" : g.stage === "series" ? `Game ${g.round}` : `Round ${g.round}`}</span>
        <strong className={live ? "live" : ""}>{live && <span className="ar-dot" />}{headline}</strong>
        {detail && <span className="ar-board-detail">{detail}</span>}
        {live && g.live && <span className="ar-board-detail">{players[g.live.turnPlayer]?.label} to play</span>}
        {live && cap > 0 && <span className="ar-cap wide" title={`${duration(elapsed)} of the ${t.maxMinutes}-minute cap`}><span style={{ width: `${Math.min(100, (elapsed / cap) * 100)}%` }} /></span>}
        <button className="primary" disabled={g.status === "pending"} onClick={onReplay}>{live ? "▶ Watch live" : "▶ Watch replay"}</button>
      </div>
      <SeatPanel view={view} i={1} live={live} />
    </section>
  );
}

function SeatPanel({ view, i, live }: { view: GameView; i: 0 | 1; live: boolean }) {
  const { game: g, players } = view;
  const p = players[i], id = g.seats[i], deck = g.decks[id], s = g.stats[id];
  const lp = g.lp?.[id] ?? g.live?.lp[i];
  const won = g.status === "done" && g.winner === id, lost = g.status === "done" && g.winner !== null && !won;
  const turn = live && g.live?.turnPlayer === i;
  return (
    <div className={`ar-board-seat s${i}${won ? " won" : ""}${lost ? " lost" : ""}${turn ? " turn" : ""}`}>
      <ArtBg code={signatureCard(deck)} side={i === 0 ? "left" : "right"} />
      <div className="ar-board-who">
        <Agent p={p} detail size="md" align={i === 1 ? "right" : "left"} />
        {won && <span className="chip gold">♛ Winner</span>}
        {turn && <span className="chip ok">Their turn</span>}
      </div>
      <span className={`ar-lp${lp !== undefined && lp <= 2000 ? " low" : ""}`}>{lp?.toLocaleString() ?? "8,000"}<small>LP</small></span>
      <span className="ar-board-deck">{deck ? deckTitle(deck) : g.status === "pending" ? "Deck not chosen yet" : "Building a deck…"}</span>
      {s && <span className="ar-board-stats"><b>{s.decisions}</b> moves · <b>{s.decisions ? secs(s.avgDecisionMs) : "—"}</b> avg think · <b>{s.invalid}</b> invalid{s.resumes ? <> · <b>{s.resumes}</b> restarts</> : null}</span>}
    </div>
  );
}

type Item =
  | { k: "turn"; turn: number; at: number }
  | { k: "passes"; n: number; at: number }
  | { k: "event"; e: Exclude<TimelineEvent, { type: "tool" }> };

function PlayByPlay({ events, players, live, startedAt, loaded, error }: { events: TimelineEvent[]; players: [TPlayer, TPlayer]; live: boolean; startedAt?: string; loaded: boolean; error?: string }) {
  const [seat, setSeat] = useState<"both" | 0 | 1>("both");
  const [passes, setPasses] = useState(false);
  const now = useNow(live);
  const items = useMemo(() => {
    const out: Item[] = [];
    let turn: number | undefined, run: { k: "passes"; n: number; at: number } | undefined;
    for (const e of events) {
      if (e.type === "tool") continue;
      if (e.type !== "result" && seat !== "both" && e.seat !== seat) continue;
      if (e.type === "decision" && e.turn !== undefined && e.turn !== turn) { turn = e.turn; run = undefined; out.push({ k: "turn", turn, at: e.at }); }
      if (e.type === "decision" && !passes && isRoutinePass(e.prompt.kind, e.choice)) {
        if (run) run.n++; else out.push(run = { k: "passes", n: 1, at: e.at });
        continue;
      }
      run = undefined;
      out.push({ k: "event", e });
    }
    return out;
  }, [events, seat, passes]);
  const lastAt = useMemo(() => events.reduce((m, e) => (e.type === "decision" ? Math.max(m, e.at) : m), -1), [events]);
  const sinceLast = live && startedAt && lastAt >= 0 ? now - (Date.parse(startedAt) + lastAt) : undefined;
  const { ref, onScroll, away, jump } = useFollow<HTMLOListElement>(items.length, live);

  return (
    <div className="ar-feed">
      <div className="ar-feed-bar">
        <div className="seg ar-seg">
          <button className={seat === "both" ? "on" : ""} onClick={() => setSeat("both")}>Both</button>
          {players.map((p, i) => <button key={p.id} className={seat === i ? "on" : ""} onClick={() => setSeat(i as 0 | 1)}>{p.label}</button>)}
        </div>
        <label className="ar-check"><input type="checkbox" checked={passes} onChange={(e) => setPasses(e.target.checked)} /> Show routine passes</label>
        <span className="spacer" />
        {sinceLast !== undefined && <span className="muted small">last move {secs(Math.max(0, sinceLast))} ago</span>}
      </div>
      <ol className={`ar-chat${live ? " live" : ""}`} ref={ref} onScroll={onScroll}>
        {items.map((it, idx) => it.k === "turn" ? <li key={`t${idx}`} className="ar-turn"><span>Turn {it.turn}</span></li>
          : it.k === "passes" ? <li key={`p${idx}`} className="ar-passes">{it.n} routine {it.n === 1 ? "pass" : "passes"}</li>
          : <Fragment key={`e${idx}`}><Bubble e={it.e} players={players} /></Fragment>)}
        {!items.length && <li className="ar-chat-empty">{!loaded ? "Loading…" : error ? `Play-by-play unavailable: ${error}` : live ? "Agents are researching cards and building their decks — moves appear here as they play." : "No moves were recorded for this match."}</li>}
      </ol>
      {live && away && <button className="ar-jump" onClick={jump}>↓ Latest</button>}
    </div>
  );
}

const Bubble = memo(function Bubble({ e, players }: { e: Exclude<TimelineEvent, { type: "tool" }>; players: [TPlayer, TPlayer] }) {
  if (e.type === "result") {
    const w = e.winner ? players.find((p) => p.id === e.winner) : undefined;
    const lp = e.lp ? players.map((p) => e.lp![p.id]?.toLocaleString() ?? "—").join(" – ") : "";
    return <li className="ar-final"><span className="ar-crown" aria-hidden="true">♛</span><b>{w ? `${w.label} wins` : "Draw"}</b><span>{[reasonText(e.reason), lp && `${lp} LP`, e.turns && `${e.turns} turns`].filter(Boolean).join(" · ")}</span></li>;
  }
  const p = players[e.seat];
  return (
    <li className={`ar-bubble s${e.seat}`}>
      <div className="ar-bubble-head">
        <BrandMark brand={brandOf(p)} size="sm" className="ar-mark-only" /><b>{p.label}</b>
        <span>{e.type === "deck" ? "Registered a deck" : e.prompt.label}</span>
        {e.type === "decision" && e.phase && <span>{phaseText(e.phase)}</span>}
        <span className="spacer" />
        <span className="ar-bubble-time"><span title="Time into the match">{clock(e.at)}</span>{e.type === "decision" && e.thinkMs !== undefined && <span title="Time this agent took to decide">{secs(e.thinkMs)} think</span>}</span>
      </div>
      {e.type === "deck"
        ? <div className="ar-bubble-choice">{e.title} <small>{e.size.main} main · {e.size.extra} extra{e.size.side ? ` · ${e.size.side} side` : ""}</small></div>
        : <div className="ar-bubble-choice">{e.choice.join(", ")}</div>}
      {e.reason ? <Clamp text={e.reason} lines={e.type === "deck" ? 3 : 6} /> : e.type === "decision" ? <p className="muted">No reason given.</p> : null}
    </li>
  );
});

function Clamp({ text, lines }: { text: string; lines: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 90;
  return (
    <div className="ar-clamp">
      <p style={!open && long ? { WebkitLineClamp: lines } : undefined} className={!open && long ? "clamped" : ""}>{text}</p>
      {long && <button className="ghost ar-more" onClick={() => setOpen(!open)}>{open ? "Show less" : "Read more"}</button>}
    </div>
  );
}

function Decks({ view }: { view: GameView }) {
  const { game: g, players } = view;
  return (
    <div className="ar-decks">
      {players.map((p, i) => <DeckPanel key={p.id} p={p} deck={g.decks[g.seats[i]]} won={g.status === "done" && g.winner === g.seats[i]} pending={g.status === "pending"} />)}
    </div>
  );
}

function DeckPanel({ p, deck, won, pending }: { p: TPlayer; deck?: TDeck; won: boolean; pending: boolean }) {
  const codes = useMemo(() => (deck ? [...new Set([...deck.main, ...deck.extra, ...(deck.side ?? [])])] : []), [deck]);
  const card = useCards(codes);
  const groups = useMemo(() => {
    if (!deck) return [];
    const tally = (list: number[]) => { const m = new Map<number, number>(); list.forEach((c) => m.set(c, (m.get(c) ?? 0) + 1)); return [...m]; };
    const main = tally(deck.main);
    const kind = (c: number) => card(c)?.type?.[0] ?? "Main";
    const byKind = (k: string) => main.filter(([c]) => kind(c) === k);
    const typed = main.some(([c]) => card(c));
    const out: [string, [number, number][]][] = typed
      ? [["Monsters", byKind("Monster")], ["Spells", byKind("Spell")], ["Traps", byKind("Trap")], ["Main", main.filter(([c]) => !["Monster", "Spell", "Trap"].includes(kind(c)))]]
      : [["Main deck", main]];
    out.push(["Extra deck", tally(deck.extra)], ["Side deck", tally(deck.side ?? [])]);
    return out.filter(([, rows]) => rows.length);
  }, [deck, card]);
  return (
    <section className={`ar-deck${won ? " won" : ""}`}>
      <div className="ar-deck-head">
        <Agent p={p} size="sm" />
        {won && <span className="chip gold">♛ Winner</span>}
      </div>
      {!deck ? <p className="muted">{pending ? "Waiting to start." : "Still building a deck…"}</p> : <>
        <h3>{deckTitle(deck)}</h3>
        <div className="ar-deck-meta">
          <span className={`chip${deck.source === "custom" ? " gold" : ""}`}>{deck.source === "custom" ? "Built by the agent" : "Sample deck"}</span>
          <span className="muted small">{deck.main.length} main · {deck.extra.length} extra{deck.side?.length ? ` · ${deck.side.length} side` : ""}</span>
        </div>
        {deck.reason && <blockquote className="ar-deck-why"><span className="eyebrow">Why this deck</span>{deck.reason}</blockquote>}
        {groups.map(([name, rows]) => (
          <div key={name} className="ar-deck-group">
            <span className="eyebrow">{name} · {rows.reduce((n, [, k]) => n + k, 0)}</span>
            <div className="ar-cardgrid">{rows.map(([c, n]) => <CardThumb key={c} code={c} count={n > 1 ? n : undefined} title={card(c)?.name ?? `#${c}`} />)}</div>
          </div>
        ))}
      </>}
    </section>
  );
}

function Logs({ view, events }: { view: GameView; events: TimelineEvent[] }) {
  const [sub, setSub] = useState<"tools" | "raw">("tools");
  const [seat, setSeat] = useState<0 | 1>(0);
  const { players } = view;
  const live = view.game.status === "running" && view.tournament.state === "live";
  const tools = useMemo(() => events.filter((e): e is Extract<TimelineEvent, { type: "tool" }> => e.type === "tool"), [events]);
  const { ref, onScroll, away, jump } = useFollow<HTMLOListElement>(tools.length, live);
  return (
    <div className="ar-feed">
      <div className="ar-feed-bar">
        <div className="seg ar-seg">
          <button className={sub === "tools" ? "on" : ""} onClick={() => setSub("tools")}>Tool calls</button>
          <button className={sub === "raw" ? "on" : ""} onClick={() => setSub("raw")}>Raw output</button>
        </div>
        {sub === "raw" && <div className="seg ar-seg">{players.map((p, i) => <button key={p.id} className={seat === i ? "on" : ""} onClick={() => setSeat(i as 0 | 1)}>{p.label}</button>)}</div>}
      </div>
      {sub === "tools" ? (
        <>
          <ol className={`ar-log${live ? " live" : ""}`} ref={ref} onScroll={onScroll}>
            {tools.map((e, i) => (
              <li key={i} className={`s${e.seat}${e.ok ? "" : " bad"}`}>
                <span className="ar-log-time">{clock(e.at)}</span>
                <b className="ar-log-who">{players[e.seat].label}</b>
                <code>{e.tool}</code>
                <span className="ar-log-sum">{e.summary}</span>
                <span className="muted small">{e.ok ? secs(e.ms) : "failed"}</span>
              </li>
            ))}
            {!tools.length && <li className="ar-chat-empty">No tool calls recorded yet.</li>}
          </ol>
          {live && away && <button className="ar-jump" onClick={jump}>↓ Latest</button>}
        </>
      ) : <RawLog tid={view.tournament.id} gid={view.game.id} pid={view.game.seats[seat]} live={live} />}
    </div>
  );
}

function RawLog({ tid, gid, pid, live }: { tid: string; gid: string; pid: string; live: boolean }) {
  const [kind, setKind] = useState<"transcript" | "stderr">("transcript");
  const [keyOpen, setKeyOpen] = useState(false);
  const [rev, setRev] = useState(0);
  const [text, err] = usePoll(() => getRawLog(tid, gid, pid, kind), [tid, gid, pid, kind, live, rev], () => live && 3000);
  const lines = useMemo<LogLine[]>(() => kind === "transcript" ? parseTranscript(text ?? "") : (text ?? "").split("\n").filter(Boolean).map((t) => ({ kind: "raw" as const, text: t })), [text, kind]);
  const { ref, onScroll, away, jump } = useFollow<HTMLOListElement>(lines.length, live);
  const locked = err?.includes("403");
  return (
    <>
      {locked ? (
        <Empty title="Organizer only">
          Raw CLI output can include provider details, so it needs the organizer token (<code>YGOSIM_TOURNAMENT_READ_TOKEN</code>).{" "}
          <button className="ar-inline" onClick={() => setKeyOpen(true)}>Enter token</button>
        </Empty>
      ) : (
        <>
          <div className="ar-feed-bar sub">
            <div className="seg ar-seg"><button className={kind === "transcript" ? "on" : ""} onClick={() => setKind("transcript")}>Agent output</button><button className={kind === "stderr" ? "on" : ""} onClick={() => setKind("stderr")}>stderr</button></div>
            <span className="muted small">Last 512 KB{organizerToken() ? <> · <button className="ar-inline" onClick={() => setKeyOpen(true)}>Change token</button></> : null}</span>
          </div>
          <ol className={`ar-log raw${live ? " live" : ""}`} ref={ref} onScroll={onScroll}>
            {lines.map((l, i) => <li key={i} className={`raw-${l.kind}`}><span className="ar-log-kind">{l.kind === "say" ? "message" : l.kind === "think" ? "thinking" : l.kind}</span><span className="ar-log-sum">{l.text}</span></li>)}
            {!lines.length && <li className="ar-chat-empty">{err ? `Raw log unavailable: ${err}` : text === undefined ? "Loading…" : "Nothing logged yet."}</li>}
          </ol>
          {live && away && <button className="ar-jump" onClick={jump}>↓ Latest</button>}
        </>
      )}
      {keyOpen && <KeyModal onClose={(changed) => { setKeyOpen(false); if (changed) setRev((n) => n + 1); }} />}
    </>
  );
}

function KeyModal({ onClose }: { onClose: (changed: boolean) => void }) {
  const [value, setValue] = useState(organizerToken());
  const save = (v: string) => { setOrganizerToken(v.trim()); onClose(true); };
  return (
    <Modal title="Organizer access" subtitle="Paste YGOSIM_TOURNAMENT_READ_TOKEN to read raw agent transcripts and stderr. Stored only in this browser." onClose={() => onClose(false)} width={520}
      footer={<><button className="ghost" onClick={() => save("")}>Clear</button><span className="spacer" /><button className="primary" onClick={() => save(value)}>Save</button></>}>
      <input type="password" autoFocus value={value} placeholder="Organizer token" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save(value)} style={{ width: "100%" }} />
    </Modal>
  );
}
