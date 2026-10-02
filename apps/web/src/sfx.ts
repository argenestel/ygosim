// Procedural sound effects (WebAudio) — no audio assets to license or download.
import type { DuelEvent } from "@ygosim/protocol";

let ctx: AudioContext | undefined;
let master: GainNode | undefined;
let muted = (() => { try { return localStorage.getItem("ygosim.muted") === "1"; } catch { return false; } })();

function ac() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  try { localStorage.setItem("ygosim.muted", m ? "1" : "0"); } catch {}
  if (master) master.gain.value = m ? 0 : 0.35;
}

function tone(freq: number, dur: number, { type = "sine" as OscillatorType, gain = 0.4, slide = 0, delay = 0 } = {}) {
  const a = ac(), t = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!);
  o.start(t); o.stop(t + dur + 0.05);
}

function noise(dur: number, { gain = 0.3, from = 2000, to = 200, delay = 0, q = 1 } = {}) {
  const a = ac(), t = a.currentTime + delay;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = "bandpass"; f.Q.value = q;
  f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master!);
  src.start(t);
}

const chord = (notes: number[], dur: number, type: OscillatorType = "triangle", gain = 0.18) =>
  notes.forEach((n, i) => tone(n, dur, { type, gain, delay: i * 0.06 }));

/** Play the sound for one duel event. Safe to call before any user gesture (it just stays silent). */
export function playEvent(e: DuelEvent, you: number) {
  if (muted) return;
  try {
    switch (e.t) {
      case "draw": noise(0.12, { gain: 0.15, from: 4000, to: 1500, q: 2 }); break;
      case "move":
        if (e.reason === "destroy") { noise(0.5, { gain: 0.45, from: 6000, to: 300, q: 0.7 }); tone(180, 0.3, { type: "square", gain: 0.08, slide: 0.4 }); }
        else noise(0.15, { gain: 0.12, from: 2500, to: 800, q: 2 });
        break;
      case "summon":
        switch (e.kind) {
          case "fusion": chord([262, 330, 392, 523], 1.1, "sawtooth", 0.08); noise(1, { gain: 0.15, from: 300, to: 3000 }); break;
          case "synchro": chord([523, 659, 784, 1046, 1318], 1, "sine", 0.14); break;
          case "xyz": chord([196, 294, 392, 587], 1.3, "triangle", 0.14); tone(98, 1.2, { gain: 0.25 }); break;
          case "link": [880, 1175, 1568].forEach((f, i) => tone(f, 0.25, { type: "square", gain: 0.06, delay: i * 0.09 })); tone(110, 0.8, { gain: 0.3 }); break;
          case "pendulum": tone(440, 0.6, { slide: 1.5, gain: 0.15 }); tone(660, 0.6, { slide: 0.66, gain: 0.15, delay: 0.1 }); break;
          case "ritual": chord([147, 220, 294], 1.4, "sawtooth", 0.07); break;
          case "special": tone(330, 0.5, { slide: 2, type: "triangle", gain: 0.2 }); noise(0.4, { gain: 0.15, from: 500, to: 4000 }); break;
          default: tone(90, 0.35, { slide: 0.5, gain: 0.5 }); noise(0.25, { gain: 0.2, from: 800, to: 200 });
        }
        break;
      case "activate": tone(660, 0.35, { slide: 1.5, type: "triangle", gain: 0.18 }); tone(990, 0.3, { gain: 0.1, delay: 0.08 }); break;
      case "chain_solved": tone(1320, 0.12, { gain: 0.08 }); break;
      case "attack": noise(0.45, { gain: 0.3, from: 400, to: 3000, q: 0.8 }); tone(70, 0.5, { gain: 0.5, slide: 0.6, delay: 0.35 }); break;
      case "damage": tone(e.player === you ? 120 : 220, 0.5, { type: "sawtooth", gain: 0.18, slide: 0.5 }); break;
      case "pay_lp": tone(520, 0.18, { type: "triangle", gain: 0.08, slide: 0.8 }); break;
      case "recover": chord([784, 988, 1175], 0.5, "sine", 0.1); break;
      case "new_turn": chord(e.turnPlayer === you ? [392, 523, 659] : [330, 392, 494], 0.6, "triangle", 0.12); break;
      case "phase": tone(880, 0.06, { gain: 0.05 }); break;
      case "shuffle": [0, 0.05, 0.1].forEach((d) => noise(0.08, { gain: 0.1, from: 3000, to: 1200, delay: d })); break;
      case "win": chord(e.winner === you ? [523, 659, 784, 1046] : [392, 311, 262], 1.6, "triangle", 0.15); break;
    }
  } catch { /* audio unavailable */ }
}

export const uiClick = () => { if (!muted) try { tone(1200, 0.04, { gain: 0.05, type: "square" }); } catch {} };
