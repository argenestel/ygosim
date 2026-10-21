import { describe, expect, it } from "vitest";
import { deckTitle, normalizeDeckName, providerInfo } from "../src/providers.js";

describe("providerInfo", () => {
  it("uses the requested provider precedence across player identity fields", () => {
    expect(providerInfo({ id: "codex", label: "Claude Opus", model: "gpt-5" }).provider).toBe("anthropic");
    expect(providerInfo({ id: "pi-grok-46", label: "fixture", model: "xai/grok" })).toEqual({ provider: "xai" });
    expect(providerInfo({ id: "fixture", label: "DeepSeek", model: "glm-4" }).provider).toBe("deepseek");
    expect(providerInfo({ id: "fixture", label: "Zhipu", model: "glm-4" }).provider).toBe("zai");
    expect(providerInfo({ id: "agy", label: "fixture", model: "model" }).provider).toBe("google");
    expect(providerInfo({ id: "fixture", label: "fixture", model: "o3-mini" }).provider).toBe("openai");
    expect(providerInfo({ id: "fixture", label: "fixture", model: "local-model" }).provider).toBe("unknown");
  });

  it("identifies an inference host independently of the provider", () => {
    expect(providerInfo({ id: "grok-fireworks", label: "fixture", model: "xai/grok" })).toEqual({ provider: "xai", host: "Fireworks" });
  });
});

describe("deckTitle", () => {
  it("preserves real names and derives legacy custom titles from the first reason clause", () => {
    expect(deckTitle({ name: "Blue-Eyes Control", reason: "Anything: else" })).toBe("Blue-Eyes Control");
    expect(deckTitle({ name: "Custom deck deadbeef1234", reason: "Branded control: fusion pressure" })).toBe("Branded control");
    expect(deckTitle({ name: "Custom deck deadbeef1234", reason: "Labrynth traps\nplus removal" })).toBe("Labrynth traps");
  });

  it("falls back to the stored legacy name when no reason is available and bounds long clauses", () => {
    const name = "Custom deck deadbeef1234";
    expect(deckTitle({ name, reason: "" })).toBe(name);
    const title = deckTitle({ name, reason: "This is a deliberately long strategic description that should be shortened at a word boundary." });
    expect(title.endsWith("…")).toBe(true);
    expect(Array.from(title).length).toBeLessThanOrEqual(48);
    expect(title).not.toMatch(/strategi…$/);
  });
});

describe("normalizeDeckName", () => {
  it("strips controls and trims supplied names", () => {
    expect(normalizeDeckName("\n\t  Sky\u0000 Striker  \r")).toBe("Sky Striker");
  });

  it("rejects empty and overlong names with actionable errors", () => {
    expect(() => normalizeDeckName("\u0000\n")).toThrow("1–40");
    expect(() => normalizeDeckName("x".repeat(41))).toThrow("shorten it and retry enter_match");
  });
});
