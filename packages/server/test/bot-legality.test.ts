import { describe, it, expect } from "vitest";
import type { DuelState, Prompt } from "@ygosim/protocol";
import { createBot } from "../src/ai/index.js";
import { isLegal, bounds } from "../src/ai/bot.js";

const mockState: DuelState = {
  duelId: "test",
  turn: 1,
  turnPlayer: 0,
  phase: "main1",
  lp: [8000, 8000],
  cards: [],
  chain: [],
  you: 0,
};

describe("Bot Legality", () => {
  it("should generate legal actions for idle prompts", async () => {
    const bot = createBot("easy");
    const prompt: Prompt = {
      promptId: "p1",
      kind: "idle",
      text: "Choose action",
      min: 1,
      max: 1,
      options: [
        { id: "summon", label: "Summon" },
        { id: "activate", label: "Activate" },
        { id: "end", label: "End Turn" },
      ],
    };

    const action = await bot.choose(mockState, prompt);
    expect(isLegal(prompt, action)).toBe(true);
    expect(action.promptId).toBe("p1");
    expect(action.choose.length).toBeGreaterThanOrEqual(1);
    expect(action.choose.length).toBeLessThanOrEqual(1);
  });

  it("should generate legal actions for yes/no prompts", async () => {
    const bot = createBot("normal");
    const prompt: Prompt = {
      promptId: "p2",
      kind: "select_yesno",
      text: "Activate effect?",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    };

    const action = await bot.choose(mockState, prompt);
    expect(isLegal(prompt, action)).toBe(true);
    expect(["yes", "no"]).toContain(action.choose[0]);
  });

  it("should respect min/max bounds for select_card", async () => {
    const bot = createBot("normal");
    const prompt: Prompt = {
      promptId: "p3",
      kind: "select_card",
      text: "Select 2 cards",
      min: 2,
      max: 2,
      options: [
        { id: "c1", label: "Card 1" },
        { id: "c2", label: "Card 2" },
        { id: "c3", label: "Card 3" },
      ],
    };

    const action = await bot.choose(mockState, prompt);
    expect(isLegal(prompt, action)).toBe(true);
    expect(action.choose.length).toBe(2);
  });

  it("should handle min=0 (optional selection)", async () => {
    const bot = createBot("easy");
    const prompt: Prompt = {
      promptId: "p4",
      kind: "select_chain",
      text: "Activate chain?",
      min: 0,
      max: 1,
      options: [
        { id: "activate", label: "Activate" },
        { id: "pass", label: "Pass" },
      ],
    };

    const action = await bot.choose(mockState, prompt);
    expect(isLegal(prompt, action)).toBe(true);
    expect(action.choose.length).toBeLessThanOrEqual(1);
  });

  it("all AI levels should always return legal actions", async () => {
    const levels: Array<"easy" | "normal" | "hard"> = ["easy", "normal", "hard"];
    const prompts: Prompt[] = [
      {
        promptId: "p1",
        kind: "idle",
        text: "Main phase action",
        min: 1,
        max: 3,
        options: [
          { id: "summon", label: "Summon" },
          { id: "activate", label: "Activate" },
          { id: "end", label: "End Turn" },
        ],
      },
      {
        promptId: "p2",
        kind: "select_yesno",
        text: "Yes or No?",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
      {
        promptId: "p3",
        kind: "battle_idle",
        text: "Battle phase",
        min: 0,
        max: 2,
        options: [
          { id: "attack1", label: "Attack with Monster 1" },
          { id: "attack2", label: "Attack with Monster 2" },
          { id: "end", label: "End Phase" },
        ],
      },
    ];

    for (const level of levels) {
      const bot = createBot(level);
      for (const prompt of prompts) {
        const action = await bot.choose(mockState, prompt);
        expect(isLegal(prompt, action)).toBe(true);
        expect(action.promptId).toBe(prompt.promptId);
      }
    }
  });

  it("should validate bounds function", () => {
    const prompt1: Prompt = {
      promptId: "p1",
      kind: "idle",
      text: "test",
      min: 2,
      max: 4,
      options: Array(5).fill(0).map((_, i) => ({ id: `o${i}`, label: `Option ${i}` })),
    };
    const b1 = bounds(prompt1);
    expect(b1.min).toBe(2);
    expect(b1.max).toBe(4);

    const prompt2: Prompt = {
      promptId: "p2",
      kind: "select_yesno",
      text: "test",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    };
    const b2 = bounds(prompt2);
    expect(b2.min).toBe(1);
    expect(b2.max).toBeGreaterThanOrEqual(1);
  });

  it("should reject illegal actions", () => {
    const prompt: Prompt = {
      promptId: "p1",
      kind: "idle",
      text: "test",
      min: 1,
      max: 1,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    };

    expect(isLegal(prompt, { promptId: "p1", choose: ["a"] })).toBe(true);
    expect(isLegal(prompt, { promptId: "p1", choose: [] })).toBe(false); // too few
    expect(isLegal(prompt, { promptId: "p1", choose: ["a", "b"] })).toBe(false); // too many
    expect(isLegal(prompt, { promptId: "p1", choose: ["c"] })).toBe(false); // invalid option
    expect(isLegal(prompt, { promptId: "p2", choose: ["a"] })).toBe(false); // wrong prompt ID
  });
});
