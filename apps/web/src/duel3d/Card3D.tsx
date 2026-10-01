import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { easing } from "maath";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { CardRef } from "@ygosim/protocol";
import { backTexture, glowTexture, loadFront, placeholderTexture, readyFront } from "./textures";
import { CW, CH, HAND_TILT, type Target } from "./space";

export interface Motion {
  /** World-space point the card lunges toward (attack), with start time. */
  lunge?: { to: THREE.Vector3; t0: number };
  /** Card lifts and faces the camera (activation). */
  lift?: { t0: number };
}

interface Props {
  card: CardRef;
  target: Target;
  visible: boolean;
  mine: boolean;
  selectable: boolean;
  selected: boolean;
  motion?: Motion;
  onClick: (c: CardRef) => void;
  onHover: (c: CardRef | null) => void;
}

const edgeMat = new THREE.MeshStandardMaterial({ color: "#1a1208", roughness: 0.6 });
const geo = new THREE.BoxGeometry(CW, CH, 0.012);
const glowGeo = new THREE.PlaneGeometry(CW * 1.5, CH * 1.4);
const tmp = new THREE.Vector3();
const tmpE = new THREE.Euler(0, 0, 0, "YXZ");

export const Card3D = memo(function Card3D({ card, target, visible, mine, selectable, selected, motion, onClick, onHover }: Props) {
  const group = useRef<THREE.Group>(null);
  const glow = useRef<THREE.Mesh>(null);
  const [hover, setHover] = useState(false);
  const placed = useRef(false);

  const faceDown = card.code === undefined || card.position === "facedown" || card.position === "facedown_def";
  const sideways = card.position === "def" || card.position === "facedown_def";
  const inHand = card.location === "hand";

  const [front, setFront] = useState<THREE.Texture>(() => (card.code !== undefined ? readyFront(card.code) ?? placeholderTexture() : backTexture()));
  useEffect(() => {
    if (card.code === undefined) { setFront(backTexture()); return; }
    let alive = true;
    loadFront(card.code).then((t) => alive && setFront(t)).catch(() => {});
    return () => { alive = false; };
  }, [card.code]);

  const mats = useMemo(() => {
    return [edgeMat, edgeMat, edgeMat, edgeMat,
      new THREE.MeshStandardMaterial({ map: front, roughness: 0.45, metalness: 0.05 }),
      new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.5 })];
  }, [front]);

  useFrame((state, dt) => {
    const g = group.current;
    if (!g) return;
    const now = state.clock.elapsedTime;
    tmp.set(target.x, target.y, target.z);
    let pitch = faceDown && !inHand ? Math.PI / 2 : -Math.PI / 2;
    let yaw = target.yaw + (sideways ? Math.PI / 2 : 0);
    let roll = target.roll;
    if (inHand && mine) {
      pitch = -Math.PI / 2 + HAND_TILT;
      if (hover) { tmp.y += 0.45; tmp.z -= 0.25; }
    }
    if (motion?.lunge) {
      const p = (now - motion.lunge.t0) / 0.55;
      if (p >= 0 && p < 1) {
        const k = Math.sin(Math.PI * Math.min(1, p)) ;
        tmp.lerp(motion.lunge.to, k * 0.72);
        tmp.y += k * 0.5;
      }
    }
    if (motion?.lift) {
      const p = (now - motion.lift.t0) / 0.95;
      if (p >= 0 && p < 1) {
        const k = Math.sin(Math.PI * p);
        tmp.y += k * 0.9;
        pitch += k * 0.9;
        yaw = target.yaw;
      }
    }
    if (!placed.current) {
      g.position.copy(tmp);
      g.rotation.set(pitch, yaw, roll, "YXZ");
      placed.current = true;
    } else {
      // Arc: cards lift while travelling far, giving a natural "fly" motion.
      const dist = Math.hypot(g.position.x - tmp.x, g.position.z - tmp.z);
      tmp.y += Math.min(dist * 0.28, 1.3);
      easing.damp3(g.position, tmp, 0.16, dt);
      tmpE.set(pitch, yaw, roll, "YXZ");
      easing.dampE(g.rotation, tmpE, 0.14, dt);
    }
    if (glow.current) {
      const m = glow.current.material as THREE.MeshBasicMaterial;
      m.opacity = selected ? 0.95 : selectable ? 0.45 + 0.35 * Math.sin(now * 5) : 0;
      m.color.set(selected ? "#5dffb0" : "#ffcc55");
      glow.current.visible = selectable || selected;
    }
  });

  const over = (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHover(true); onHover(card); document.body.style.cursor = selectable ? "pointer" : "default"; };
  const out = () => { setHover(false); onHover(null); document.body.style.cursor = "default"; };

  return (
    <group ref={group} visible={visible}>
      <mesh ref={glow} geometry={glowGeo} position={[0, 0, -0.01]} renderOrder={-1}>
        <meshBasicMaterial map={glowTexture()} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      <mesh geometry={geo} material={mats} castShadow receiveShadow
        onClick={(e) => { e.stopPropagation(); onClick(card); }} onPointerOver={over} onPointerOut={out} />
      {card.overlays && card.overlays.length > 0 && card.overlays.map((o, i) => (
        <mesh key={o.uid} position={[-CW / 2 + 0.1 + i * 0.16, CH / 2 + 0.08, 0.02]}>
          <circleGeometry args={[0.06, 16]} /><meshBasicMaterial color="#d6a8ff" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
});
