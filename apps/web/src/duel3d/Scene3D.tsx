import { Billboard, Line, Text } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import type { CardRef, DuelState, PlayerIdx } from "@ygosim/protocol";
import { CARD_H, CARD_W, isPile } from "../duel/layout";
import { Arena, ArenaLights } from "./Arena";
import type { Fx } from "../duel/useDuel";
import { Card3D, type Motion } from "./Card3D";
import { ActivateFx, AttackFx, ShatterFx, SummonFx } from "./Fx3D";
import { S, slotWorld, worldTargets } from "./space";

/** A zone the player may pick during select_place, already mapped to the board. */
export interface PlaceTarget { id: string; x: number; z: number; label: string; picked: boolean; }

interface Props {
  /** The viewer's hand is drawn as a 2D HandBar overlay instead. */
  hideOwnHand?: boolean;
  places?: PlaceTarget[];
  onPlace?: (id: string) => void;
  state: DuelState;
  fx: Fx[];
  selectable: Set<string>;
  selected: Set<string>;
  onCard: (c: CardRef, at?: { x: number; y: number }) => void;
  onPile: (owner: PlayerIdx, loc: CardRef["location"]) => void;
  onHover: (c: CardRef | null) => void;
  shake: number;
}

// Steep, Master Duel-like overhead view: the opponent at the far end, you at the near end.
const BASE_CAM = new THREE.Vector3(0, 14.2, 6.3);
const LOOK = new THREE.Vector3(0, 0, 0.45);
const LOW_GRAPHICS = import.meta.env.DEV && import.meta.env.VITE_E2E_LOW_GRAPHICS === "1";
const REDUCED_MOTION = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Static camera. Only a short, small shake on big impacts (none with reduced motion). */
function CameraRig({ shake }: { shake: number }) {
  const { camera, size } = useThree();
  const kick = useRef({ id: 0, t: 0 });
  useFrame((_, dt) => {
    if (shake !== kick.current.id) kick.current = { id: shake, t: REDUCED_MOTION ? 0 : 0.22 };
    kick.current.t = Math.max(0, kick.current.t - dt);
    // Back off on narrow/tall screens so the whole arena stays in frame.
    const k = THREE.MathUtils.clamp(1.62 / (size.width / size.height), 1, 1.8);
    const a = kick.current.t * 0.18;
    camera.position.set(BASE_CAM.x + (Math.random() - 0.5) * a, BASE_CAM.y * k, BASE_CAM.z * k + (Math.random() - 0.5) * a);
    camera.lookAt(LOOK);
  });
  return null;
}

const pileEdge = new THREE.EdgesGeometry(new THREE.PlaneGeometry(CARD_W * S * 1.12, CARD_H * S * 1.1));

function PileHits({ state, onPile, glowing }: { state: DuelState; onPile: Props["onPile"]; glowing: Set<string> }) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of state.cards) if (isPile(c.location)) m.set(`${c.controller}:${c.location}`, (m.get(`${c.controller}:${c.location}`) ?? 0) + 1);
    return m;
  }, [state.cards]);
  return (
    <>
      {(["deck", "extra", "grave", "banished"] as const).flatMap((loc) => [0, 1].map((p) => {
        const mine = p === state.you;
        const s = slotWorld(loc, 0, mine);
        const k = `${p}:${loc}`;
        const n = counts.get(k) ?? 0;
        return (
          <group key={k} position={[s.x, 0, s.z]}>
            <mesh position={[0, 0.5, 0]} onClick={(e) => { e.stopPropagation(); onPile(p as PlayerIdx, loc); }}
              onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "default")}>
              <boxGeometry args={[CARD_W * S, 1, CARD_H * S]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
            {glowing.has(k) && (
              <lineSegments rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} geometry={pileEdge}>
                <lineBasicMaterial color="#f2d792" toneMapped={false} />
              </lineSegments>
            )}
            {n > 0 && (
              <group position={[0, 0.03, (mine ? 1 : -1) * (CARD_H * S / 2 + 0.17)]} rotation={[-Math.PI / 2, 0, 0]}>
                <mesh><planeGeometry args={[0.46, 0.24]} /><meshBasicMaterial color="#0a0d12" transparent opacity={0.88} /></mesh>
                <Text position={[0, 0, 0.002]} fontSize={0.17} color="#e9edf4" anchorX="center" anchorY="middle">{String(n)}</Text>
              </group>
            )}
          </group>
        );
      }))}
    </>
  );
}

function StatPlates({ state, targets }: { state: DuelState; targets: Map<string, { x: number; z: number }> }) {
  return (
    <>
      {state.cards.filter((c) => (c.location === "mzone" || c.location === "emzone") && c.code !== undefined && c.atk !== undefined && c.position !== "facedown_def").map((c) => {
        const t = targets.get(c.uid);
        if (!t) return null;
        return (
          // Sits on the card's own lower text box (never over the artwork, never into the next row).
          <group key={c.uid} position={[t.x, 0.06, t.z + (c.controller === state.you ? 1 : -1) * (CARD_H * S / 2 - 0.17)]} rotation={[-Math.PI / 2, 0, 0]}>
            <mesh><planeGeometry args={[1.02, 0.24]} /><meshBasicMaterial color="#0a0d12" transparent opacity={0.9} /></mesh>
            <Text position={[-0.04, 0, 0.002]} fontSize={0.16} anchorX="right" anchorY="middle" color={c.position === "atk" ? "#ffffff" : "#7d8799"}>{String(c.atk)}</Text>
            <Text position={[0, 0, 0.002]} fontSize={0.13} anchorX="center" anchorY="middle" color="#5a6377">/</Text>
            <Text position={[0.04, 0, 0.002]} fontSize={0.16} anchorX="left" anchorY="middle" color={c.position === "atk" ? "#7d8799" : "#ffffff"}>{c.def === undefined ? "—" : String(c.def)}</Text>
          </group>
        );
      })}
    </>
  );
}

/** Floating chain numbers over each chained card, linked in chain order. */
function ChainMarks({ state, targets }: { state: DuelState; targets: Map<string, { x: number; z: number }> }) {
  const line = useRef<{ material: { dashOffset: number } } | null>(null);
  useFrame((_, dt) => { if (line.current) line.current.material.dashOffset -= dt * 0.8; });
  // Cards activated from the hand are shown in the chain panel; only on-board links get 3D marks.
  const marks = state.chain.map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => l.card.location !== "hand").map(({ l, n }) => {
    const t = targets.get(l.card.uid) ?? (() => { const s = slotWorld(l.card.location, l.card.sequence, l.card.controller === state.you); return { x: s.x, z: s.z }; })();
    return { n, p: new THREE.Vector3(t.x, 1.25, t.z) };
  });
  const pts = marks.map((m) => m.p);
  if (!pts.length) return null;
  return (
    <group>
      {pts.length > 1 && (
        <Line ref={line as never} points={pts} color="#d6b15e" lineWidth={2.5} dashed dashSize={0.25} gapSize={0.12} transparent opacity={0.9} toneMapped={false} />
      )}
      {marks.map(({ p, n }) => (
        <Billboard key={n} position={p}>
          <mesh><circleGeometry args={[0.24, 32]} /><meshBasicMaterial color="#1b1405" transparent opacity={0.92} /></mesh>
          <mesh position={[0, 0, 0.001]}><ringGeometry args={[0.22, 0.26, 32]} /><meshBasicMaterial color="#f2d792" toneMapped={false} /></mesh>
          <Text position={[0, 0, 0.002]} fontSize={0.26} color="#f2d792" anchorX="center" anchorY="middle" fontWeight={700}>{String(n)}</Text>
        </Billboard>
      ))}
    </group>
  );
}

/** Glowing, clickable zone tiles for select_place prompts (Master Duel style). */
function PlaceTiles({ places, onPlace }: { places: PlaceTarget[]; onPlace: (id: string) => void }) {
  const mats = useRef<THREE.MeshBasicMaterial[]>([]);
  useFrame((st) => { const k = 0.35 + 0.25 * Math.sin(st.clock.elapsedTime * 5); mats.current.forEach((m) => m && (m.opacity = k)); });
  return (
    <>
      {places.map((p, i) => (
        <group key={p.id} position={[p.x, 0.03, p.z]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}
            onClick={(e) => { e.stopPropagation(); onPlace(p.id); }}
            onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "default")}>
            <planeGeometry args={[CARD_W * S * 1.06, CARD_H * S * 1.04]} />
            <meshBasicMaterial ref={(m) => { if (m) mats.current[i] = m; }} color={p.picked ? "#5cc8f2" : "#d6b15e"} transparent opacity={0.5} depthWrite={false} toneMapped={false} />
          </mesh>
          <Line points={[[-0.46, 0.01, -0.66], [0.46, 0.01, -0.66], [0.46, 0.01, 0.66], [-0.46, 0.01, 0.66], [-0.46, 0.01, -0.66]]} color={p.picked ? "#5cc8f2" : "#f2d792"} lineWidth={2.5} toneMapped={false} />
        </group>
      ))}
    </>
  );
}

function Scene({ state, fx, selectable, selected, onCard, onPile, onHover, shake, places, onPlace, hideOwnHand }: Props) {
  const targets = useMemo(() => worldTargets(state.cards, state.you), [state.cards, state.you]);
  const clock = useThree((s) => s.clock);
  useFrame(({ camera, gl }) => {
    if (!import.meta.env.DEV) return;
    const bounds = gl.domElement.getBoundingClientRect();
    const project = (x: number, y: number, z: number) => {
      const p = new THREE.Vector3(x, y, z).project(camera);
      return { x: bounds.left + (p.x + 1) * bounds.width / 2, y: bounds.top + (1 - p.y) * bounds.height / 2 };
    };
    (window as unknown as { __ygosimBoard?: unknown }).__ygosimBoard = {
      lowGraphics: LOW_GRAPHICS,
      cards: Object.fromEntries([...targets].map(([uid, t]) => [uid, project(t.x, t.y, t.z)])),
      places: Object.fromEntries((places ?? []).map(p => [p.id, project(p.x, 0.03, p.z)])),
    };
  });

  const visible = useMemo(() => {
    const byPile = new Map<string, CardRef[]>();
    for (const c of state.cards) if (isPile(c.location)) {
      const k = `${c.controller}:${c.location}`;
      (byPile.get(k) ?? byPile.set(k, []).get(k)!).push(c);
    }
    const hidden = new Set<string>();
    for (const list of byPile.values()) list.sort((a, b) => b.sequence - a.sequence).slice(5).forEach((c) => hidden.add(c.uid));
    return hidden;
  }, [state.cards]);

  const glowing = useMemo(() => {
    const s = new Set<string>();
    for (const c of state.cards) if (selectable.has(c.uid) && isPile(c.location)) s.add(`${c.controller}:${c.location}`);
    return s;
  }, [state.cards, selectable]);

  // Cards targeted by the current chain get a red outline.
  const targeted = useMemo(() => new Set(state.chain.flatMap((l) => (l.targets ?? []).map((t) => t.uid))), [state.chain]);

  const vec = (uid?: string) => { const t = uid ? targets.get(uid) : undefined; return t ? new THREE.Vector3(t.x, 0.05, t.z) : undefined; };

  // Per-card motion overrides driven by the current FX queue.
  const motions = useMemo(() => {
    const m = new Map<string, Motion>();
    const now = clock.elapsedTime;
    for (const f of fx) {
      const e = f.ev;
      if (e.t === "attack") {
        const to = e.target ? vec(e.target.uid) : (() => { const s = slotWorld("hand", 0, e.attacker.controller !== state.you); return new THREE.Vector3(s.x, 0.05, s.z * 0.7); })();
        if (to) m.set(e.attacker.uid, { ...m.get(e.attacker.uid), lunge: { to, t0: now } });
      } else if (e.t === "activate") {
        m.set(e.card.uid, { ...m.get(e.card.uid), lift: { t0: now } });
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fx.map((f) => f.id).join(",")]);

  return (
    <>
      <CameraRig shake={shake} />
      <color attach="background" args={["#07090d"]} />
      <fog attach="fog" args={["#07090d", 16, 30]} />
      <ArenaLights shadows={!LOW_GRAPHICS} />
      <Arena />
      <PileHits state={state} onPile={onPile} glowing={glowing} />
      <StatPlates state={state} targets={targets} />
      <ChainMarks state={state} targets={targets} />
      {places && places.length > 0 && onPlace && <PlaceTiles places={places} onPlace={onPlace} />}
      {state.cards.map((c) => {
        const t = targets.get(c.uid);
        if (!t) return null;
        return (
          <Card3D key={c.uid} card={c} target={t} visible={!visible.has(c.uid) && !(hideOwnHand && c.location === "hand" && c.controller === state.you)} mine={c.controller === state.you}
            selectable={selectable.has(c.uid) && !isPile(c.location)} selected={selected.has(c.uid)} targeted={targeted.has(c.uid)} motion={motions.get(c.uid)}
            onClick={(card, at) => (isPile(card.location) ? onPile(card.controller, card.location) : onCard(card, at))} onHover={onHover} />
        );
      })}
      {fx.map((f) => {
        const e = f.ev;
        if (e.t === "summon") { const at = vec(e.card.uid); return at ? <SummonFx key={f.id} kind={e.kind} at={at} /> : null; }
        if (e.t === "activate") { const at = vec(e.card.uid); return at ? <ActivateFx key={f.id} at={at} link={e.chainLink} /> : null; }
        if (e.t === "attack") {
          const from = vec(e.attacker.uid);
          const to = e.target ? vec(e.target.uid) : (() => { const s = slotWorld("hand", 0, e.attacker.controller !== state.you); return new THREE.Vector3(s.x, 0.05, s.z * 0.7); })();
          return from && to ? <AttackFx key={f.id} from={from} to={to} /> : null;
        }
        if (e.t === "move" && e.reason === "destroy" && e.from.location) {
          const s = slotWorld(e.from.location, e.from.sequence ?? 0, e.card.controller === state.you);
          return <ShatterFx key={f.id} at={new THREE.Vector3(s.x, 0.05, s.z)} />;
        }
        return null;
      })}
      {!LOW_GRAPHICS && <EffectComposer>
        {/* Only bright gameplay FX cross this threshold; the arena itself never blooms. */}
        <Bloom luminanceThreshold={0.92} luminanceSmoothing={0.1} intensity={0.6} mipmapBlur />
      </EffectComposer>}
    </>
  );
}

export function Board3D(props: Props) {
  return (
    <div className="board3d">
      <Canvas shadows={!LOW_GRAPHICS} dpr={[1, 2]} camera={{ fov: 36, position: BASE_CAM.toArray(), near: 0.1, far: 60 }} gl={{ antialias: true, powerPreference: "high-performance" }}
        onPointerMissed={() => props.onHover(null)}>
        <Suspense fallback={null}><Scene {...props} /></Suspense>
      </Canvas>
    </div>
  );
}
