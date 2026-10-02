import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Deck, Duel, Prompt } from "@ygosim/protocol";
import { createDuel, loadCardDb, listFormats } from "../src/index.js";
import { ChoiceSearchError, deckGenerator, respondRandomly, rng } from "./fuzz-support.js";

interface Config { duels: number; seed: number; decisionCap: number; timeoutMs: number; stallMoves: number }
interface Trace { decision: number; kind: string; choose: string[]; cardCodes: number[] }
interface Progress { decisions: number; decks: [Deck, Deck]; lastActivatedCard?: number; prompt?: Prompt; trace: Trace[] }
interface Run extends Progress { seed: number; outcome: string; message?: string; stack?: string; cardCodes: number[]; scriptCardCodes: number[]; elapsedMs: number }
type WorkerMessage = { type: "ready" } | { type: "progress"; progress: Progress } | { type: "result"; run: Run } | { type: "fatal"; message: string };

const reportPath = fileURLToPath(new URL("../data/reports/fuzz.json", import.meta.url));
const stringifyError = (error: unknown) => error instanceof Error ? error.message : String(error);

async function worker(): Promise<void> {
  const generate = deckGenerator(await loadCardDb());
  process.send?.({ type: "ready" });
  process.on("message", async ({ seed, config }: { seed: number; config: Config }) => {
    const random = rng(seed), decks: [Deck, Deck] = [generate(random), generate(random)];
    const progress: Progress = { decisions: 0, decks, trace: [] };
    const started = performance.now();
    let duel: Duel | undefined;
    let outcome = "completed", message: string | undefined, stack: string | undefined;
    let stage = "initialize";
    const publish = () => process.send?.({ type: "progress", progress });
    publish();
    try {
      duel = await createDuel({ decks, format: "tcg", seed });
      let previous = "", stagnant = 0;
      while (true) {
        stage = "step";
        const result = await duel.step();
        for (const event of result.events) if (event.t === "activate" && event.card.code) progress.lastActivatedCard = event.card.code;
        if (result.ended) break;
        if (!result.pending) throw new Error("Duel returned neither ending nor prompt");
        progress.prompt = result.pending.prompt;
        if (progress.decisions >= config.decisionCap) { outcome = "decision_cap"; message = `Reached ${config.decisionCap} decisions (not proof of a hang)`; break; }
        // Ignore unstable IDs and masked card identities when checking actual progress.
        const states = [duel.stateFor(0), duel.stateFor(1)];
        const fingerprint = JSON.stringify(states.map(state => ({ turn: state.turn, phase: state.phase, lp: state.lp,
          cards: state.cards, chain: state.chain })), (key, value: unknown) => key === "uid" ? undefined : value);
        stagnant = fingerprint === previous ? stagnant + 1 : 0; previous = fingerprint;
        if (stagnant >= config.stallMoves) { outcome = "no_progress"; message = `State unchanged for ${config.stallMoves} decisions`; break; }
        stage = "respond";
        publish(); // A synchronous WASM hang must leave a reproducible pending prompt.
        const choose = respondRandomly(duel, result.pending, random);
        const selected = result.pending.prompt.options.filter(option => choose.includes(option.id));
        const cardCodes = selected.flatMap(option => option.card?.code ? [option.card.code] : []);
        if (selected.some(option => option.id.startsWith("activate:") || result.pending!.prompt.kind === "select_chain" && option.id !== "pass")) {
          progress.lastActivatedCard = cardCodes[0] ?? progress.lastActivatedCard;
        }
        progress.decisions++;
        progress.trace.push({ decision: progress.decisions, kind: result.pending.prompt.kind, choose, cardCodes });
        if (progress.trace.length > 20) progress.trace.shift();
        publish();
      }
    } catch (error) {
      message = stringifyError(error); stack = error instanceof Error ? error.stack : undefined;
      outcome = error instanceof ChoiceSearchError ? "choice_search" : message.includes("ocgcore error:") ? "engine_lua"
        : message.includes("rejected the validated response") ? "response_encoding"
        : message.includes("processing iterations") ? "no_progress" : `${stage}_exception`;
    } finally { duel?.destroy(); }
    const scriptCardCodes = [...new Set([...message?.matchAll(/\bc(\d+)\.lua\b/g) ?? []].map(match => Number(match[1])))];
    const cardCodes = [...new Set([...scriptCardCodes, ...(progress.lastActivatedCard ? [progress.lastActivatedCard] : []), ...(progress.trace.at(-1)?.cardCodes ?? [])])];
    process.send?.({ type: "result", run: { ...progress, seed, outcome, message, stack, cardCodes, scriptCardCodes, elapsedMs: performance.now() - started } });
  });
}

function configFromArgs(args: string[]): Config {
  const config: Config = { duels: 200, seed: 20261002, decisionCap: 500, timeoutMs: 30_000, stallMoves: 50 };
  const names: Record<string, keyof Config> = { "--duels": "duels", "--seed": "seed", "--decision-cap": "decisionCap", "--timeout-ms": "timeoutMs", "--stall-moves": "stallMoves" };
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]], value = Number(args[i + 1]);
    if (!key || args[i + 1] === undefined || !Number.isSafeInteger(value) || value < (key === "seed" ? 0 : 1)) throw new Error(`Invalid argument: ${args[i]} ${args[i + 1] ?? ""}`);
    config[key] = value;
  }
  if (config.seed + config.duels > 0xffffffff) throw new Error("Seed range must fit uint32");
  return config;
}

async function main(): Promise<void> {
  const config = configFromArgs(process.argv.slice(2));
  const db = await loadCardDb();
  deckGenerator(db); // Fail before spawning if data or the TCG banlist is unavailable.
  const runs: Run[] = [];
  let child: ChildProcess | undefined;
  const stopChild = () => { if (child) { child.removeAllListeners(); child.kill("SIGKILL"); child = undefined; } };
  const save = () => {
    const failures = runs.filter(run => run.outcome !== "completed");
    const errorCounts: Record<string, number> = {};
    const errorTypes = new Map<string, { type: string; count: number; cardCodes: number[]; messages: string[] }>();
    const ranked = new Map<number, { code: number; name: string; frequency: number; impact: number; scriptMentions: number; messages: string[] }>();
    for (const run of failures) {
      errorCounts[run.outcome] = (errorCounts[run.outcome] ?? 0) + 1;
      const type = errorTypes.get(run.outcome) ?? { type: run.outcome, count: 0, cardCodes: [], messages: [] };
      type.count++;
      type.cardCodes = [...new Set([...type.cardCodes, ...run.cardCodes])];
      if (run.message && !type.messages.includes(run.message)) type.messages.push(run.message);
      errorTypes.set(run.outcome, type);
      // Caps/stalls are duel outcomes; do not blame a random last card for them.
      if (["decision_cap", "no_progress", "timeout", "choice_search"].includes(run.outcome)) continue;
      for (const code of run.cardCodes) {
        const card = ranked.get(code) ?? { code, name: db.name(code), frequency: 0, impact: 0, scriptMentions: 0, messages: [] };
        card.frequency++; card.impact += run.outcome === "engine_lua" ? 3 : 2;
        if (run.scriptCardCodes.includes(code)) card.scriptMentions++;
        if (run.message && !card.messages.includes(run.message)) card.messages.push(run.message);
        ranked.set(code, card);
      }
    }
    mkdirSync(fileURLToPath(new URL("../data/reports/", import.meta.url)), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), config, format: listFormats().find(format => format.id === "tcg"),
      totalDuelsRun: runs.length, totalDecisionsMade: runs.reduce((sum, run) => sum + run.decisions, 0),
      completedDuels: runs.length - failures.length, errorCounts,
      errorTypes: [...errorTypes.values()],
      deckCardCoverage: new Set(runs.flatMap(run => run.decks.flatMap(deck => [...deck.main, ...deck.extra]))).size,
      failingCards: [...ranked.values()].sort((a, b) => b.impact - a.impact || b.frequency - a.frequency || a.code - b.code),
      attribution: "Script mentions are direct evidence; last activated/selected cards are context, not proof of fault. Decision caps are reported separately from detected hangs. choice_search is a harness limitation.",
      failures, runs: runs.map(({ decks: _decks, prompt: _prompt, trace: _trace, stack: _stack, ...run }) => run) }, null, 2) + "\n");
  };
  try {
    for (let i = 0; i < config.duels; i++) {
      if (!child) {
        child = fork(fileURLToPath(import.meta.url), ["--worker"], { execArgv: process.execArgv, stdio: ["ignore", "ignore", "pipe", "ipc"] });
        child.stderr?.on("data", data => process.stderr.write(data));
        const starting = child;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Fuzz worker initialization timed out")), config.timeoutMs);
          starting.once("error", error => { clearTimeout(timer); reject(error); });
          starting.once("exit", code => { clearTimeout(timer); reject(new Error(`Worker exited during setup: ${code}`)); });
          starting.once("message", (msg: WorkerMessage) => { clearTimeout(timer); msg.type === "ready" ? resolve() : reject(new Error(msg.type === "fatal" ? msg.message : "Unexpected worker initialization message")); });
        });
      }
      const running = child, seed = config.seed + i, started = performance.now();
      let progress: Progress = { decisions: 0, decks: [{ main: [], extra: [], side: [] }, { main: [], extra: [], side: [] }], trace: [] };
      const run = await new Promise<Run>(resolve => {
        const finish = (result: Run) => { clearTimeout(timer); running.off("message", onMessage); running.off("exit", onExit); resolve(result); };
        const failure = (outcome: string, message: string): Run => ({ ...progress, seed, outcome, message, cardCodes: [], scriptCardCodes: [], elapsedMs: performance.now() - started });
        const timer = setTimeout(() => { finish(failure("timeout", `Exceeded ${config.timeoutMs}ms wall time`)); stopChild(); }, config.timeoutMs);
        const onExit = (code: number | null, signal: string | null) => { finish(failure("worker_crash", `Worker exited: ${code ?? signal}`)); child = undefined; };
        const onMessage = (msg: WorkerMessage) => {
          if (msg.type === "progress") progress = msg.progress;
          else if (msg.type === "result") finish(msg.run);
          else if (msg.type === "fatal") { finish(failure("worker_crash", msg.message)); stopChild(); }
        };
        running.on("message", onMessage); running.once("exit", onExit);
        running.send({ seed, config });
      });
      runs.push(run);
      if ((i + 1) % 10 === 0 || run.outcome !== "completed") {
        console.log(`${i + 1}/${config.duels}: seed=${seed} ${run.outcome}, decisions=${run.decisions}${run.message ? `: ${run.message}` : ""}`);
        save();
      }
    }
  } finally { stopChild(); save(); }
  console.log(`Wrote ${reportPath}: ${runs.length} duels, ${runs.reduce((sum, run) => sum + run.decisions, 0)} decisions`);
}

if (process.argv.includes("--worker")) worker().catch(error => { process.send?.({ type: "fatal", message: stringifyError(error) }); process.exitCode = 1; });
else main().catch(error => { console.error(error); process.exitCode = 1; });
