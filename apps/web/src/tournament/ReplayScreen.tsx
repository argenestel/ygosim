import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DuelScreen } from "../duel/DuelScreen";
import { createReplay } from "./replay";
import { chosenText, getReplay, getTournament, relTime, secs, tailDecisions, tailReplay, type Decision, type TGame, type Tournament } from "./api";
import { usePoll, useTail } from "./hooks";

type Row = Decision & { pid: string; rt: number };

export function ReplayScreen({ t, game, onExit }: { t: Tournament; game: TGame; onExit: () => void }) {
  const [replay, setReplay] = useState<ReturnType<typeof createReplay> | null>(null);
  const [err, setErr] = useState<string>();
  const label = (pid: string) => t.players.find((p) => p.id === pid)?.label ?? pid;

  // The game may still be running: follow it until the tournament reports it finished.
  const [fresh] = usePoll(() => getTournament(t.id), [t.id], (x) => (x?.games.find((g) => g.id === game.id)?.status ?? game.status) === "running" && 3000);
  const status = fresh?.games.find((g) => g.id === game.id)?.status ?? game.status;
  const live = status === "running";
  const seats = game.seats;
  const d0 = useTail<Decision>((from) => tailDecisions(t.id, game.id, seats[0], from), `${t.id}/${game.id}/${seats[0]}`, live);
  const d1 = useTail<Decision>((from) => tailDecisions(t.id, game.id, seats[1], from), `${t.id}/${game.id}/${seats[1]}`, live);
  const rows = useMemo<Row[]>(() => [...d0.rows.map((d) => ({ ...d, pid: seats[0], rt: relTime(d, game) })), ...d1.rows.map((d) => ({ ...d, pid: seats[1], rt: relTime(d, game) }))].sort((a, b) => a.rt - b.rt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d0.rows, d1.rows, game.startedAt]);

  useEffect(() => {
    let on = true;
    getReplay(t.id, game.id).then((frames) => {
      if (!on) return;
      if (!frames.length && game.status !== "running") return setErr("This game has no recorded frames yet.");
      if (!frames.length) return setErr("The game has started but no board frames have been recorded yet — try again in a moment.");
      setReplay(createReplay(frames));
    }).catch((e) => on && setErr(String(e.message ?? e)));
    return () => { on = false; };
  }, [t.id, game.id, game.status]);

  // Keep appending frames while live; one more pass after it ends catches the tail.
  useEffect(() => {
    if (!replay) return;
    replay.live = live;
    let on = true, timer: ReturnType<typeof setTimeout> | undefined, finals = live ? 0 : 1;
    const tick = async () => {
      if (!on) return;
      try {
        const { rows: more } = await tailReplay(t.id, game.id, replay.frames.length);
        if (!on) return;
        replay.append(more);
      } catch { /* keep trying while live */ }
      if (live || finals-- > 0) timer = setTimeout(tick, live ? 1500 : 800);
    };
    tick();
    return () => { on = false; clearTimeout(timer); };
  }, [replay, live, t.id, game.id]);

  if (err) return <div className="duel-wait"><h2>Replay unavailable</h2><p className="muted">{err}</p><button onClick={onExit}>Back</button></div>;
  if (!replay) return <div className="duel-wait"><div className="spinner" /><h2>Loading replay…</h2></div>;
  return (
    <>
      <DuelScreen launch={{ mode: "replay", replay }} deck={{ main: [], extra: [], side: [] }} name="Replay" onExit={onExit} />
      <ReplayDock replay={replay} rows={rows} seats={game.seats} label={label} title={`${label(game.seats[0])} vs ${label(game.seats[1])}`} />
    </>
  );
}

function useReplayTick(replay: ReturnType<typeof createReplay>) {
  return useSyncExternalStore(replay.subscribe, () => `${replay.index}|${replay.playing}|${replay.rate}|${replay.frames.length}|${replay.live}`);
}

function ReplayDock({ replay, rows, seats, label, title }: { replay: ReturnType<typeof createReplay>; rows: Row[]; seats: [string, string]; label: (p: string) => string; title: string }) {
  useReplayTick(replay);
  const [open, setOpen] = useState(true);
  const [only, setOnly] = useState<string | "all">("all");
  const now = replay.now();
  const end = replay.frames[replay.frames.length - 1]?.t ?? 0;
  const shown = useMemo(() => rows.filter((r) => r.rt <= now && (only === "all" || r.pid === only)), [rows, now, only]);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [shown.length]);
  // Seek by recorded time: find the first frame at or after the row's moment.
  const seekTime = (ms: number) => replay.seek(Math.max(0, replay.frames.findIndex((f) => f.t >= ms)) + 1);

  return (
    <>
      <div className="replay-bar" role="toolbar" aria-label="Replay controls">
        <b className="replay-title">{title}</b>
        <button onClick={() => replay.seek(0)} title="Restart">⏮</button>
        {replay.playing ? <button onClick={replay.pause} title="Pause">⏸</button> : <button onClick={replay.play} title="Play">▶</button>}
        <input type="range" min={0} max={replay.frames.length} value={replay.index} aria-label="Seek"
          onChange={(e) => replay.seek(Number(e.target.value))} />
        <span className="replay-time">{secs(now)} / {secs(end)}</span>
        {replay.live && <button className={replay.index >= replay.frames.length ? "on" : ""} onClick={() => { replay.seek(replay.frames.length); replay.play(); }} title="Jump to the live edge">● Live</button>}
        {[1, 2, 4, 8].map((r) => <button key={r} className={replay.rate === r ? "on" : ""} onClick={() => replay.setRate(r)}>{r}×</button>)}
        <button className={open ? "on" : ""} onClick={() => setOpen(!open)}>Reasoning</button>
      </div>
      {open && (
        <aside className="reasoning" aria-label="Agent reasoning">
          <header>
            <b>Reasoning</b>
            <div className="seg">
              <button className={only === "all" ? "on" : ""} onClick={() => setOnly("all")}>Both</button>
              {seats.map((p, i) => <button key={p} className={only === p ? "on" : ""} onClick={() => setOnly(p)}>{label(p)}{i === 0 ? " ①" : " ②"}</button>)}
            </div>
          </header>
          <ol ref={listRef}>
            {shown.map((r, i) => (
              <li key={i} className={r.pid === seats[0] ? "s0" : "s1"} onClick={() => seekTime(r.rt)} title="Jump here">
                <div className="meta"><b>{label(r.pid)}</b>{r.turn !== undefined && <span>T{r.turn}</span>}{r.phase && <span>{r.phase}</span>}{r.ms !== undefined && <span>{secs(r.ms)}</span>}</div>
                <div className="pick">→ {chosenText(r)}</div>
                {r.reason ? <p>{r.reason}</p> : <p className="muted">No reason given.</p>}
              </li>
            ))}
            {!shown.length && <li className="muted">Decisions appear here as the replay plays.</li>}
          </ol>
        </aside>
      )}
    </>
  );
}
