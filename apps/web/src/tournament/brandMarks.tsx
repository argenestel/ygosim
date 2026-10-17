import type { CSSProperties } from "react";

/** Local provider marks vendored under apps/web/public/brands. */
export type BrandKey = "xai" | "openai" | "deepseek" | "google" | "zai" | "anthropic" | "unknown";

export interface BrandInfo {
  key: BrandKey;
  name: string;
  host?: "Fireworks";
}

const BRANDS: Record<BrandKey, Omit<BrandInfo, "key">> = {
  xai: { name: "xAI" },
  openai: { name: "OpenAI" },
  deepseek: { name: "DeepSeek" },
  google: { name: "Google" },
  zai: { name: "Z.ai" },
  anthropic: { name: "Anthropic" },
  unknown: { name: "Provider" },
};

export function brandInfo(key: BrandKey, host?: BrandInfo["host"]): BrandInfo {
  return { key, ...BRANDS[key], ...(host ? { host } : {}) };
}

/** Resolve a provider from an API player without relying on a hard-coded id. */
export function identifyBrand(parts: Array<string | undefined>): BrandInfo {
  const haystack = parts.filter(Boolean).join(" ").toLowerCase();
  const host = haystack.includes("fireworks") ? "Fireworks" as const : undefined;
  if (/(?:grok|xai|x\.ai)/.test(haystack)) return brandInfo("xai", host);
  if (/(?:deepseek)/.test(haystack)) return brandInfo("deepseek", host);
  if (/(?:gemini|antigravity|google)/.test(haystack)) return brandInfo("google", host);
  if (/(?:glm|z\.ai|zai)/.test(haystack)) return brandInfo("zai", host);
  if (/(?:claude|anthropic)/.test(haystack)) return brandInfo("anthropic", host);
  if (/(?:codex|openai|gpt|luna)/.test(haystack)) return brandInfo("openai", host);
  return brandInfo("unknown", host);
}

const LOCAL_ASSET: Partial<Record<BrandKey, string>> = {
  xai: "/brands/xai.svg",
  openai: "/brands/openai.svg",
  deepseek: "/brands/deepseek.svg",
  google: "/brands/google.svg",
  zai: "/brands/zai.svg",
  anthropic: "/brands/anthropic.svg",
};

/** Render a local provider SVG and keep a neutral text fallback for unknown providers. */
export function BrandMark({ brand, size = "md", className = "" }: { brand: BrandInfo | BrandKey; size?: "sm" | "md" | "lg"; className?: string }) {
  const info = typeof brand === "string" ? brandInfo(brand) : brand;
  const style = { ["--brand-tone" as string]: `var(--brand-${info.key})` } as CSSProperties;
  const asset = LOCAL_ASSET[info.key];
  return (
    <span className={`t-brand-mark t-brand-${info.key} t-brand-${size} ${className}`.trim()} style={style} aria-label={info.name} title={info.name}>
      {asset ? <img src={asset} alt="" aria-hidden="true" /> : <span className="t-brand-fallback" aria-hidden="true">?</span>}
      <span>{info.name}</span>
    </span>
  );
}

export function HostMark({ label = "Fireworks" }: { label?: string }) {
  return <span className="t-host-mark" title="Inference host"><img src="/brands/fireworks.svg" alt="" aria-hidden="true" />{label}</span>;
}
