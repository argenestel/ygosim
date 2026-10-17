import type { Player } from "./types.js";

export const ROSTER: Player[] = [
  { id: "codex-sol", label: "Codex 6.1 Sol", cli: "codex", model: "gpt-6.1-sol", effort: "medium", codeMode: true },
  { id: "codex-luna-max", label: "Codex 6 Luna Max", cli: "codex", model: "gpt-6-luna", effort: "max", codeMode: true },
  { id: "pi-grok-46", label: "Grok 4.6", cli: "pi", model: "xai/grok-4.6", effort: "high" },
  { id: "pi-grok-47", label: "Grok 4.7", cli: "pi", model: "xai/grok-4.7", effort: "high" },
  { id: "pi-deepseek-flash", label: "DeepSeek Flash v4.1", cli: "pi", model: "fireworks/accounts/fireworks/models/deepseek-v4p1-flash", effort: "high" },
  { id: "pi-glm-flash", label: "GLM 5.3 Flash", cli: "pi", model: "fireworks/accounts/fireworks/models/glm-5p3-flash", effort: "high" },
  { id: "claude-opus", label: "Claude Opus 5.5", cli: "claude", model: "claude-opus-5-5", effort: "default" },
];

const OPTIONAL_PLAYERS: Player[] = [
  { id: "pi-luna-max", label: "Pi GPT-6 Luna Max", cli: "pi", model: "openai-codex/gpt-6-luna", effort: "max" },
  { id: "pi-grok-46-xhigh", label: "Pi Grok 4.6 XHigh", cli: "pi", model: "xai/grok-4.6", effort: "xhigh" },
  { id: "agy-gemini-flash", label: "Antigravity Gemini 3.8 Flash", cli: "agy", model: "gemini-3.8-flash-high", effort: "high" },
];

export function getRosterPlayer(id: string): Player | undefined {
  return ROSTER.find(p => p.id === id) ?? OPTIONAL_PLAYERS.find(p => p.id === id);
}
