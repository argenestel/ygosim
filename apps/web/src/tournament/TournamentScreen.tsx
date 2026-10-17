import { Fragment, memo, useEffect, useMemo, useState } from "react";
import { getCard, onCardCache, peekCard } from "../api";
import { CardThumb, Modal } from "../ui/kit";
import { chosenText, getLeaderboard, getRawLog, getTournament, listTournaments, organizerToken, pct, reasonText, relTime, secs, setOrganizerToken, tailActivity, tailDecisions,
  type Activity, type Decision, type Leaderboard, type Standing, type TDeck, type TGame, type TSummary, type Tournament } from "./api";
import { BrandMark, HostMark, identifyBrand, type BrandInfo } from "./brandMarks";
import { usePoll, useFollow, useTail } from "./hooks";
import { parseTranscript, type LogLine } from "./rawlog";

const CLI_TAG: Record<string, string> = { codex: "Codex", pi: "pi", claude: "Claude Code", agy: "Antigravity" };
const LIVE_POLL_MS = 3000;

type TournamentScoreState = "scoring" | "validation" | "scored" | "unknown";

function scoreState(t: Tournament): TournamentScoreState {
  if (t.scored === true) return t.status === "done" ? "scored" : "scoring";
  if (t.scored === false) return "validation";
  return "unknown";
}

function scoreStateLabel(state: TournamentScoreState): string {
  if (state === "scoring") return "Scoring live";
  if (state === "scored") return "Scored";
  if (state === "validation") return "Validation run";
  return "Score state unavailable";
}

function playerBrand(p: { id: string; label: string; model: string }): BrandInfo {
  return identifyBrand([p.id, p.label, p.model]);
}

function standingsRank(rows: Standing[]): Map<string, number> {
  return new Map([...rows].sort((a, b) => b.points - a.points || b.elo - a.elo).map((row, index) => [row.id, index + 1]));
}

export function TournamentScreen({ onReplay, selected, onSelect }: { onReplay: (t: Tournament, g: TGame) => void; selected?: string; onSelect?: (id: string) => void }) {
  const [list, listErr] = usePoll(listTournaments, [], () => 5000);
  const [local, setLocal] = useState<string>("board");
  const sel = selected ?? local;
  const choose = (id: string) => { setLocal(id); onSelect?.(id); };
  const [keyOpen, setKeyOpen] = useState(false);
  const [hasKey, setHasKey] = useState(() => !!organizerToken());

  return (
    <div className="tourney">
      <div className="page-head">
        <h1>Agent Tournament</h1>
        <button className={`ghost${hasKey ? " on" : ""}`} onClick={() => setKeyOpen(true)} title="Organizer token unlocks raw agent logs">{hasKey ? "🔓 Logs unlocked" : "🔒 Logs access"}</button>
        <select value={sel} onChange={(e) => choose(e.target.value)} aria-label="Tournament">
          <option value="board">All-time leaderboard</option>
          {list?.map((t) => <option key={t.id} value={t.id}>{t.status === "running" ? "● " : ""}{t.name} · {t.done}/{t.total}{t.status === "running" ? " · live" : ""}</option>)}
        </select>
      </div>
      {listErr && !list && <p className="err">Tournament API unavailable: {listErr}</p>}
      {sel === "board" ? <AllTime list={list ?? []} onOpen={choose} /> : <TournamentView key={sel} tid={sel} onReplay={onReplay} />}
      {keyOpen && <KeyModal onClose={(changed) => { setKeyOpen(false); if (changed) setHasKey(!!organizerToken()); }} />}
    </div>
  );
}

function KeyModal({ onClose }: { onClose: (changed: boolean) => void }) {
  const [value, setValue] = useState(organizerToken());
  const save = (v: string) => { setOrganizerToken(v.trim()); onClose(true); };
  return (
    <Modal title="Organizer access" subtitle="Paste YGOSIM_TOURNAMENT_READ_TOKEN to read raw agent transcripts and stderr. Stored only in this browser." onClose={() => onClose(false)} width={520}
      footer={<><button className="ghost" onClick={() => save("")}>Clear</button><button className="primary" onClick={() => save(value)}>Save</button></>}>
      <input type="password" autoFocus value={value} placeholder="Organizer token" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save(value)} style={{ width: "100%" }} />
    </Modal>
  );
}

function AllTime({ list, onOpen }: { list: TSummary[]; onOpen: (id: string) => void }) {
  const [lb, err] = usePoll<Leaderboard>(getLeaderboard, [], () => list.some((t) => t.status === "running") && 8000);
  return (
    <>
      <section className="t-section">
        <h2>Benchmark leaderboard</h2>
        <p className="muted">Every finished game across all tournaments. Elo starts at 1500 (K=32); win = 3 pts, draw = 1.</p>
        {err && !lb && <p className="err">{err}</p>}
        {lb && lb.players.length > 0 && <StandingsTable rows={lb.players} />}
        {lb && lb.players.length === 0 && (
          <div className="t-empty">
            <span className="eyebrow">No scored games yet</span>
            <p>Validation runs never enter the leaderboard. Pass a validation, then launch a scored tournament with <code>--validated-by &lt;id&gt;</code>{list.some((t) => t.status === "running") ? " — a tournament is live right now, pick it above to watch." : "."}</p>
          </div>
        )}
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

const StandingsTable = memo(function StandingsTable({ rows }: { rows: Standing[] }) {
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
});

function TournamentProof({ t, done, total }: { t: Tournament; done: number; total: number }) {
  const state = scoreState(t);
  const validation = t.validation;
  return (
    <div className="t-proof-row" aria-label="Tournament scoring state">
      <span className={`t-proof t-proof-${state}`}>
        <i aria-hidden="true" />{scoreStateLabel(state)}
      </span>
      {t.scored === false && (
        <span className={`t-proof t-proof-validation${validation?.passed ? " passed" : t.status === "done" ? " failed" : ""}`}
          title={validation && !validation.passed && validation.missingPlayers.length ? `Missing a clean finished game for: ${validation.missingPlayers.join(", ")}` : undefined}>
          <i aria-hidden="true" />{validation?.passed ? "Roster validated" : t.status === "done" ? "Validation failed" : "Validation pending"}
        </span>
      )}
      {t.scored === true && <span className="t-proof t-proof-api"><i aria-hidden="true" />API result feed</span>}
      {t.scored === undefined && <span className="t-proof t-proof-legacy">Legacy record · no scoring claim</span>}
      <span className="t-proof-count">{total ? `${done}/${total} games recorded` : "No games scheduled"}</span>
    </div>
  );
}

function TournamentArena({ t, done, live }: { t: Tournament; done: number; live: number }) {
  const state = scoreState(t);
  const total = t.games.length;
  const ranks = standingsRank(t.standings);
  const progress = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <section className="t-arena" aria-labelledby="t-arena-title">
      <div className="t-arena-head">
        <div>
          <span className="t-arena-eyebrow">LIVE AGENT ARENA</span>
          <h2 id="t-arena-title">{t.name}</h2>
          <p>{t.players.length} entrants <span>·</span> {t.format} <span>·</span> live API feed</p>
        </div>
        <TournamentProof t={t} done={done} total={total} />
      </div>
      <div className="t-arena-meter" aria-label={`${done} of ${total} games recorded`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="t-bubble-stage">
        <div className="t-orbit t-orbit-outer" aria-hidden="true" />
        <div className="t-orbit t-orbit-inner" aria-hidden="true" />
        <div className="t-arena-core">
          <span className="t-core-kicker">TOURNAMENT SCORE</span>
          <strong>{total ? `${done}/${total}` : "—"}</strong>
          <span>{state === "scoring" ? `${live} live ${live === 1 ? "match" : "matches"}` : scoreStateLabel(state)}</span>
        </div>
        <div className="t-bubble-grid">
          {t.players.map((p) => <PlayerBubble key={p.id} p={p} t={t} rank={ranks.get(p.id)} state={state} />)}
        </div>
      </div>
      <div className="t-arena-legend" aria-hidden="true">
        <span><i className="t-legend-dot live" />live match</span>
        <span><i className="t-legend-dot scored" />recorded result</span>
        <span><i className="t-legend-dot queued" />queued</span>
      </div>
    </section>
  );
}

function PlayerBubble({ p, t, rank, state }: { p: Tournament["players"][number]; t: Tournament; rank?: number; state: TournamentScoreState }) {
  const brand = playerBrand(p);
  const games = t.games.filter((g) => g.seats.includes(p.id));
  const live = games.some((g) => g.status === "running");
  const recorded = games.some((g) => g.status === "done");
  const standing = t.standings.find((s) => s.id === p.id);
  const validated = state === "validation" && !!t.validation?.checkedPlayers.includes(p.id);
  const status = live ? "live" : validated ? "validated" : recorded ? "scored" : "queued";
  const statusLabel = live ? "Live" : validated ? "Validated" : recorded ? "Recorded" : "Queued";
  const cli = CLI_TAG[p.cli] ?? p.cli;
  const latestDeck = [...games].reverse().find((g) => g.decks[p.id])?.decks[p.id];
  return (
    <article className={`t-bubble t-bubble-${status}`} aria-label={`${p.label}, ${statusLabel}`}>
      <div className="t-bubble-top">
        <span className="t-bubble-rank">{rank && standing?.played ? `#${rank}` : "—"}</span>
        <span className={`t-bubble-status t-bubble-status-${status}`}><i aria-hidden="true" />{statusLabel}</span>
      </div>
      <div className="t-bubble-brand-row">
        <BrandMark brand={brand} size="sm" />
        {brand.host && <HostMark />}
      </div>
      <h3>{p.label}</h3>
      <p className="t-bubble-model" title={p.model}>{p.model}</p>
      <p className="t-bubble-meta">{cli}{p.effort ? ` · ${p.effort}` : ""}</p>
      <div className="t-bubble-score">
        <span><b>{standing ? standing.points : "—"}</b><small>pts</small></span>
        <span><b>{standing ? `${standing.wins}-${standing.losses}-${standing.draws}` : "—"}</b><small>W-L-D</small></span>
        <span><b>{standing ? Math.round(standing.elo) : "—"}</b><small>elo</small></span>
      </div>
      <div className="t-bubble-foot">
        <span>{latestDeck?.name ?? (live ? "Deck in play" : recorded ? "Deck recorded" : "Deck pending")}</span>
        <span>{games.length ? `${games.filter((g) => g.status === "done").length}/${games.length}` : "—"}</span>
      </div>
    </article>
  );
}

function TournamentView({ tid, onReplay }: { tid: string; onReplay: (t: Tournament, g: TGame) => void }) {
  const [t, err] = usePoll(() => getTournament(tid), [tid], (x) => x?.status === "running" && LIVE_POLL_MS);
  const [openId, setOpenId] = useState<string | null>(null);
  const players = t?.players;
  const label = useMemo(() => (pid: string) => players?.find((p) => p.id === pid)?.label ?? pid, [players]);
  const open = useMemo(() => (openId ? t?.games.find((g) => g.id === openId) : undefined), [t, openId]);
  if (err && !t) return <p className="err">{err}</p>;
  if (!t) return <div className="spinner" />;
  const done = t.games.filter((g) => g.status === "done").length;
  const stages = [...new Set(t.games.map((g) => g.stage))];
  const live = t.games.filter((g) => g.status === "running");

  return (
    <>
      <TournamentArena t={t} done={done} live={live.length} />
      <div className="row t-meta">
        <span className={`chip${t.status === "running" ? " ok" : ""}`}>{t.status === "running" ? "● Live" : "Finished"}</span>
        <span className="muted">{t.format} · {done}/{t.games.length} games · started {new Date(t.createdAt).toLocaleString()}</span>
      </div>
      <div className="t-roster">
        {t.players.map((p) => <span key={p.id} className="chip" title={p.model}>{p.label} <small>{CLI_TAG[p.cli] ?? p.cli}{p.effort ? ` · ${p.effort}` : ""}</small></span>)}
      </div>
      {live.length > 0 && (
        <section className="t-section">
          <h2>Live now</h2>
          <div className="t-games">{live.map((g) => <GameCard key={g.id} g={g} t={t} label={label} onOpen={() => setOpenId(g.id)} />)}</div>
        </section>
      )}
      {t.series && <p className="muted">Series: {t.players.map(p => `${p.label} ${t.series!.wins[p.id] ?? 0}`).join(" — ")} · {t.series.winner ? `${label(t.series.winner)} wins` : t.series.complete ? "No first-to-two winner" : "First to two wins; maximum three games"}</p>}
      <section className="t-section"><h2>Standings</h2><StandingsTable rows={t.standings} /></section>
      <section className="t-section"><h2>Head to head</h2><CrossTable t={t} label={label} onOpen={(g) => setOpenId(g.id)} /></section>
      {stages.map((st) => (
        <section className="t-section" key={st}>
          <h2>{st === "final" ? "Final" : st === "series" ? "Best-of-three series" : "Round robin"}</h2>
          <div className="t-games">
            {t.games.filter((g) => g.stage === st).map((g) => <GameCard key={g.id} g={g} t={t} label={label} onOpen={() => setOpenId(g.id)} />)}
          </div>
        </section>
      ))}
      {open && <GameDetail t={t} g={open} label={label} onClose={() => setOpenId(null)} onReplay={() => onReplay(t, open)} />}
    </>
  );
}

function CrossTable({ t, label, onOpen }: { t: Tournament; label: (p: string) => string; onOpen: (g: TGame) => void }) {
  const ids = t.players.map((p) => p.id);
  const find = (a: string, b: string) => t.games.filter((g) => (g.stage === "round-robin" || g.stage === "series") && g.seats.includes(a) && g.seats.includes(b));
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

const PHASE: Record<string, string> = { draw: "Draw", standby: "Standby", main1: "Main 1", battle: "Battle", main2: "Main 2", end: "End" };
const fmtLp = (n: number) => n.toLocaleString();

/** Live board line for a running game: turn, phase and whose turn it is. */
function liveLine(g: TGame, label: (p: string) => string): string | undefined {
  const l = g.live; if (!l) return undefined;
  return `Turn ${l.turn} · ${PHASE[l.phase] ?? l.phase} · ${label(g.seats[l.turnPlayer] ?? "")}`;
}

const GameCard = memo(function GameCard({ g, t, label, onOpen }: { g: TGame; t: Tournament; label: (p: string) => string; onOpen: () => void }) {
  const running = g.status === "running";
  const now = useNow(running);
  const cap = (t.audit?.maxMinutes ?? 0) * 60_000;
  const elapsed = running && g.startedAt ? Math.max(0, now - Date.parse(g.startedAt)) : 0;
  const dur = g.startedAt && g.endedAt ? Date.parse(g.endedAt) - Date.parse(g.startedAt) : 0;
  const lpOf = (p: string, i: number) => g.lp?.[p] ?? g.live?.lp[i];
  return (
    <button className={`t-game ${g.status}`} onClick={onOpen}>
      <div className="t-game-head">
        <span className="muted small">{g.stage === "final" ? "Final" : `R${g.round}`}{running && g.live ? ` · T${g.live.turn}` : ""}</span>
        <span className={`chip${running ? " ok" : g.status === "error" ? " bad" : ""}`}>{running ? "● live" : g.status}</span>
      </div>
      {g.seats.map((p, i) => {
        const lp = lpOf(p, i), turn = running && g.live && g.live.turnPlayer === i;
        return (
          <div key={p} className={`t-seat${g.winner === p ? " won" : g.status === "done" && g.winner !== null ? " lost" : ""}${turn ? " turn" : ""}`}>
            <div className="row"><b>{label(p)}</b>{lp !== undefined && <span className={`t-lp${lp <= 2000 ? " low" : ""}`}>{fmtLp(lp)}</span>}</div>
            <span className="muted small">{g.decks[p]?.name ?? (g.status === "pending" ? "waiting" : "building deck…")}</span>
          </div>
        );
      })}
      {running && cap > 0 && (
        <div className="t-game-meter" title={`${secs(elapsed)} of a ${t.audit!.maxMinutes}m cap`}><span style={{ width: `${Math.min(100, (elapsed / cap) * 100)}%` }} /></div>
      )}
      <div className="muted small">
        {g.status === "done" ? `${g.winner === null ? "Draw" : `${label(g.winner)} won`} · ${reasonText(g.reason)}${g.turns ? ` · ${g.turns} turns` : ""}${dur ? ` · ${secs(dur)}` : ""}`
          : running ? (liveLine(g, label) ?? (Object.keys(g.decks).length < 2 ? "Agents are building decks" : "Duel starting")) + (elapsed ? ` · ${secs(elapsed)}` : "")
          : g.error ?? ""}
      </div>
    </button>
  );
});

/** Re-render once a second so "12s ago" labels stay honest without refetching. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!active) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [active]);
  return now;
}

type Row = Decision & { pid: string; rt: number };
type View = "reasoning" | "activity" | "raw";

function GameDetail({ t, g, label, onClose, onReplay }: { t: Tournament; g: TGame; label: (p: string) => string; onClose: () => void; onReplay: () => void }) {
  const tid = t.id;
  const live = g.status === "running";
  const [seat, setSeat] = useState<string>("both");
  const [view, setView] = useState<View>("reasoning");
  const [a, b] = g.seats;
  const d0 = useTail<Decision>((from) => tailDecisions(tid, g.id, a, from), `${tid}/${g.id}/${a}`, live);
  const d1 = useTail<Decision>((from) => tailDecisions(tid, g.id, b, from), `${tid}/${g.id}/${b}`, live);
  const decisions: Record<string, typeof d0> = { [a]: d0, [b]: d1 };
  const now = useNow(live);
  const dur = g.startedAt && g.endedAt ? Date.parse(g.endedAt) - Date.parse(g.startedAt) : 0;
  const lpLine = g.lp ? ` · ${g.seats.map((p) => fmtLp(g.lp![p] ?? 0)).join(" – ")} LP` : "";
  const result = g.status === "done" ? (g.winner === null ? "Draw" : `${label(g.winner)} won`) : g.status === "running" ? "● live" : g.status;
  const rows = useMemo<Row[]>(() => {
    const pick = seat === "both" ? g.seats : [seat];
    return pick.flatMap((pid) => decisions[pid].rows.map((d) => ({ ...d, pid, rt: relTime(d, g) }))).sort((x, y) => x.rt - y.rt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d0.rows, d1.rows, seat, g.seats, g.startedAt]);
  const last = g.startedAt && rows.length ? Date.parse(g.startedAt) + Math.max(...rows.map((r) => r.rt)) : 0;

  return (
    <Modal title={`${label(a)} vs ${label(b)}`} subtitle={`${g.stage === "final" ? "Final" : `Round ${g.round}`} · ${result}${g.reason ? ` (${reasonText(g.reason)})` : ""}${lpLine}${g.turns ? ` · ${g.turns} turns` : ""}${dur ? ` · ${secs(dur)}` : ""}`}
      onClose={onClose} width={960}
      footer={<><button className="ghost" onClick={onClose}>Close</button><button className="primary" disabled={g.status === "pending"} onClick={onReplay}>{live ? "Watch live" : "Watch replay"}</button></>}>
      {g.error && <p className="err">{g.error}</p>}
      <div className="t-decks">
        {g.seats.map((p, i) => {
          const d = g.decks[p], s = g.stats[p];
          return (
            <div key={p} className={`t-deck${g.winner === p ? " won" : ""}`}>
              <div className="row"><b>{label(p)}</b><span className="muted small">Seat {i + 1}</span>{g.winner === p && <span className="chip gold">Winner</span>}</div>
              {d ? <>
                <div className="row"><h3>{d.name}</h3><span className={`chip${d.source === "custom" ? " gold" : ""}`}>{d.source === "custom" ? "built by agent" : d.source}</span><span className="muted small">{d.main.length} main · {d.extra.length} extra</span></div>
                <blockquote>{d.reason || <span className="muted">No reason given.</span>}</blockquote>
                <DeckGallery deck={d} />
              </> : <p className="muted">{g.status === "pending" ? "Waiting to start." : "Building a deck…"}</p>}
              {s && <div className="t-stats">
                <span><b>{s.decisions}</b> decisions</span><span><b>{secs(s.avgDecisionMs)}</b> avg think</span>
                <span><b>{s.decisions ? pct(s.reasonsGiven / s.decisions) : "—"}</b> reasoned</span><span><b>{s.invalid}</b> invalid</span>
                <span><b>{s.toolCalls}</b> tool calls</span><span><b>{s.resumes}</b> resumes</span>
              </div>}
            </div>
          );
        })}
      </div>
      <div className="t-toolbar">
        <div className="seg t-tabs">
          <button className={seat === "both" ? "on" : ""} onClick={() => setSeat("both")}>Both ({d0.rows.length + d1.rows.length})</button>
          {g.seats.map((p) => <button key={p} className={seat === p ? "on" : ""} onClick={() => setSeat(p)}>{label(p)} ({decisions[p].rows.length})</button>)}
        </div>
        <div className="seg t-tabs">
          {(["reasoning", "activity", "raw"] as const).map((v) => <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{v === "reasoning" ? "Reasoning" : v === "activity" ? "Tool activity" : "Raw log"}</button>)}
        </div>
        {live && <span className="chip ok">● live{g.live ? ` · ${liveLine(g, label)}` : ""}{last ? ` · last move ${secs(Math.max(0, now - last))} ago` : " · waiting for first move"}</span>}
      </div>
      {view === "reasoning" && <Reasoning rows={rows} label={label} seats={g.seats} live={live} loaded={d0.loaded && d1.loaded} error={d0.error ?? d1.error} />}
      {view === "activity" && <ActivityFeed tid={tid} g={g} seat={seat} label={label} live={live} />}
      {view === "raw" && <RawLog tid={tid} g={g} seat={seat === "both" ? a : seat} label={label} live={live} />}
    </Modal>
  );
}

/** Resolve card names for hover titles; re-renders as the shared card cache fills. */
function useCardNames(codes: number[]) {
  const [, bump] = useState(0);
  useEffect(() => { codes.forEach((c) => { if (!peekCard(c)) getCard(c); }); return onCardCache(() => bump((n) => n + 1)); }, [codes]);
  return (code: number) => peekCard(code)?.name ?? `#${code}`;
}

function DeckGallery({ deck }: { deck: TDeck }) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => {
    const tally = (codes: number[]) => { const m = new Map<number, number>(); codes.forEach((c) => m.set(c, (m.get(c) ?? 0) + 1)); return [...m]; };
    return { main: tally(deck.main), extra: tally(deck.extra), side: tally(deck.side ?? []) };
  }, [deck]);
  const codes = useMemo(() => (open ? [...new Set([...deck.main, ...deck.extra, ...(deck.side ?? [])])] : []), [deck, open]);
  const name = useCardNames(codes);
  if (!open) return <button className="ghost t-deck-toggle" onClick={() => setOpen(true)}>Show cards ({deck.main.length} main · {deck.extra.length} extra{deck.side?.length ? ` · ${deck.side.length} side` : ""})</button>;
  const grid = (rows: [number, number][]) => <div className="t-cardgrid">{rows.map(([code, n]) => <CardThumb key={code} code={code} count={n > 1 ? n : undefined} title={name(code)} />)}</div>;
  return (
    <div className="t-gallery">
      <div className="row"><span className="eyebrow">Main · {deck.main.length}</span><span className="spacer" /><button className="ghost t-deck-toggle" onClick={() => setOpen(false)}>Hide cards</button></div>
      {grid(groups.main)}
      {groups.extra.length > 0 && <><span className="eyebrow">Extra · {deck.extra.length}</span>{grid(groups.extra)}</>}
      {groups.side.length > 0 && <><span className="eyebrow">Side · {deck.side!.length}</span>{grid(groups.side)}</>}
    </div>
  );
}

const DecisionItem = memo(function DecisionItem({ d, who, side }: { d: Row; who?: string; side: 0 | 1 }) {
  return (
    <li className={`s${side}`}>
      <span className="muted small">{who && <b>{who} </b>}{d.turn !== undefined ? `T${d.turn} ` : ""}{d.phase ?? ""} {d.promptKind ?? ""}{d.ms !== undefined ? ` · ${secs(d.ms)}` : ""}</span>
      <div><b>→ {chosenText(d)}</b></div>
      {d.reason && <p>{d.reason}</p>}
    </li>
  );
});

function Reasoning({ rows, label, seats, live, loaded, error }: { rows: Row[]; label: (p: string) => string; seats: [string, string]; live: boolean; loaded: boolean; error?: string }) {
  const { ref, onScroll, away, jump } = useFollow<HTMLOListElement>(rows.length);
  return (
    <div className="t-feed">
      <ol className="t-decisions" ref={ref} onScroll={onScroll}>
        {rows.map((d, i) => <Fragment key={`${d.pid}:${d.t}:${i}`}>
          {d.turn !== undefined && d.turn !== rows[i - 1]?.turn && <li className="t-turn" aria-label={`Turn ${d.turn}`}><span>Turn {d.turn}</span></li>}
          <DecisionItem d={d} who={label(d.pid)} side={d.pid === seats[0] ? 0 : 1} />
        </Fragment>)}
        {!rows.length && <li className="muted">{!loaded ? "Loading…" : error ? `Reasoning unavailable: ${error}` : live ? "Waiting for the first move — agents are still building their decks." : "No decisions recorded."}</li>}
      </ol>
      {away && <button className="t-jump" onClick={jump}>↓ Latest</button>}
    </div>
  );
}

function ActivityFeed({ tid, g, seat, label, live }: { tid: string; g: TGame; seat: string; label: (p: string) => string; live: boolean }) {
  const [a, b] = g.seats;
  const f0 = useTail<Activity>((from) => tailActivity(tid, g.id, a, from), `${tid}/${g.id}/${a}/act`, live);
  const f1 = useTail<Activity>((from) => tailActivity(tid, g.id, b, from), `${tid}/${g.id}/${b}/act`, live);
  const rows = useMemo(() => {
    const pick = seat === "both" ? [[a, f0.rows], [b, f1.rows]] as const : [[seat, seat === a ? f0.rows : f1.rows]] as const;
    return pick.flatMap(([pid, r]) => r.map((x) => ({ ...x, pid }))).sort((x, y) => x.t - y.t);
  }, [f0.rows, f1.rows, seat, a, b]);
  const { ref, onScroll, away, jump } = useFollow<HTMLOListElement>(rows.length);
  const error = f0.error ?? f1.error;
  return (
    <div className="t-feed">
      <ol className="t-decisions t-mono" ref={ref} onScroll={onScroll}>
        {rows.map((r, i) => (
          <li key={`${r.pid}:${r.t}:${i}`} className={r.ok ? "" : "bad"}>
            <span className="muted small"><b>{label(r.pid)}</b> · {r.tool} · {secs(r.ms)}{r.ok ? "" : " · failed"}</span>
            {r.summary && <div>{r.summary}</div>}
          </li>
        ))}
        {!rows.length && <li className="muted">{!(f0.loaded && f1.loaded) ? "Loading…" : error ? `Tool activity unavailable: ${error}` : "No tool calls yet."}</li>}
      </ol>
      {away && <button className="t-jump" onClick={jump}>↓ Latest</button>}
    </div>
  );
}

function RawLog({ tid, g, seat, label, live }: { tid: string; g: TGame; seat: string; label: (p: string) => string; live: boolean }) {
  const [kind, setKind] = useState<"transcript" | "stderr">("transcript");
  const [text, err] = usePoll(() => getRawLog(tid, g.id, seat, kind), [tid, g.id, seat, kind, live], () => live && LIVE_POLL_MS);
  const lines = useMemo<LogLine[]>(() => kind === "transcript" ? parseTranscript(text ?? "") : (text ?? "").split("\n").filter(Boolean).map((t) => ({ kind: "raw" as const, text: t })), [text, kind]);
  const { ref, onScroll, away, jump } = useFollow<HTMLOListElement>(lines.length);
  const locked = err?.includes("403");
  return (
    <div className="t-feed">
      <div className="row t-rawbar">
        <span className="muted small">{label(seat)} · last 512 KB</span>
        <div className="seg"><button className={kind === "transcript" ? "on" : ""} onClick={() => setKind("transcript")}>Agent output</button><button className={kind === "stderr" ? "on" : ""} onClick={() => setKind("stderr")}>stderr</button></div>
      </div>
      <ol className="t-decisions t-mono" ref={ref} onScroll={onScroll}>
        {lines.map((l, i) => <li key={i} className={`raw-${l.kind}`}><span className="muted small">{l.kind === "say" ? "message" : l.kind === "think" ? "thinking" : l.kind}</span><div>{l.text}</div></li>)}
        {!lines.length && <li className="muted">{locked ? "Raw logs need the organizer token — use “Logs access” at the top of the page." : err ? `Raw log unavailable: ${err}` : text === undefined ? "Loading…" : "Nothing logged yet."}</li>}
      </ol>
      {away && <button className="t-jump" onClick={jump}>↓ Latest</button>}
    </div>
  );
}
