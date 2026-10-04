import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/kit";
import { getDecisions, getLeaderboard, getTournament, listTournaments, pct, secs,
  type Decision, type Leaderboard, type Standing, type TGame, type TSummary, type Tournament } from "./api";

const CLI_TAG: Record<string, string> = { codex: "Codex", pi: "pi", claude: "Claude Code" };

function usePoll<T>(load: () => Promise<T>, deps: unknown[], live: (v: T | undefined) => boolean) {
  const [v, setV] = useState<T>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let on = true, timer: ReturnType<typeof setTimeout>;
    const tick = () => load().then((x) => { if (!on) return; setV(x); setErr(undefined); if (live(x)) timer = setTimeout(tick, 5000); })
      .catch((e) => { if (on) { setErr(String(e.message ?? e)); timer = setTimeout(tick, 10000); } });
    tick();
    return () => { on = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [v, err] as const;
}

export function TournamentScreen({ onReplay }: { onReplay: (t: Tournament, g: TGame) => void }) {
  const [list, listErr] = usePoll(listTournaments, [], () => true);
  const [sel, setSel] = useState<string | "board">("board");

  return (
    <div className="tourney">
      <div className="page-head">
        <h1>Agent Tournament</h1>
        <select value={sel} onChange={(e) => setSel(e.target.value)} aria-label="Tournament">
          <option value="board">All-time leaderboard</option>
          {list?.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.done}/{t.total}{t.status === "running" ? " · live" : ""}</option>)}
        </select>
      </div>
      {listErr && !list && <p className="err">Tournament API unavailable: {listErr}</p>}
      {sel === "board" ? <AllTime list={list ?? []} onOpen={setSel} /> : <TournamentView key={sel} tid={sel} onReplay={onReplay} />}
    </div>
  );
}

function AllTime({ list, onOpen }: { list: TSummary[]; onOpen: (id: string) => void }) {
  const [lb, err] = usePoll<Leaderboard>(getLeaderboard, [], () => list.some((t) => t.status === "running"));
  return (
    <>
      <section className="t-section">
        <h2>Benchmark leaderboard</h2>
        <p className="muted">Every finished game across all tournaments. Elo starts at 1500 (K=32); win = 3 pts, draw = 1.</p>
        {err && !lb && <p className="err">{err}</p>}
        {lb && <StandingsTable rows={lb.players} />}
      </section>
      {lb && lb.decks.length > 0 && (
        <section className="t-section">
          <h2>Deck meta</h2>
          <p className="muted">Which decks the agents chose, and how they fared.</p>
          <div className="t-table-wrap">
            <table className="t-table">
              <thead><tr><th>Deck</th><th>Source</th><th className="n">Picks</th><th className="n">Wins</th><th className="n">Win%</th><th>Picked by</th></tr></thead>
              <tbody>
                {[...lb.decks].sort((a, b) => b.picks - a.picks).map((d) => (
                  <tr key={`${d.source}:${d.name}`}>
                    <td><b>{d.name}</b></td>
                    <td><span className={`chip${d.source === "custom" ? " gold" : ""}`}>{d.source}</span></td>
                    <td className="n">{d.picks}</td><td className="n">{d.wins}</td><td className="n">{d.picks ? pct(d.wins / d.picks) : "—"}</td>
                    <td className="muted">{Object.entries(d.pickedBy).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${lb.players.find((x) => x.id === p)?.label ?? p} ×${n}`).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="t-section">
        <h2>Tournaments</h2>
        {!list.length && <p className="muted">No tournaments yet. Start one with <code>pnpm --filter @ygosim/tournament start</code>.</p>}
        <div className="t-list">
          {list.map((t) => (
            <button key={t.id} className="t-list-item" onClick={() => onOpen(t.id)}>
              <b>{t.name}</b>
              <span className={`chip${t.status === "running" ? " ok" : ""}`}>{t.status === "running" ? "Live" : "Finished"}</span>
              <span className="muted">{new Date(t.createdAt).toLocaleString()} · {t.players.length} agents · {t.done}/{t.total} games</span>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function StandingsTable({ rows }: { rows: Standing[] }) {
  const sorted = [...rows].sort((a, b) => b.points - a.points || b.elo - a.elo);
  return (
    <div className="t-table-wrap">
      <table className="t-table">
        <thead><tr>
          <th className="n">#</th><th>Agent</th><th className="n">Pts</th><th className="n">W-L-D</th><th className="n">Elo</th><th className="n">Win%</th>
          <th className="n" title="Average duel length in turns">Turns</th><th className="n" title="Average time per decision">Think</th>
          <th className="n" title="Share of decisions that came with a reason">Reasons</th><th className="n" title="Rejected/illegal actions per decision">Invalid</th>
          <th className="n" title="Games lost to the agent stopping or crashing">Crashes</th><th>Decks played</th>
        </tr></thead>
        <tbody>
          {sorted.map((s, i) => (
            <tr key={s.id}>
              <td className="n rank">{i + 1}</td>
              <td><b>{s.label}</b><div className="muted small">{s.model}</div></td>
              <td className="n"><b>{s.points}</b></td>
              <td className="n">{s.wins}-{s.losses}-{s.draws}</td>
              <td className="n">{Math.round(s.elo)}</td>
              <td className="n"><span className="bar" style={{ ["--w" as string]: pct(s.winRate) }}>{s.played ? pct(s.winRate) : "—"}</span></td>
              <td className="n">{s.avgTurns ? s.avgTurns.toFixed(1) : "—"}</td>
              <td className="n">{s.avgDecisionMs ? secs(s.avgDecisionMs) : "—"}</td>
              <td className="n">{pct(s.reasonRate)}</td>
              <td className="n">{pct(s.invalidRate)}</td>
              <td className={`n${s.crashes ? " err" : ""}`}>{s.crashes}</td>
              <td className="muted small">{s.decks.map((d) => `${d.name} ${d.wins}/${d.played}`).join(" · ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TournamentView({ tid, onReplay }: { tid: string; onReplay: (t: Tournament, g: TGame) => void }) {
  const [t, err] = usePoll(() => getTournament(tid), [tid], (x) => x?.status === "running");
  const [open, setOpen] = useState<TGame | null>(null);
  if (err && !t) return <p className="err">{err}</p>;
  if (!t) return <div className="spinner" />;
  const label = (pid: string) => t.players.find((p) => p.id === pid)?.label ?? pid;
  const done = t.games.filter((g) => g.status === "done").length;
  const stages = [...new Set(t.games.map((g) => g.stage))];

  return (
    <>
      <div className="row t-meta">
        <span className={`chip${t.status === "running" ? " ok" : ""}`}>{t.status === "running" ? "● Live" : "Finished"}</span>
        <span className="muted">{t.format} · {done}/{t.games.length} games · started {new Date(t.createdAt).toLocaleString()}</span>
      </div>
      <div className="t-roster">
        {t.players.map((p) => <span key={p.id} className="chip" title={p.model}>{p.label} <small>{CLI_TAG[p.cli] ?? p.cli}{p.effort ? ` · ${p.effort}` : ""}</small></span>)}
      </div>
      <section className="t-section"><h2>Standings</h2><StandingsTable rows={t.standings} /></section>
      <section className="t-section"><h2>Head to head</h2><CrossTable t={t} label={label} onOpen={setOpen} /></section>
      {stages.map((st) => (
        <section className="t-section" key={st}>
          <h2>{st === "final" ? "Final" : "Round robin"}</h2>
          <div className="t-games">
            {t.games.filter((g) => g.stage === st).map((g) => <GameCard key={g.id} g={g} label={label} onOpen={() => setOpen(g)} />)}
          </div>
        </section>
      ))}
      {open && <GameDetail t={t} g={t.games.find((x) => x.id === open.id) ?? open} label={label} onClose={() => setOpen(null)} onReplay={() => onReplay(t, open)} />}
    </>
  );
}

function CrossTable({ t, label, onOpen }: { t: Tournament; label: (p: string) => string; onOpen: (g: TGame) => void }) {
  const ids = t.players.map((p) => p.id);
  const find = (a: string, b: string) => t.games.filter((g) => g.stage === "round-robin" && g.seats.includes(a) && g.seats.includes(b));
  return (
    <div className="t-table-wrap">
      <table className="t-table cross">
        <thead><tr><th />{ids.map((id) => <th key={id} className="c">{label(id)}</th>)}</tr></thead>
        <tbody>
          {ids.map((a) => (
            <tr key={a}>
              <th>{label(a)}</th>
              {ids.map((b) => {
                if (a === b) return <td key={b} className="c self" />;
                const g = find(a, b)[0];
                if (!g) return <td key={b} className="c muted">·</td>;
                const r = g.status !== "done" ? (g.status === "running" ? "live" : g.status === "error" ? "err" : "—") : g.winner === a ? "W" : g.winner === null ? "D" : "L";
                return <td key={b} className={`c res-${r}`}><button onClick={() => onOpen(g)}>{r}</button></td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GameCard({ g, label, onOpen }: { g: TGame; label: (p: string) => string; onOpen: () => void }) {
  return (
    <button className={`t-game ${g.status}`} onClick={onOpen}>
      <div className="t-game-head"><span className="muted small">R{g.round}</span><span className={`chip${g.status === "running" ? " ok" : g.status === "error" ? " bad" : ""}`}>{g.status === "running" ? "● live" : g.status}</span></div>
      {g.seats.map((p) => (
        <div key={p} className={`t-seat${g.winner === p ? " won" : g.status === "done" && g.winner !== null ? " lost" : ""}`}>
          <b>{label(p)}</b><span className="muted small">{g.decks[p]?.name ?? "choosing deck…"}</span>
        </div>
      ))}
      <div className="muted small">{g.status === "done" ? `${g.winner === null ? "Draw" : `${label(g.winner)} won`} · ${g.reason ?? ""}${g.turns ? ` · ${g.turns} turns` : ""}` : g.error ?? ""}</div>
    </button>
  );
}

function GameDetail({ t, g, label, onClose, onReplay }: { t: Tournament; g: TGame; label: (p: string) => string; onClose: () => void; onReplay: () => void }) {
  const [logs, setLogs] = useState<Record<string, Decision[]>>({});
  const [tab, setTab] = useState<string>(g.seats[0]);
  useEffect(() => {
    let on = true;
    g.seats.forEach((p) => getDecisions(t.id, g.id, p).then((d) => on && setLogs((l) => ({ ...l, [p]: d }))).catch(() => {}));
    return () => { on = false; };
  }, [t.id, g.id, g.seats]);
  const log = logs[tab] ?? [];
  const dur = g.startedAt && g.endedAt ? Date.parse(g.endedAt) - Date.parse(g.startedAt) : 0;
  const result = useMemo(() => g.status === "done" ? (g.winner === null ? "Draw" : `${label(g.winner)} won`) : g.status, [g, label]);

  return (
    <Modal title={`${label(g.seats[0])} vs ${label(g.seats[1])}`} subtitle={`${g.stage === "final" ? "Final" : `Round ${g.round}`} · ${result}${g.reason ? ` (${g.reason})` : ""}${g.turns ? ` · ${g.turns} turns` : ""}${dur ? ` · ${secs(dur)}` : ""}`}
      onClose={onClose} width={920}
      footer={<><button className="ghost" onClick={onClose}>Close</button><button className="primary" disabled={g.status === "pending"} onClick={onReplay}>{g.status === "running" ? "Watch so far" : "Watch replay"}</button></>}>
      {g.error && <p className="err">{g.error}</p>}
      <div className="t-decks">
        {g.seats.map((p, i) => {
          const d = g.decks[p], s = g.stats[p];
          return (
            <div key={p} className={`t-deck${g.winner === p ? " won" : ""}`}>
              <div className="row"><b>{label(p)}</b><span className="muted small">Seat {i + 1}</span>{g.winner === p && <span className="chip gold">Winner</span>}</div>
              {d ? <>
                <div className="row"><h3>{d.name}</h3><span className={`chip${d.source === "custom" ? " gold" : ""}`}>{d.source}</span><span className="muted small">{d.main.length} main · {d.extra.length} extra</span></div>
                <blockquote>{d.reason || <span className="muted">No reason given.</span>}</blockquote>
              </> : <p className="muted">Deck not chosen yet.</p>}
              {s && <div className="t-stats">
                <span><b>{s.decisions}</b> decisions</span><span><b>{secs(s.avgDecisionMs)}</b> avg think</span>
                <span><b>{s.decisions ? pct(s.reasonsGiven / s.decisions) : "—"}</b> reasoned</span><span><b>{s.invalid}</b> invalid</span>
                <span><b>{s.toolCalls}</b> tool calls</span><span><b>{s.resumes}</b> resumes</span>
              </div>}
            </div>
          );
        })}
      </div>
      <div className="seg t-tabs">{g.seats.map((p) => <button key={p} className={tab === p ? "on" : ""} onClick={() => setTab(p)}>{label(p)} decisions ({logs[p]?.length ?? "…"})</button>)}</div>
      <ol className="t-decisions">
        {log.map((d, i) => (
          <li key={i}>
            <span className="muted small">{d.turn !== undefined ? `T${d.turn}` : ""} {d.phase ?? ""} {d.promptKind ?? ""}{d.ms !== undefined ? ` · ${secs(d.ms)}` : ""}</span>
            <div><b>→ {d.choose.map((c) => (typeof c === "number" && d.options?.[c - 1]) || String(c)).join(", ") || "(pass)"}</b></div>
            {d.reason && <p>{d.reason}</p>}
          </li>
        ))}
        {!log.length && <li className="muted">No decisions recorded.</li>}
      </ol>
    </Modal>
  );
}
