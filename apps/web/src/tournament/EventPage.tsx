import { memo, useMemo } from "react";
import { useCopy } from "../ui/kit";
import { ago, cleanName, deckTitle, duration, formatText, getTournament, kindOf, phaseText, reasonText, signatureCard, stateOf, type TGame, type TPlayer, type Tournament } from "./api";
import { usePoll } from "./hooks";
import { StandingsTable } from "./Hub";
import { Agent, ArtBg, Back, KindTag, StatePill, useNow } from "./ui";

const LIVE_POLL_MS = 3000;

export function EventPage({ tid, onBack, onGame }: { tid: string; onBack: () => void; onGame: (gid: string) => void }) {
  const [t, err] = usePoll(() => getTournament(tid), [tid], (x) => (x && stateOf(x) === "live" ? LIVE_POLL_MS : false));
  const players = t?.players;
  const byId = useMemo(() => new Map((players ?? []).map((p) => [p.id, p])), [players]);
  if (err && !t) return <div className="ar"><Back onClick={onBack}>Arena</Back><p className="err">{err}</p></div>;
  if (!t) return <div className="ar"><Back onClick={onBack}>Arena</Back><div className="spinner" /></div>;

  const state = stateOf(t), kind = kindOf(t);
  const done = t.games.filter((g) => g.status === "done").length;
  const liveGames = state === "live" ? t.games.filter((g) => g.status === "running") : [];
  const stages = [...new Set(t.games.map((g) => g.stage))];
  const cap = t.audit?.maxMinutes ? `${t.audit.maxMinutes}-min cap${t.audit.onTimeout === "lp" ? " · LP decides" : ""}` : "";
  const champ = t.champion ? byId.get(t.champion) : t.series?.winner ? byId.get(t.series.winner) : undefined;

  return (
    <div className="ar">
      <Back onClick={onBack}>Arena</Back>
      <header className="ar-head">
        <div className="ar-tags"><KindTag kind={kind} /><StatePill state={state} /></div>
        <h1>{cleanName(t.name)}</h1>
        <p className="ar-meta">
          {[formatText(t.format), `${t.players.length} agents`, `${done}/${t.games.length} matches`, `started ${ago(t.createdAt)}`, cap].filter(Boolean).join(" · ")}
        </p>
      </header>

      <Callout t={t} state={state} kind={kind} champ={champ} />

      {liveGames.length > 0 && (
        <section className="ar-section">
          <div className="ar-section-head"><h2><span className="ar-dot" />Live now</h2></div>
          <div className="ar-matches">{liveGames.map((g) => <MatchRow key={g.id} g={g} t={t} byId={byId} live onOpen={() => onGame(g.id)} />)}</div>
        </section>
      )}

      {stages.map((st) => (
        <section className="ar-section" key={st}>
          <div className="ar-section-head"><h2>{st === "final" ? "Final" : st === "series" ? "Best-of-three series" : "Matches"}</h2>
            {st === "series" && t.series && <span className="muted">{t.players.map((p) => `${p.label} ${t.series!.wins[p.id] ?? 0}`).join(" – ")}</span>}</div>
          <div className="ar-matches">
            {t.games.filter((g) => g.stage === st).map((g) => <MatchRow key={g.id} g={g} t={t} byId={byId} live={liveGames.includes(g)} onOpen={() => onGame(g.id)} />)}
          </div>
        </section>
      ))}

      <section className="ar-section">
        <div className="ar-section-head"><h2>Standings</h2>{kind !== "scored" && <span className="muted">Not counted on the leaderboard</span>}</div>
        <StandingsTable rows={t.standings.map((s) => ({ ...s, provider: byId.get(s.id)?.provider, host: byId.get(s.id)?.host }))} />
      </section>

      {t.players.length > 2 && (
        <section className="ar-section">
          <div className="ar-section-head"><h2>Head to head</h2><span className="muted">Row agent's result against the column agent</span></div>
          <CrossTable t={t} onGame={onGame} />
        </section>
      )}
    </div>
  );
}

/** One line that says what this event means and what to do next. */
function Callout({ t, state, kind, champ }: { t: Tournament; state: ReturnType<typeof stateOf>; kind: ReturnType<typeof kindOf>; champ?: TPlayer }) {
  const [copied, copy] = useCopy();
  const Cmd = ({ cmd }: { cmd: string }) => <button className="ar-cmd" onClick={() => copy(cmd)} title="Copy command"><code>{cmd}</code><span>{copied === cmd ? "Copied" : "Copy"}</span></button>;
  if (state === "paused") return (
    <div className="ar-callout warn"><b>Paused — no runner is attached.</b> Finished matches are kept; resume to play the rest.
      <Cmd cmd={`pnpm --filter @ygosim/tournament start -- --resume ${t.id}`} /></div>
  );
  if (champ && state === "finished") return (
    <div className="ar-callout champ"><span className="ar-crown" aria-hidden="true">♛</span><span><span className="eyebrow">Champion</span><b>{champ.label}</b></span><Agent p={champ} detail size="md" /></div>
  );
  if (kind === "validation" && t.validation) {
    if (t.validation.passed) return (
      <div className="ar-callout ok"><b>Validation passed.</b> This roster can run a scored tournament on the same code and settings.
        <Cmd cmd={`pnpm --filter @ygosim/tournament start -- --players ${t.players.map((p) => p.id).join(",")} --validated-by ${t.id}`} /></div>
    );
    if (state === "finished") return (
      <div className="ar-callout bad"><b>Validation failed.</b> {t.validation.missingPlayers.length
        ? `No clean finished game for ${t.validation.missingPlayers.map((id) => t.players.find((p) => p.id === id)?.label ?? id).join(", ")}.`
        : "No game finished cleanly."} Fix the cause shown on the match, then validate again.</div>
    );
  }
  return null;
}

/** A match as a scoreboard: both agents, their decks, LP in the middle, and how it ended. */
const MatchRow = memo(function MatchRow({ g, t, byId, live, onOpen }: { g: TGame; t: Tournament; byId: Map<string, TPlayer>; live: boolean; onOpen: () => void }) {
  const now = useNow(live);
  const [a, b] = g.seats.map((id) => byId.get(id) ?? { id, label: id, cli: "pi" as const, model: "" });
  const lp = (i: 0 | 1) => g.lp?.[g.seats[i]] ?? g.live?.lp[i];
  const stalled = g.status === "running" && !live;
  const decided = g.status === "done" && g.winner !== null;
  const side = (i: 0 | 1) => (decided ? (g.winner === g.seats[i] ? " won" : " lost") : live && g.live?.turnPlayer === i ? " turn" : "");
  const cap = (t.audit?.maxMinutes ?? 0) * 60_000;
  const elapsed = live && g.startedAt ? now - Date.parse(g.startedAt) : 0;
  const dur = g.durationMs ?? (g.startedAt && g.endedAt ? Date.parse(g.endedAt) - Date.parse(g.startedAt) : 0);
  const label = g.stage === "final" ? "Final" : g.stage === "series" ? `Game ${g.round}` : `Round ${g.round}`;
  const result = g.status === "done"
    ? `${g.winner === null ? "Draw" : `${byId.get(g.winner)?.label ?? g.winner} won`}${g.reason ? ` · ${reasonText(g.reason)}` : ""}${g.turns ? ` · ${g.turns} turns` : ""}${dur ? ` · ${duration(dur)}` : ""}`
    : live ? (g.live ? `Turn ${g.live.turn} · ${phaseText(g.live.phase)} · ${(g.live.turnPlayer === 0 ? a : b).label} to play` : Object.keys(g.decks).length < 2 ? "Agents are building decks" : "Duel starting") + (elapsed ? ` · ${duration(elapsed)}` : "")
    : stalled ? "Stopped mid-game — resume replays it"
    : g.status === "error" ? g.error ?? "Error"
    : "Waiting";
  return (
    <button className={`ar-match ar-match-${live ? "live" : stalled ? "stalled" : g.status}`} onClick={onOpen}>
      <ArtBg code={signatureCard(g.decks[a.id])} side="left" />
      <ArtBg code={signatureCard(g.decks[b.id])} side="right" />
      <span className="ar-match-label">{label}</span>
      <span className={`ar-seat${side(0)}`}><Agent p={a} /><small>{g.decks[a.id] ? deckTitle(g.decks[a.id]!) : live ? "building deck…" : ""}</small></span>
      <span className="ar-score">{lp(0) === undefined && lp(1) === undefined ? <span className="ar-score-sep">vs</span> : <>
        <b className={lp(0)! <= 2000 ? "low" : ""}>{lp(0)?.toLocaleString() ?? "—"}</b>
        <span className="ar-score-sep">{decided ? "–" : "vs"}</span>
        <b className={lp(1)! <= 2000 ? "low" : ""}>{lp(1)?.toLocaleString() ?? "—"}</b>
      </>}</span>
      <span className={`ar-seat right${side(1)}`}><Agent p={b} align="right" /><small>{g.decks[b.id] ? deckTitle(g.decks[b.id]!) : live ? "building deck…" : ""}</small></span>
      <span className={`ar-match-foot${g.status === "error" || stalled ? " err" : ""}`}>{result}</span>
      {live && cap > 0 && <span className="ar-cap" title={`${duration(elapsed)} of the ${t.audit!.maxMinutes}-minute cap`}><span style={{ width: `${Math.min(100, (elapsed / cap) * 100)}%` }} /></span>}
      <span className="ar-chevron" aria-hidden="true">›</span>
    </button>
  );
});

function CrossTable({ t, onGame }: { t: Tournament; onGame: (gid: string) => void }) {
  const ids = t.players.map((p) => p.id);
  const label = (id: string) => t.players.find((p) => p.id === id)?.label ?? id;
  const find = (a: string, b: string) => t.games.find((g) => (g.stage === "round-robin" || g.stage === "series") && g.seats.includes(a) && g.seats.includes(b));
  return (
    <div className="ar-table-wrap">
      <table className="ar-table ar-cross">
        <thead><tr><th />{ids.map((id) => <th key={id} className="c">{label(id)}</th>)}</tr></thead>
        <tbody>
          {ids.map((a) => (
            <tr key={a}>
              <th>{label(a)}</th>
              {ids.map((b) => {
                if (a === b) return <td key={b} className="c self" />;
                const g = find(a, b);
                if (!g) return <td key={b} className="c muted">·</td>;
                const r = g.status !== "done" ? (g.status === "running" ? "live" : g.status === "error" ? "err" : "—") : g.winner === a ? "W" : g.winner === null ? "D" : "L";
                return <td key={b} className={`c res-${r}`}><button onClick={() => onGame(g.id)}>{r}</button></td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

