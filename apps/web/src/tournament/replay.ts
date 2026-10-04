// Replays a recorded spectator stream (data/tournaments/<tid>/games/<gid>/replay.jsonl)
// through the normal duel screen by posing as a server connection.
import type { ServerMsg } from "@ygosim/protocol";
import type { Conn } from "../net";

export interface Frame { t: number; msg: ServerMsg; }

export interface ReplayControl {
  frames: Frame[];
  /** Index of the next frame to deliver. */
  index: number;
  playing: boolean;
  rate: number;
  play(): void;
  pause(): void;
  setRate(r: number): void;
  /** Jump to frame i, delivering the board state at that point without animating the gap. */
  seek(i: number): void;
  subscribe(fn: () => void): () => void;
  /** Recorded time (ms) of the frame most recently delivered. */
  now(): number;
}

/** Real-time gaps are capped so long LLM thinking pauses don't stall playback. */
const MAX_GAP_MS = 1200;

export function createReplay(frames: Frame[]): ReplayControl & { attach(onMsg: (m: ServerMsg) => void): Conn } {
  let onMsg: ((m: ServerMsg) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subs = new Set<() => void>();
  const notify = () => subs.forEach((f) => f());

  const ctl = {
    frames, index: 0, playing: true, rate: 1,
    now: () => frames[Math.max(0, ctl.index - 1)]?.t ?? 0,
    play() { if (ctl.index >= frames.length) ctl.seek(0); ctl.playing = true; schedule(); notify(); },
    pause() { ctl.playing = false; clearTimeout(timer); notify(); },
    setRate(r: number) { ctl.rate = r; schedule(); notify(); },
    seek(i: number) {
      clearTimeout(timer);
      i = Math.max(0, Math.min(frames.length, i));
      // Deliver the latest room + state before i so the board jumps straight there.
      let room: ServerMsg | undefined, state: ServerMsg | undefined;
      for (let k = 0; k < i; k++) {
        const m = frames[k].msg;
        if (m.type === "room") room = m;
        if (m.type === "events" || m.type === "prompt") state = { type: "events", events: [], state: m.state };
      }
      if (room) onMsg?.(room);
      if (state) onMsg?.(state);
      ctl.index = i;
      schedule();
      notify();
    },
    subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; },
    attach(fn: (m: ServerMsg) => void): Conn {
      onMsg = fn;
      fn({ type: "welcome", clientId: "replay" });
      schedule();
      return { send() { /* spectators can't act */ }, close() { clearTimeout(timer); onMsg = null; } };
    },
  };

  function schedule() {
    clearTimeout(timer);
    if (!ctl.playing || !onMsg || ctl.index >= frames.length) return;
    const prev = frames[ctl.index - 1]?.t ?? frames[0].t;
    const gap = Math.min(MAX_GAP_MS, Math.max(0, frames[ctl.index].t - prev));
    timer = setTimeout(() => {
      const f = frames[ctl.index++];
      // Prompts are private; spectators only ever see the board they carry.
      onMsg?.(f.msg.type === "prompt" ? { type: "events", events: [], state: f.msg.state } : f.msg);
      if (ctl.index >= frames.length) ctl.playing = false;
      notify();
      schedule();
    }, gap / ctl.rate);
  }

  return ctl;
}
