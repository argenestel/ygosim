import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { easing } from "maath";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { CardRef } from "@ygosim/protocol";
import { backTexture, loadFront, placeholderTexture, readyFront } from "./textures";
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
  /** Targeted by a card in the current chain. */
  targeted?: boolean;
  motion?: Motion;
  onClick: (c: CardRef, at: { x: number; y: number }) => void;
  onHover: (c: CardRef | null) => void;
}

const edgeMat = new THREE.MeshStandardMaterial({ color: "#1a1208", roughness: 0.6 });
const geo = new THREE.BoxGeometry(CW, CH, 0.012);
// State outline: a crisp rule just outside the card edge (no additive glow, no pulsing).
const outlineGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(CW * 1.1, CH * 1.08));
const OUTLINE = { playable: "#f2d792", selected: "#5cc8f2", targeted: "#ff5a52" };
const tmp = new THREE.Vector3();
const tmpE = new THREE.Euler(0, 0, 0, "YXZ");

export const Card3D = memo(function Card3D({ card, target, visible, mine, selectable, selected, targeted, motion, onClick, onHover }: Props) {
  const group = useRef<THREE.Group>(null);
  const [hover, setHover] = useState(false);
  const placed = useRef(false);

  // Battle position only means something on the field; engines report raw positions for hand/deck too.
  const onBoard = card.location === "mzone" || card.location === "szone" || card.location === "emzone" || card.location === "fzone" || card.location === "pzone";
  const faceDown = card.code === undefined || (onBoard && (card.position === "facedown" || card.position === "facedown_def"))
    || ((card.location === "deck" || card.location === "extra") && card.position !== "faceup");
  const sideways = onBoard && (card.position === "def" || card.position === "facedown_def");
  const inHand = card.location === "hand";

  const [front, setFront] = useState<THREE.Texture>(() => (card.code !== undefined ? readyFront(card.code) ?? placeholderTexture() : backTexture()));
  useEffect(() => {
    if (card.code === undefined) { setFront(backTexture()); return; }
    if (!visible || faceDown) return;
    setFront(readyFront(card.code) ?? placeholderTexture());
    let alive = true;
    loadFront(card.code).then((t) => alive && setFront(t)).catch(() => {});
    return () => { alive = false; };
  }, [card.code, visible, faceDown]);

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
    // Playable/selected cards rise slightly off the slab so they read as "live".
    if (!inHand && (selectable || selected)) tmp.y += selected ? 0.09 : 0.05;
    if (hover && !inHand && selectable) tmp.y += 0.05;
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
    // Defense-position cards turn sideways; draw them slightly smaller so they stay inside their zone.
    const scale = sideways ? 0.9 : 1;
    g.scale.setScalar(scale);
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
  });

  const over = (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHover(true); onHover(card); document.body.style.cursor = selectable ? "pointer" : "default"; };
  const out = () => { setHover(false); onHover(null); document.body.style.cursor = "default"; };

  return (
    <group ref={group} visible={visible}>
      {(selectable || selected || targeted) && (
        <lineSegments geometry={outlineGeo}>
          <lineBasicMaterial color={targeted ? OUTLINE.targeted : selected ? OUTLINE.selected : OUTLINE.playable} toneMapped={false} />
        </lineSegments>
      )}
      <mesh geometry={geo} material={mats} castShadow receiveShadow
        onClick={(e) => { e.stopPropagation(); onClick(card, { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY }); }} onPointerOver={over} onPointerOut={out} />
      {card.overlays && card.overlays.length > 0 && card.overlays.map((o, i) => (
        <mesh key={o.uid} position={[-CW / 2 + 0.1 + i * 0.16, CH / 2 + 0.08, 0.02]}>
          <circleGeometry args={[0.06, 16]} /><meshBasicMaterial color="#d6a8ff" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
});
