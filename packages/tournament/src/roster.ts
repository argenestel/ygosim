import type { Player } from "./types.js";

export const ROSTER: Player[] = [
  { id: "codex-sol", label: "Codex 6.1 Sol", cli: "codex", model: "gpt-6.1-sol", effort: "medium" },
  { id: "codex-luna-max", label: "Codex 6 Luna Max", cli: "codex", model: "gpt-6-luna", effort: "max" },
  { id: "pi-grok-46", label: "Grok 4.6", cli: "pi", model: "xai/grok-4.6", effort: "high" },
  { id: "pi-grok-47", label: "Grok 4.7", cli: "pi", model: "xai/grok-4.7", effort: "high" },
  { id: "pi-deepseek-flash", label: "DeepSeek Flash v4.1", cli: "pi", model: "fireworks/accounts/fireworks/models/deepseek-v4p1-flash", effort: "high" },
  { id: "pi-glm-flash", label: "GLM 5.3 Flash", cli: "pi", model: "fireworks/accounts/fireworks/models/glm-5p3-flash", effort: "high" },
  { id: "claude-opus", label: "Claude Opus 5.5", cli: "claude", model: "claude-opus-5-5", effort: "default" },
];

const PI_LUNA_MAX: Player = { id: "pi-luna-max", label: "Pi GPT-6-Luna Max", cli: "pi", model: "openai-codex/gpt-6-luna", effort: "max" };

export function getRosterPlayer(id: string): Player | undefined {
  return ROSTER.find(p => p.id === id) ?? (id === PI_LUNA_MAX.id ? PI_LUNA_MAX : undefined);
}
