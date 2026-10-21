import type { Provider } from "./types.js";

export type ProviderKey = Provider;

export interface ProviderInfo {
  provider: ProviderKey;
  host?: "Fireworks";
}

export interface ProviderParts {
  id: string;
  label: string;
  model: string;
}

/** Resolve a stable provider key from the complete player identity. */
export function providerInfo({ id, label, model }: ProviderParts): ProviderInfo {
  const haystack = `${id} ${label} ${model}`.toLowerCase();
  const host = haystack.includes("fireworks") ? "Fireworks" as const : undefined;

  if (/(?:grok|xai|x\.ai)/.test(haystack)) return { provider: "xai", ...(host ? { host } : {}) };
  if (/deepseek/.test(haystack)) return { provider: "deepseek", ...(host ? { host } : {}) };
  if (/(?:glm|z\.ai|zai|zhipu)/.test(haystack)) return { provider: "zai", ...(host ? { host } : {}) };
  if (/(?:gemini|google|agy|antigravity)/.test(haystack)) return { provider: "google", ...(host ? { host } : {}) };
  if (/(?:claude|anthropic|opus|sonnet|haiku)/.test(haystack)) return { provider: "anthropic", ...(host ? { host } : {}) };
  if (/(?:gpt|openai|codex|\bo[1-9]\b)/.test(haystack)) return { provider: "openai", ...(host ? { host } : {}) };
  return { provider: "unknown", ...(host ? { host } : {}) };
}

const LEGACY_CUSTOM_DECK_NAME = /^Custom deck [0-9a-f]{8,64}$/i;
const MAX_DECK_TITLE_LENGTH = 48;

function shortenDeckTitle(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= MAX_DECK_TITLE_LENGTH) return value;

  const prefix = chars.slice(0, MAX_DECK_TITLE_LENGTH - 1).join("").trimEnd();
  const boundary = prefix.lastIndexOf(" ");
  const shortened = boundary > 0 ? prefix.slice(0, boundary).trimEnd() : prefix;
  return `${shortened}…`;
}

/** Replace legacy generated custom-deck labels with a concise reason-derived title. */
export function deckTitle({ name, reason }: { name: string; reason?: string }): string {
  if (!LEGACY_CUSTOM_DECK_NAME.test(name)) return name;
  const firstClause = (reason ?? "").split(/\. |:|;| — |\r?\n/, 1)[0]?.trim() ?? "";
  return firstClause ? shortenDeckTitle(firstClause) : name;
}

/** Normalize an optional user-supplied deck name before it is persisted. */
export function normalizeDeckName(value: string): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  if (!normalized) throw new Error("Deck name must contain 1–40 visible characters.");
  if (Array.from(normalized).length > 40) throw new Error("Deck name must be 40 characters or fewer; shorten it and retry enter_match.");
  return normalized;
}
