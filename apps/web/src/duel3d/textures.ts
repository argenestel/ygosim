import * as THREE from "three";

const loader = new THREE.TextureLoader();
loader.setCrossOrigin("anonymous");
const fronts = new Map<number, Promise<THREE.Texture>>();
const ready = new Map<number, THREE.Texture>();

/** Card art via the CORS-enabled proxy (WebGL textures need CORS). Cached per passcode. */
export function loadFront(code: number): Promise<THREE.Texture> {
  let p = fronts.get(code);
  if (!p) {
    p = loader.loadAsync(`/api/img/small/${code}`).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      ready.set(code, t);
      return t;
    }).catch((error) => { fronts.delete(code); throw error; });
    fronts.set(code, p);
  }
  return p;
}
export const readyFront = (code: number) => ready.get(code);

let blank: THREE.Texture | undefined;
export function placeholderTexture() {
  return (blank ??= makeCanvasTexture(256, 372, (g, w, h) => {
    g.fillStyle = "#3a2a18"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "#c9a35a"; g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8);
  }));
}

function makeCanvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let back: THREE.Texture | undefined;
/** Original card-back design (not Konami's): swirling vortex on a dark frame. */
export function backTexture() {
  // Original card back: deep navy with an engraved gold ring emblem. Deliberately
  // low-luminance so card backs never bloom or out-shine face-up cards.
  return (back ??= makeCanvasTexture(256, 372, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#1b2236"); bg.addColorStop(1, "#0e1322");
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    // Fine diagonal weave.
    g.strokeStyle = "rgba(160,180,220,0.05)"; g.lineWidth = 1;
    for (let i = -h; i < w; i += 9) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke(); }
    // Frame.
    g.strokeStyle = "#8a6d2c"; g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8);
    g.strokeStyle = "rgba(214,177,94,0.35)"; g.lineWidth = 2; g.strokeRect(16, 16, w - 32, h - 32);
    // Emblem: concentric rings and a four-point star.
    g.save(); g.translate(w / 2, h / 2);
    g.strokeStyle = "rgba(214,177,94,0.75)"; g.lineWidth = 3;
    g.beginPath(); g.arc(0, 0, 54, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = "rgba(214,177,94,0.4)"; g.lineWidth = 2;
    g.beginPath(); g.arc(0, 0, 70, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#b8944a";
    g.beginPath();
    for (let i = 0; i < 8; i++) { const r = i % 2 ? 12 : 40; const a = (i / 8) * Math.PI * 2 - Math.PI / 2; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fill();
    g.restore();
  }));
}

let glow: THREE.Texture | undefined;
/** Soft radial sprite used for particles, auras and pillars. */
export function glowTexture() {
  return (glow ??= makeCanvasTexture(128, 128, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.35, "rgba(255,255,255,0.5)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  }));
}

let beam: THREE.Texture | undefined;
/** Vertical fade used on summon light pillars. */
export function beamTexture() {
  return (beam ??= makeCanvasTexture(64, 256, (g, w, h) => {
    const l = g.createLinearGradient(0, h, 0, 0);
    l.addColorStop(0, "rgba(255,255,255,1)"); l.addColorStop(0.5, "rgba(255,255,255,0.35)"); l.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = l; g.fillRect(0, 0, w, h);
    const s = g.createLinearGradient(0, 0, w, 0);
    s.addColorStop(0, "rgba(0,0,0,1)"); s.addColorStop(0.5, "rgba(0,0,0,0)"); s.addColorStop(1, "rgba(0,0,0,1)");
    g.globalCompositeOperation = "destination-out"; g.fillStyle = s; g.fillRect(0, 0, w, h);
  }));
}
