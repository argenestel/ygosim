import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import createCore, { OcgDuelMode, OcgLocation, OcgLogType, OcgPosition, type OcgCoreSync, type OcgDuelHandle } from "ocgcore-wasm";
import { loadCardDb, toOcgCard, type RawCard, type SqlCardDb } from "../src/carddb.js";
import { makeScriptReader } from "../src/data.js";

const OT_OCG = 0x01;
const OT_TCG = 0x02;
const OT_RUSH = 0x200;
const TYPE_TOKEN = 0x4000;
const TYPE_NORMAL = 0x10;
const TYPE_PENDULUM = 0x1000000;
const DEFAULT_BATCH_SIZE = 500;

export interface AuditCard {
  code: number;
  name: string;
}

export interface AuditLoadError extends AuditCard {
  error: string;
}

export interface ScriptAuditReport {
  totalCardsChecked: number;
  scriptsChecked: number;
  normalNoScriptRequired: number;
  aliasScriptsReused: number;
  missingScripts: AuditCard[];
  loadErrors: AuditLoadError[];
}

interface ScriptTarget {
  card: RawCard;
  scriptCode?: number;
}

interface CliOptions {
  output: string;
  batchSize: number;
}

function parseOptions(argv: readonly string[]): CliOptions {
  const defaultOutput = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "reports", "script-audit.json");
  let output = defaultOutput;
  let batchSize = DEFAULT_BATCH_SIZE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output") {
      const value = argv[++i];
      if (!value) throw new Error("--output requires a path");
      output = isAbsolute(value) ? value : resolve(process.cwd(), value);
    } else if (arg === "--batch-size") {
      const value = Number(argv[++i]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("--batch-size must be a positive integer");
      batchSize = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: tsx packages/engine/scripts/audit-scripts.ts [--output PATH] [--batch-size N]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { output, batchSize };
}

function isTargetCard(card: RawCard): boolean {
  return (card.ot & (OT_OCG | OT_TCG)) !== 0 && (card.ot & OT_RUSH) === 0 && (card.type & TYPE_TOKEN) === 0;
}

function isNormalMonster(card: RawCard): boolean {
  return (card.type & TYPE_NORMAL) !== 0 && (card.type & TYPE_PENDULUM) === 0;
}

function selectedCards(db: SqlCardDb): RawCard[] {
  return [...db.raw.values()].filter(isTargetCard).sort((a, b) => a.code - b.code);
}

/**
 * Resolve the filename the core should use for a card. Alternate artworks and
 * reprints commonly point at a canonical passcode through `alias`; they share
 * the canonical script when their own c<code>.lua file is absent.
 */
function scriptTarget(card: RawCard, db: SqlCardDb, readScript: (name: string) => string | null): ScriptTarget {
  const seen = new Set<number>();
  let current: RawCard | undefined = card;
  while (current && !seen.has(current.code)) {
    seen.add(current.code);
    const ownName = `c${current.code}.lua`;
    const ownScript = readScript(ownName);
    if (ownScript !== null) return { card, scriptCode: current.code };
    if (!current.alias) break;
    current = db.raw.get(current.alias);
  }
  return { card };
}

function makeCore(core: OcgCoreSync, db: SqlCardDb, readScript: (name: string) => string | null, errors: string[]): OcgDuelHandle {
  const handle = core.createDuel({
    flags: OcgDuelMode.MODE_MR5,
    seed: [1n, 2n, 3n, 4n],
    team1: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
    team2: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
    cardReader: code => {
      const card = db.raw.get(code);
      return card ? toOcgCard(card) : null;
    },
    scriptReader: readScript,
    errorHandler: (type, message) => {
      // FROM_SCRIPT contains ordinary Debug.Message output. Actual Lua
      // compilation/runtime and core errors use ERROR.
      if (type === OcgLogType.ERROR) errors.push(message);
    },
  });
  if (!handle) throw new Error("ocgcore could not create an audit duel");
  return handle;
}

function loadRequiredScript(core: OcgCoreSync, handle: OcgDuelHandle, name: string, readScript: (name: string) => string | null, errors: string[]): void {
  const script = readScript(name);
  if (!script) throw new Error(`Unable to load required core script ${name}`);
  if (!core.loadScript(handle, name, script) || errors.length) {
    const detail = errors.splice(0).join(" | ") || "core.loadScript returned false";
    throw new Error(`${name}: ${detail}`);
  }
}

export function loadBatch(core: OcgCoreSync, db: SqlCardDb, cards: readonly ScriptTarget[], readScript: (name: string) => string | null, loadErrors: AuditLoadError[]): void {
  const coreErrors: string[] = [];
  const handle = makeCore(core, db, readScript, coreErrors);
  try {
    loadRequiredScript(core, handle, "constant.lua", readScript, coreErrors);
    loadRequiredScript(core, handle, "utility.lua", readScript, coreErrors);
    for (let sequence = 0; sequence < cards.length; sequence++) {
      const target = cards[sequence];
      if (target.scriptCode === undefined) continue;
      try {
        // Registering the card makes the core load the script through its
        // scriptReader and invoke initial_effect, which catches initialization
        // errors that a bare loadScript call cannot observe. A single card in
        // the deck is enough; scripts need no duel decisions for this phase.
        core.duelNewCard(handle, {
          team: 0,
          duelist: 0,
          controller: 0,
          code: target.card.code,
          location: OcgLocation.DECK,
          sequence,
          position: OcgPosition.FACEDOWN_DEFENSE,
        });
      } catch (error) {
        coreErrors.push(String(error));
      }
      const errors = coreErrors.splice(0);
      if (errors.length) {
        const detail = errors.join(" | ");
        loadErrors.push({ code: target.card.code, name: target.card.name, error: detail });
      }
    }
  } finally {
    core.destroyDuel(handle);
  }
}

export async function runAudit(options: CliOptions): Promise<ScriptAuditReport> {
  const db = await loadCardDb();
  const readScript = makeScriptReader();
  const cards = selectedCards(db);
  const missingScripts: AuditCard[] = [];
  const targets: ScriptTarget[] = [];
  let normalNoScriptRequired = 0;
  let aliasScriptsReused = 0;
  for (const card of cards) {
    const target = scriptTarget(card, db, readScript);
    // Normal monsters are represented entirely by database data and do not
    // have a c<code>.lua script in ProjectIgnis CardScripts.
    if (target.scriptCode === undefined) {
      if (isNormalMonster(card)) normalNoScriptRequired++;
      else missingScripts.push({ code: card.code, name: card.name });
    } else {
      targets.push(target);
      if (target.scriptCode !== card.code) aliasScriptsReused++;
    }
  }

  const core = await createCore({ sync: true });
  const loadErrors: AuditLoadError[] = [];
  for (let offset = 0; offset < targets.length; offset += options.batchSize) {
    loadBatch(core, db, targets.slice(offset, offset + options.batchSize), readScript, loadErrors);
    if ((offset / options.batchSize) % 10 === 0 || offset + options.batchSize >= targets.length) {
      console.error(`audited ${Math.min(offset + options.batchSize, targets.length)}/${targets.length} scripts`);
    }
  }
  return {
    totalCardsChecked: cards.length,
    scriptsChecked: targets.length,
    normalNoScriptRequired,
    aliasScriptsReused,
    missingScripts,
    loadErrors,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const report = await runAudit(options);
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: options.output,
    totalCardsChecked: report.totalCardsChecked,
    scriptsChecked: report.scriptsChecked,
    normalNoScriptRequired: report.normalNoScriptRequired,
    aliasScriptsReused: report.aliasScriptsReused,
    missingScripts: report.missingScripts.length,
    loadErrors: report.loadErrors.length,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
