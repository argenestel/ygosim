/** Per-viewer graphics quality: "low" renders at 1x pixel density without shadows. */
export type Graphics = "high" | "low";
export function getGraphics(): Graphics {
  try { return localStorage.getItem("ygosim.graphics") === "low" ? "low" : "high"; } catch { return "high"; }
}
export function setGraphics(g: Graphics) { try { localStorage.setItem("ygosim.graphics", g); } catch { /* storage unavailable */ } }
