import { Text } from "@react-three/drei";
import { Suspense, type ComponentProps } from "react";

/** Glyphs used by board labels, pre-generated so new numbers don't trigger a load. */
const GLYPHS = "0123456789/—-+?·ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ";

/**
 * drei <Text> suspends while it generates glyphs for characters it hasn't seen yet.
 * Each label gets its own Suspense boundary so a new label can never blank the
 * whole board (previously the entire scene was one boundary).
 */
export function SafeText(props: ComponentProps<typeof Text>) {
  return (
    <Suspense fallback={null}>
      <Text characters={GLYPHS} {...props} />
    </Suspense>
  );
}
