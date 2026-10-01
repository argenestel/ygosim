import type { AiLevel, Bot } from "./bot.js";
import { EasyBot } from "./easy.js";
import { NormalBot } from "./normal.js";
import { HardBot } from "./hard.js";
export * from "./bot.js";
export { EasyBot, NormalBot, HardBot };

export function createBot(level: AiLevel = "normal"): Bot {
  return level === "easy" ? new EasyBot() : level === "hard" ? new HardBot() : new NormalBot();
}
