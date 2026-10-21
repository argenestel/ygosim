import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DuelScreen } from "../duel/DuelScreen";
import { createReplay, type Frame } from "./replay";
import { getGame, getReplay, getTimeline, phaseText, secs, tailReplay, type GameView, type TimelineEvent } from "./api";
import { usePoll, useTimeline } from "./hooks";
import { isRoutinePass } from "./ui";

type Row = Extract<TimelineEvent, { type: "decision" }>;

export function ReplayScreen({ view, onExit }: { view: GameView; onExit: () => void }) {
  const [replay, setReplay] = useState<ReturnType<typeof createReplay> | null>(null);
  const [err, setErr] = useState<string>();
  const { tournament: t, players } = view;
  const game = view.game;

  // The game may still be running: follow it until the API reports it finished.
  const [fresh] = usePoll(() => getGame(t.id, game.id), [t.id, game.id], (v) => ((v ?? view).game.status === "running" && (v ?? view).tournament.state === "live" ? 3000 : false));
  const status = (fresh ?? view).game.status;
  const live = status === "running" && (fresh ?? view).tournament.state === "live";
  // Rooms name seats "Tournament-<game>-<agent id>"; show the agents' labels instead.
  const named = (f: Frame): Frame => {
    if (f.msg.type !== "room") return f;
    const label = (n: string) => players.find((p) => n === p.id || n.endsWith(`-${p.id}`))?.label ?? n;
    return { ...f, msg: { ...f.msg, players: f.msg.players.map(label) } };
  };
  const tl = useTimeline((cursor) => getTimeline(t.id, game.id, cursor), `${t.id}/${game.id}`, live);
  const rows = useMemo(() => tl.events.filter((e): e is Row => e.type === "decision"), [tl.events]);

  useEffect(() => {
    let on = true;
    getReplay(t.id, game.id).then((frames) => {
      if (!on) return;
      if (!frames.length && game.status !== "running") return setErr("This game has no recorded frames yet.");
      if (!frames.length) return setErr("The game has started but no board frames have been recorded yet — try again in a moment.");
      setReplay(createReplay(frames.map(named)));
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
        replay.append(more.map(named));
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
      <ReplayDock replay={replay} rows={rows} names={[players[0].label, players[1].label]} title={`${players[0].label} vs ${players[1].label}`} />
    </>
  );
}

function useReplayTick(replay: ReturnType<typeof createReplay>) {
  return useSyncExternalStore(replay.subscribe, () => `${replay.index}|${replay.playing}|${replay.rate}|${replay.frames.length}|${replay.live}`);
}

function ReplayDock({ replay, rows, names, title }: { replay: ReturnType<typeof createReplay>; rows: Row[]; names: [string, string]; title: string }) {
  useReplayTick(replay);
  const [open, setOpen] = useState(true);
  const [only, setOnly] = useState<"all" | 0 | 1>("all");
  const [passes, setPasses] = useState(false);
  const now = replay.now();
  const end = replay.frames[replay.frames.length - 1]?.t ?? 0;
  const shown = useMemo(() => rows.filter((r) => r.at <= now && (only === "all" || r.seat === only) && (passes || !isRoutinePass(r.prompt.kind, r.choice))), [rows, now, only, passes]);
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
              {names.map((n, i) => <button key={i} className={only === i ? "on" : ""} onClick={() => setOnly(i as 0 | 1)}>{n}</button>)}
            </div>
            <label className="ar-check"><input type="checkbox" checked={passes} onChange={(e) => setPasses(e.target.checked)} /> Show routine passes</label>
          </header>
          <ol ref={listRef}>
            {shown.map((r, i) => (
              <li key={i} className={`s${r.seat}`} onClick={() => seekTime(r.at)} title="Jump here">
                <div className="meta"><b>{names[r.seat]}</b>{r.turn !== undefined && <span>T{r.turn}</span>}<span>{r.prompt.label}{r.phase ? ` · ${phaseText(r.phase)}` : ""}</span>{r.thinkMs !== undefined && <span>{secs(r.thinkMs)}</span>}</div>
                <div className="pick">{r.choice.join(", ")}</div>
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
