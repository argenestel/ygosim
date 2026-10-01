import { Billboard, Text } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { DuelEvent } from "@ygosim/protocol";
import { beamTexture, glowTexture } from "./textures";

type Kind = Extract<DuelEvent, { t: "summon" }>["kind"];

export const SUMMON_STYLE: Record<Kind, { color: string; accent: string; title?: string; dur: number }> = {
  normal: { color: "#ffe6b0", accent: "#ffffff", dur: 0.9 },
  set: { color: "#9fb4d8", accent: "#ffffff", dur: 0.7 },
  flip: { color: "#ffd56a", accent: "#ffffff", dur: 0.8 },
  special: { color: "#bfe6ff", accent: "#ffffff", dur: 1.1 },
  fusion: { color: "#e05cff", accent: "#5cc8ff", title: "FUSION SUMMON", dur: 1.7 },
  synchro: { color: "#c9fff1", accent: "#6affd6", title: "SYNCHRO SUMMON", dur: 1.7 },
  xyz: { color: "#ffd56a", accent: "#8a5cff", title: "XYZ SUMMON", dur: 1.7 },
  link: { color: "#4ea8ff", accent: "#bde3ff", title: "LINK SUMMON", dur: 1.7 },
  pendulum: { color: "#3fe0a0", accent: "#ff8a3c", title: "PENDULUM SUMMON", dur: 1.7 },
  ritual: { color: "#6a9cff", accent: "#e8f0ff", title: "RITUAL SUMMON", dur: 1.7 },
};

/** Elapsed seconds since this effect mounted. */
function useAge() {
  const clock = useThree((s) => s.clock);
  const t0 = useRef(clock.elapsedTime);
  return () => clock.elapsedTime - t0.current;
}

const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

function Ring({ color, delay = 0, dur = 0.8, from = 0.3, to = 2.2, y = 0.03, width = 0.08 }: { color: string; delay?: number; dur?: number; from?: number; to?: number; y?: number; width?: number }) {
  const m = useRef<THREE.Mesh>(null);
  const age = useAge();
  const geo = useMemo(() => new THREE.RingGeometry(1 - width, 1, 64), [width]);
  useFrame(() => {
    const p = (age() - delay) / dur;
    if (!m.current) return;
    m.current.visible = p >= 0 && p <= 1;
    const s = from + (to - from) * ease(p);
    m.current.scale.setScalar(s);
    (m.current.material as THREE.MeshBasicMaterial).opacity = 1 - p;
  });
  return (
    <mesh ref={m} geometry={geo} rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]}>
      <meshBasicMaterial color={color} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Pillar({ color, dur = 1, radius = 0.55, height = 5 }: { color: string; dur?: number; radius?: number; height?: number }) {
  const m = useRef<THREE.Mesh>(null);
  const age = useAge();
  useFrame(() => {
    const p = age() / dur;
    if (!m.current) return;
    m.current.visible = p <= 1;
    const grow = ease(p * 3);
    m.current.scale.set(grow * (1 - p * 0.5), grow, grow * (1 - p * 0.5));
    (m.current.material as THREE.MeshBasicMaterial).opacity = p < 0.3 ? 1 : 1 - (p - 0.3) / 0.7;
  });
  return (
    <mesh ref={m} position={[0, height / 2, 0]}>
      <cylinderGeometry args={[radius, radius * 1.2, height, 32, 1, true]} />
      <meshBasicMaterial map={beamTexture()} color={color} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** GPU point burst; `swirl` makes particles orbit (fusion / xyz galaxy). */
function Burst({ color, n = 60, speed = 3, dur = 1, swirl = 0, rise = 0.6, size = 0.12, spread = 1 }: { color: string; n?: number; speed?: number; dur?: number; swirl?: number; rise?: number; size?: number; spread?: number }) {
  const pts = useRef<THREE.Points>(null);
  const age = useAge();
  const { geo, vel } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const v: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = (0.4 + Math.random() * 0.6) * spread;
      v.push(a, r, Math.random() * rise + 0.1);
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return { geo: g, vel: v };
  }, [n, rise, spread]);
  useFrame(() => {
    const t = age(), p = t / dur;
    if (!pts.current) return;
    pts.current.visible = p <= 1;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) {
      const a = vel[i * 3] + swirl * t * 4, r = vel[i * 3 + 1] * speed * ease(p) * (swirl ? 1 - p * 0.6 : 1);
      pos.setXYZ(i, Math.cos(a) * r, vel[i * 3 + 2] * speed * ease(p) - (swirl ? 0 : 1.5 * p * p), Math.sin(a) * r);
    }
    pos.needsUpdate = true;
    (pts.current.material as THREE.PointsMaterial).opacity = 1 - p;
  });
  return (
    <points ref={pts} geometry={geo}>
      <pointsMaterial map={glowTexture()} color={color} size={size} sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
    </points>
  );
}

function Glyph({ kind, color, dur }: { kind: Kind; color: string; dur: number }) {
  const g = useRef<THREE.Group>(null);
  const age = useAge();
  useFrame(() => {
    const p = age() / dur;
    if (!g.current) return;
    g.current.visible = p <= 1;
    g.current.rotation.y = p * (kind === "ritual" ? 2.5 : 4);
    g.current.scale.setScalar(0.4 + ease(p * 2) * 1.2);
    g.current.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined; if (m) m.opacity = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4; });
  });
  const mat = <meshBasicMaterial color={color} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} side={THREE.DoubleSide} />;
  return (
    <group ref={g} position={[0, 0.05, 0]}>
      {kind === "fusion" && [0, 1, 2].map((i) => (
        <mesh key={i} rotation={[Math.PI / 2 + 0.4 * (i - 1), 0, i]} position={[0, 0.6 + i * 0.3, 0]}><torusGeometry args={[1.2 - i * 0.25, 0.03, 8, 64]} />{mat}</mesh>
      ))}
      {kind === "synchro" && [0, 1, 2, 3].map((i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[0, i * 0.7, 0]}><ringGeometry args={[0.9, 0.96, 64]} />{mat}</mesh>
      ))}
      {kind === "xyz" && (
        <mesh rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.3, 1.5, 64, 1, 0, Math.PI * 1.6]} />{mat}</mesh>
      )}
      {kind === "link" && (
        <mesh rotation={[-Math.PI / 2, 0, Math.PI / 4]}><ringGeometry args={[1.1, 1.2, 4]} />{mat}</mesh>
      )}
      {kind === "pendulum" && [-1.4, 1.4].map((x) => (
        <mesh key={x} position={[x, 1.6, 0]}><cylinderGeometry args={[0.08, 0.08, 3.2, 12, 1, true]} />{mat}</mesh>
      ))}
      {kind === "ritual" && Array.from({ length: 5 }, (_, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, (i / 5) * Math.PI * 2]} position={[0, 0, 0]}>
          <ringGeometry args={[1.3, 1.42, 32, 1, 0, Math.PI / 4]} />{mat}
        </mesh>
      ))}
    </group>
  );
}

function Title({ text, color, dur }: { text: string; color: string; dur: number }) {
  const ref = useRef<THREE.Group>(null);
  const age = useAge();
  useFrame(() => {
    const p = age() / dur;
    if (!ref.current) return;
    ref.current.visible = p <= 1;
    ref.current.scale.setScalar(p < 0.2 ? 0.6 + 2 * p : 1 + (p - 0.2) * 0.1);
    ref.current.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material & { opacity?: number }; if (m && "opacity" in m) { m.transparent = true; m.opacity = p < 0.2 ? p * 5 : p > 0.8 ? (1 - p) * 5 : 1; } });
  });
  return (
    <Billboard ref={ref} position={[0, 2.2, 0]}>
      <Text fontSize={0.5} color={color} outlineWidth={0.02} outlineColor="#000" letterSpacing={0.12} anchorX="center" anchorY="middle">{text}</Text>
    </Billboard>
  );
}

export function SummonFx({ kind, at }: { kind: Kind; at: THREE.Vector3 }) {
  const s = SUMMON_STYLE[kind];
  const big = !!s.title;
  return (
    <group position={at}>
      <Ring color={s.color} dur={0.7} width={kind === "normal" || kind === "set" ? 0.3 : 0.08} />
      {big && <><Ring color={s.accent} delay={0.15} /><Ring color={s.color} delay={0.3} to={3} /></>}
      {kind !== "set" && kind !== "normal" && kind !== "flip" && <Pillar color={s.color} dur={s.dur} />}
      <Burst color={s.color} n={big ? 120 : 40} dur={s.dur} swirl={kind === "fusion" || kind === "xyz" ? 1 : 0} speed={big ? 2.2 : 1.4} />
      {big && <Glyph kind={kind} color={s.accent} dur={s.dur} />}
      {s.title && <Title text={s.title} color={s.color} dur={s.dur} />}
    </group>
  );
}

export function ActivateFx({ at, link }: { at: THREE.Vector3; link: number }) {
  return (
    <group position={at}>
      <Ring color="#7affd4" dur={0.9} to={1.6} width={0.15} y={0.9} />
      <Burst color="#7affd4" n={40} dur={0.9} rise={1.2} speed={1} />
      <Title text={`CHAIN ${link}`} color="#ffe08a" dur={0.95} />
    </group>
  );
}

export function AttackFx({ from, to }: { from: THREE.Vector3; to: THREE.Vector3 }) {
  const line = useRef<THREE.Mesh>(null);
  const age = useAge();
  const { mid, len, quat } = useMemo(() => {
    const d = to.clone().sub(from);
    return {
      mid: from.clone().add(to).multiplyScalar(0.5).setY(0.6),
      len: d.length(),
      quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().setY(0).normalize()),
    };
  }, [from, to]);
  useFrame(() => {
    const p = age() / 0.6;
    if (!line.current) return;
    line.current.visible = p > 0.25 && p <= 1;
    (line.current.material as THREE.MeshBasicMaterial).opacity = 1 - p;
  });
  return (
    <>
      <mesh ref={line} position={mid} quaternion={quat}>
        <cylinderGeometry args={[0.05, 0.05, len, 8, 1, true]} />
        <meshBasicMaterial color="#ffd28a" transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      <group position={to}>
        <DelayedImpact />
      </group>
    </>
  );
}

function DelayedImpact() {
  const age = useAge();
  const g = useRef<THREE.Group>(null);
  useFrame(() => { if (g.current) g.current.visible = age() > 0.32; });
  return (
    <group ref={g}>
      <Ring color="#ffb347" dur={0.6} to={2.4} width={0.2} y={0.3} />
      <Burst color="#ffcf7a" n={70} speed={2.5} dur={0.8} rise={1.4} />
    </group>
  );
}

/** Card shatter: instanced shards fly out with gravity and spin. */
export function ShatterFx({ at }: { at: THREE.Vector3 }) {
  const inst = useRef<THREE.InstancedMesh>(null);
  const age = useAge();
  const n = 36;
  const seeds = useMemo(() => Array.from({ length: n }, () => ({
    v: new THREE.Vector3((Math.random() - 0.5) * 4, 1.5 + Math.random() * 3, (Math.random() - 0.5) * 4),
    o: new THREE.Vector3((Math.random() - 0.5) * 0.8, 0, (Math.random() - 0.5) * 1.1),
    r: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10),
  })), []);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0.12, 0, 0.1, -0.08, 0, -0.1, -0.06, 0], 3));
    g.computeVertexNormals();
    return g;
  }, []);
  const m = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const t = age();
    if (!inst.current) return;
    inst.current.visible = t < 1.1;
    seeds.forEach((s, i) => {
      m.position.set(s.o.x + s.v.x * t, 0.1 + s.v.y * t - 4.5 * t * t, s.o.z + s.v.z * t);
      m.rotation.set(s.r.x * t, s.r.y * t, s.r.z * t);
      m.scale.setScalar(Math.max(0, 1 - t * 0.8));
      m.updateMatrix();
      inst.current!.setMatrixAt(i, m.matrix);
    });
    inst.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <group position={at}>
      <instancedMesh ref={inst} args={[geo, undefined, n]}>
        <meshStandardMaterial color="#cfe6ff" emissive="#5d8bff" emissiveIntensity={1.5} side={THREE.DoubleSide} metalness={0.6} roughness={0.2} />
      </instancedMesh>
      <Burst color="#9fc4ff" n={30} speed={1.6} dur={0.7} />
    </group>
  );
}
