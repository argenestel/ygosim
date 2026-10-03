import { Text } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";
import { CARD_H, CARD_W, zoneFrames } from "../duel/layout";
import { S } from "./space";

/**
 * The physical battle arena: a dark stone slab with a raised metal rim, an
 * engraved centre sigil and recessed zone markings. Cool blue light on the
 * viewer's half, warm amber on the opponent's. Everything here is static — the
 * board stays quieter than the cards and gameplay effects.
 */

export const ARENA = { w: 12.4, d: 8.9, rim: 0.34, rimH: 0.18 };
export const SIDE_COLOR = { me: "#4a90ff", op: "#ff8a3d" };

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = 1) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  return t;
}

/** Seeded value noise so the stone looks the same every load. */
function rng(seed: number) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

let stone: THREE.Texture | undefined;
function stoneTexture() {
  return (stone ??= canvasTexture(512, 512, (g) => {
    const r = rng(7);
    g.fillStyle = "#151a22"; g.fillRect(0, 0, 512, 512);
    // Mottled stone: many soft low-contrast blotches.
    for (let i = 0; i < 1400; i++) {
      const x = r() * 512, y = r() * 512, s = 4 + r() * 38, l = 14 + r() * 14;
      g.fillStyle = `hsla(220, 12%, ${l}%, ${0.05 + r() * 0.06})`;
      g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill();
    }
    // Fine grain.
    const img = g.getImageData(0, 0, 512, 512);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (r() - 0.5) * 10;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    // Hairline cracks.
    g.strokeStyle = "rgba(0,0,0,0.35)"; g.lineWidth = 1;
    for (let i = 0; i < 9; i++) {
      let x = r() * 512, y = r() * 512;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 60; y += (r() - 0.5) * 60; g.lineTo(x, y); }
      g.stroke();
    }
  }, 2));
}

let mat: THREE.Texture | undefined;
/** Playmat overlay: centre sigil, divider and faint engraved rings (original design). */
function matTexture() {
  return (mat ??= canvasTexture(2048, 1536, (g) => {
    const W = 2048, H = 1536, cx = W / 2, cy = H / 2;
    g.clearRect(0, 0, W, H);
    // Centre divider, engraved.
    const div = g.createLinearGradient(0, 0, W, 0);
    div.addColorStop(0, "rgba(214,177,94,0)"); div.addColorStop(0.2, "rgba(214,177,94,0.32)");
    div.addColorStop(0.8, "rgba(214,177,94,0.32)"); div.addColorStop(1, "rgba(214,177,94,0)");
    g.fillStyle = div; g.fillRect(0, cy - 2, W, 4);
    // Sigil: concentric rings + octagram, very low contrast.
    g.strokeStyle = "rgba(190,200,220,0.10)"; g.lineWidth = 3;
    for (const r of [150, 190, 300]) { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); }
    g.lineWidth = 2;
    for (let k = 0; k < 2; k++) {
      g.beginPath();
      for (let i = 0; i <= 4; i++) {
        const a = (i / 4) * Math.PI * 2 + (k * Math.PI) / 4;
        const x = cx + Math.cos(a) * 190, y = cy + Math.sin(a) * 190;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    // (Side identity comes from the rim strips and faint side lights, not from tinting the mat.)
  }));
}

const PILE_ICON: Record<string, string> = { FIELD: "FIELD", GY: "GY", BANISH: "BANISH", DECK: "DECK", EXTRA: "EXTRA", EX: "EX", P: "P" };

/** A zone engraved into the stone: darker recess plus a thin inner rule. */
function Zone({ x, z, kind, label, side }: { x: number; z: number; kind: string; label: string; side: "me" | "op" | "mid" }) {
  const w = CARD_W * S * 1.08, h = CARD_H * S * 1.06;
  const tint = side === "me" ? SIDE_COLOR.me : side === "op" ? SIDE_COLOR.op : "#d6b15e";
  const edge = useMemo(() => new THREE.EdgesGeometry(new THREE.PlaneGeometry(w * 0.92, h * 0.94)), [w, h]);
  return (
    <group position={[x, 0.004, z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial color="#0b0e13" roughness={0.95} metalness={0.05} transparent opacity={0.85} />
      </mesh>
      <lineSegments rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]} geometry={edge}>
        <lineBasicMaterial color={tint} transparent opacity={kind === "emz" ? 0.55 : 0.28} />
      </lineSegments>
      {label && (
        <Text position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, side === "op" ? Math.PI : 0]} fontSize={label.length > 2 ? 0.13 : 0.2} letterSpacing={0.12}
          color={tint} fillOpacity={0.32} anchorX="center" anchorY="middle">
          {PILE_ICON[label] ?? label}
        </Text>
      )}
    </group>
  );
}

export function Arena() {
  const frames = useMemo(() => zoneFrames(), []);
  const { w, d, rim, rimH } = ARENA;
  const rimMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#252b35", metalness: 0.75, roughness: 0.38 }), []);
  return (
    <group>
      {/* Stone slab */}
      <mesh position={[0, -0.15, 0]} receiveShadow>
        <boxGeometry args={[w, 0.3, d]} />
        <meshStandardMaterial map={stoneTexture()} color="#a4acba" roughness={0.9} metalness={0.08} />
      </mesh>
      {/* Engraved mat overlay */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
        <planeGeometry args={[w - 0.2, d - 0.2]} />
        <meshBasicMaterial map={matTexture()} transparent depthWrite={false} />
      </mesh>
      {/* Raised metal rim */}
      {[
        { p: [0, rimH / 2 - 0.05, d / 2 + rim / 2], s: [w + rim * 2, rimH, rim], side: "me" },
        { p: [0, rimH / 2 - 0.05, -d / 2 - rim / 2], s: [w + rim * 2, rimH, rim], side: "op" },
        { p: [w / 2 + rim / 2, rimH / 2 - 0.05, 0], s: [rim, rimH, d], side: "x" },
        { p: [-w / 2 - rim / 2, rimH / 2 - 0.05, 0], s: [rim, rimH, d], side: "x" },
      ].map((r, i) => (
        <mesh key={i} position={r.p as [number, number, number]} material={rimMat} castShadow receiveShadow>
          <boxGeometry args={r.s as [number, number, number]} />
        </mesh>
      ))}
      {/* Inset light strips along the near (blue) and far (amber) rims */}
      <mesh position={[0, rimH - 0.04, d / 2 + 0.03]}>
        <boxGeometry args={[w * 0.82, 0.012, 0.03]} />
        {/* Tone-mapped and dim enough to stay under the bloom threshold (no colour haze). */}
        <meshBasicMaterial color="#2f63b8" />
      </mesh>
      <mesh position={[0, rimH - 0.04, -d / 2 - 0.03]}>
        <boxGeometry args={[w * 0.82, 0.012, 0.03]} />
        <meshBasicMaterial color="#b05a22" />
      </mesh>
      {/* Zone markings */}
      {frames.map((f) => (
        <Zone key={f.key} x={f.x * S} z={f.y * S} kind={f.kind} label={f.label}
          side={f.kind === "emz" ? "mid" : f.key.startsWith("me") ? "me" : "op"} />
      ))}
    </group>
  );
}

/** Static environment lighting: neutral key light plus side-coloured fills. */
export function ArenaLights({ shadows }: { shadows: boolean }) {
  return (
    <>
      <hemisphereLight args={["#cdd6e8", "#0d0f14", 0.5]} />
      <directionalLight position={[2.5, 12, 4]} intensity={1.55} castShadow={shadows}
        shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004}
        shadow-camera-left={-7} shadow-camera-right={7} shadow-camera-top={6} shadow-camera-bottom={-6} />
      <pointLight position={[0, 2.2, 4.9]} intensity={0.6} distance={6} decay={2} color="#8ab6ff" />
      <pointLight position={[0, 2.2, -4.9]} intensity={0.32} distance={6} decay={2} color="#ffb98a" />
      
    </>
  );
}
