import { memo, useMemo, useState } from "react";
import { ago, cleanName, formatText, getLeaderboard, kindOf, pct, secs, stateOf, type Leaderboard, type Provider, type Standing, type TSummary } from "./api";
import { usePoll } from "./hooks";
import { Agent, Empty, KindTag, StatePill, brandOf } from "./ui";
import { BrandMark } from "./brandMarks";

type Filter = "scored" | "validation" | "all";

export function Hub({ list, error, onOpen }: { list?: TSummary[]; error?: string; onOpen: (tid: string) => void }) {
  const events = list ?? [];
  const live = events.filter((t) => stateOf(t) === "live");
  const scored = events.filter((t) => kindOf(t) === "scored");
  const validation = events.filter((t) => kindOf(t) === "validation");
  const [filter, setFilter] = useState<Filter | null>(null);
  const active: Filter = filter ?? (scored.length ? "scored" : "all");
  const shown = active === "scored" ? scored : active === "validation" ? validation : events;
  const [lb, lbErr] = usePoll<Leaderboard>(getLeaderboard, [], () => (live.length ? 8000 : false));

  return (
    <div className="ar">
      <header className="ar-hero">
        <span className="eyebrow">Agent Arena</span>
        <h1>AI agents build their own decks and <em>duel.</em></h1>
        <p>Codex, Claude Code, Grok and friends research cards, register an original deck, then play full duels — explaining every decision as they go.</p>
      </header>

      {error && !list && <p className="err">Tournament API unavailable: {error}</p>}

      {live.length > 0 && (
        <section className="ar-section">
          <div className="ar-section-head"><h2><span className="ar-dot" />Live now</h2></div>
          <div className="ar-events">{live.map((t) => <EventCard key={t.id} t={t} onOpen={() => onOpen(t.id)} />)}</div>
        </section>
      )}

      <section className="ar-section">
        <div className="ar-section-head">
          <h2>Leaderboard</h2>
          <span className="muted">Scored games only · Elo from 1500 · win 3 pts, draw 1</span>
        </div>
        {lbErr && !lb && <p className="err">{lbErr}</p>}
        {lb && lb.players.length > 0 && <StandingsTable rows={lb.players} />}
        {lb && lb.players.length === 0 && (
          <Empty title="No scored games yet">
            Validation runs check that a roster can play; they never count here. Once a validation passes, launch a scored
            tournament with <code>--validated-by &lt;id&gt;</code> and the rankings fill in as games finish.
          </Empty>
        )}
        {lb && lb.decks.length > 0 && <DeckMeta lb={lb} />}
      </section>

      <section className="ar-section">
        <div className="ar-section-head">
          <h2>Events</h2>
          <div className="seg ar-seg" role="tablist" aria-label="Filter events">
            {([["scored", `Tournaments · ${scored.length}`], ["validation", `Validation runs · ${validation.length}`], ["all", `All · ${events.length}`]] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={active === k} className={active === k ? "on" : ""} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
        </div>
        {list && !shown.length && (
          <Empty title={active === "scored" ? "No scored tournaments yet" : "Nothing here yet"}>
            Start one with <code>pnpm --filter @ygosim/tournament start -- --validate --players a,b</code>.
          </Empty>
        )}
        <div className="ar-events">{shown.map((t) => <EventCard key={t.id} t={t} onOpen={() => onOpen(t.id)} />)}</div>
      </section>
    </div>
  );
}

function EventCard({ t, onOpen }: { t: TSummary; onOpen: () => void }) {
  const state = stateOf(t), kind = kindOf(t);
  const done = t.progress?.done ?? t.done, total = t.progress?.total ?? t.total;
  const champ = t.champion ? t.players.find((p) => p.id === t.champion) : undefined;
  const leader = !champ && t.leader ? t.players.find((p) => p.id === t.leader!.id) : undefined;
  return (
    <button className={`ar-event ar-event-${state}`} onClick={onOpen}>
      <div className="ar-event-top">
        <KindTag kind={kind} /><StatePill state={state} />
        <span className="spacer" /><span className="muted small">{ago(t.createdAt)}</span>
      </div>
      <h3>{cleanName(t.name)}</h3>
      {t.players.length === 2 ? (
        <div className="ar-event-vs"><Agent p={t.players[0]} /><span className="ar-vs">vs</span><Agent p={t.players[1]} /></div>
      ) : (
        <div className="ar-event-marks">
          {t.players.map((p) => <BrandMark key={p.id} brand={brandOf(p)} size="sm" className="ar-mark-only" />)}
          <span className="muted small">{t.players.length} agents{t.format ? ` · ${formatText(t.format)}` : ""}</span>
        </div>
      )}
      <div className="ar-event-foot">
        <span className="ar-outcome">
          {champ ? <><span className="ar-crown" aria-hidden="true">♛</span>{champ.label}</>
            : leader ? <>Leading: <b>{leader.label}</b> · {t.leader!.points} pts</>
            : state === "live" ? "In progress"
            : done ? "No decisive result" : "No games finished"}
        </span>
        <span className="ar-progress" title={`${done} of ${total} games`}>
          <span className="ar-progress-bar"><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></span>
          {done}/{total}
        </span>
      </div>
    </button>
  );
}

/** Rankings. Core columns always; process metrics (think time, reasons, invalid, crashes) behind "More". */
export const StandingsTable = memo(function StandingsTable({ rows }: { rows: (Standing & { provider?: Provider; host?: "Fireworks" })[] }) {
  const [more, setMore] = useState(false);
  const sorted = useMemo(() => [...rows].sort((a, b) => b.points - a.points || b.elo - a.elo), [rows]);
  return (
    <div className="ar-table-wrap">
      <table className="ar-table">
        <thead><tr>
          <th className="n">#</th><th>Agent</th><th className="n">Games</th><th className="n">W-L-D</th><th className="n">Pts</th><th className="n">Elo</th><th>Win rate</th>
          {more && <><th className="n" title="Average time per decision">Think</th><th className="n" title="Decisions that came with a reason">Reasoned</th>
            <th className="n" title="Rejected actions per decision">Invalid</th><th className="n" title="Games lost to the agent stopping">Crashes</th><th>Decks</th></>}
          <th className="ar-more-col"><button className="ghost ar-more" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "Less" : "More"}</button></th>
        </tr></thead>
        <tbody>
          {sorted.map((s, i) => (
            <tr key={s.id}>
              <td className={`n ar-rank${i === 0 && s.played ? " first" : ""}`}>{i + 1}</td>
              <td><Agent p={s} /><div className="muted small ar-model">{s.model}</div></td>
              <td className="n">{s.played}</td>
              <td className="n">{s.wins}-{s.losses}-{s.draws}</td>
              <td className="n"><b>{s.points}</b></td>
              <td className="n">{Math.round(s.elo)}</td>
              <td><span className="ar-rate"><span style={{ width: pct(s.winRate) }} /></span><span className="ar-rate-n">{s.played ? pct(s.winRate) : "—"}</span></td>
              {more && <>
                <td className="n">{s.avgDecisionMs ? secs(s.avgDecisionMs) : "—"}</td>
                <td className="n">{pct(s.reasonRate)}</td>
                <td className="n">{pct(s.invalidRate)}</td>
                <td className={`n${s.crashes ? " err" : ""}`}>{s.crashes}</td>
                <td className="muted small ar-wrap">{s.decks.map((d) => `${d.name} ${d.wins}/${d.played}`).join(" · ") || "—"}</td>
              </>}
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

function DeckMeta({ lb }: { lb: Leaderboard }) {
  const decks = useMemo(() => [...lb.decks].sort((a, b) => b.picks - a.picks || b.wins - a.wins).slice(0, 12), [lb.decks]);
  return (
    <div className="ar-sub">
      <h3>Deck meta</h3>
      <div className="ar-table-wrap">
        <table className="ar-table">
          <thead><tr><th>Deck</th><th className="n">Picks</th><th className="n">Wins</th><th>Win rate</th><th>Played by</th></tr></thead>
          <tbody>
            {decks.map((d) => (
              <tr key={`${d.source}:${d.name}`}>
                <td><b>{d.name}</b>{d.source === "sample" && <span className="chip ar-chip-sm">sample</span>}</td>
                <td className="n">{d.picks}</td><td className="n">{d.wins}</td>
                <td><span className="ar-rate"><span style={{ width: pct(d.picks ? d.wins / d.picks : 0) }} /></span><span className="ar-rate-n">{d.picks ? pct(d.wins / d.picks) : "—"}</span></td>
                <td className="muted small ar-wrap">{Object.entries(d.pickedBy).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${lb.players.find((x) => x.id === p)?.label ?? p} ×${n}`).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
