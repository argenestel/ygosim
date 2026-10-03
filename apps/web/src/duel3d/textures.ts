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
  return (back ??= makeCanvasTexture(256, 372, (g, w, h) => {
    const bg = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, h * 0.7);
    bg.addColorStop(0, "#4b2a8a"); bg.addColorStop(1, "#0d0620");
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.strokeStyle = "#b48a3a"; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
    g.strokeStyle = "#5a3d12"; g.lineWidth = 3; g.strokeRect(16, 16, w - 32, h - 32);
    g.save(); g.translate(w / 2, h / 2);
    for (let i = 0; i < 48; i++) {
      g.rotate((Math.PI * 2) / 48);
      const grad = g.createLinearGradient(0, 0, 90, 0);
      grad.addColorStop(0, "rgba(255,210,120,0.9)"); grad.addColorStop(1, "rgba(80,140,255,0)");
      g.strokeStyle = grad; g.lineWidth = 2;
      g.beginPath(); g.moveTo(18, 0); g.quadraticCurveTo(50, 22, 92, 6); g.stroke();
    }
    const core = g.createRadialGradient(0, 0, 0, 0, 0, 30);
    core.addColorStop(0, "#fff6d0"); core.addColorStop(0.5, "#ffb347"); core.addColorStop(1, "rgba(255,120,0,0)");
    g.fillStyle = core; g.beginPath(); g.arc(0, 0, 30, 0, Math.PI * 2); g.fill();
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
