import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/** Locate the data dir: $YGOSIM_DATA, else walk up from this file looking for data/CardScripts. */
export function dataDir(): string {
  const configured = process.env.YGOSIM_DATA?.trim();
  if (configured) {
    const dir = resolve(configured);
    if (!isDirectory(join(dir, "CardScripts"))) {
      throw new Error(`ygosim data directory is missing CardScripts: ${dir}`);
    }
    return dir;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, "data");
    if (isDirectory(join(cand, "CardScripts"))) return cand;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error("ygosim data not found: run scripts/fetch-data.sh or set YGOSIM_DATA");
}

/** Card databases to load, in priority order (later overrides earlier). */
export function cdbFiles(dir = dataDir()): string[] {
  const root = resolve(dir);
  const babel = join(root, "BabelCDB");
  if (!isDirectory(babel)) throw new Error(`ygosim card database directory not found: ${babel}`);
  const files = readdirSync(babel, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".cdb"))
    .map((entry) => entry.name);
  const pick = (re: RegExp) => files.filter((f) => re.test(f)).sort();
  return [
    ...pick(/^cards\.cdb$/),
    ...pick(/^release-.*\.cdb$/),
    ...pick(/^prerelease-(?!cards-rush).*\.cdb$/),
  ].map((f) => join(babel, f)).filter((path) => inside(babel, resolve(path)));
}

export interface SystemStrings {
  system: Map<number, string>;
  victory: Map<number, string>;
  counter: Map<number, string>;
  setname: Map<number, string>;
}

const stringsCache = new Map<string, SystemStrings>();
export function loadStrings(dir = dataDir()): SystemStrings {
  const root = resolve(dir);
  const cached = stringsCache.get(root);
  if (cached) return cached;
  const s: SystemStrings = { system: new Map(), victory: new Map(), counter: new Map(), setname: new Map() };
  const p = join(root, "strings.conf");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^!(system|victory|counter|setname)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const n = Number(m[2]);
      if (Number.isFinite(n)) s[m[1] as keyof SystemStrings].set(n, m[3].split("\t")[0].trim());
    }
  }
  stringsCache.set(root, s);
  return s;
}

/** Script reader matching EDOPro's layout. */
export function makeScriptReader(dir = dataDir()) {
  const root = resolve(dir, "CardScripts");
  const subdirs = ["official", "pre-release", "pre-errata", "unofficial", "goat", "skill", "rush"];
  const cache = new Map<string, string | null>();
  return (name: string): string | null => {
    if (cache.has(name)) return cache.get(name)!;
    const normalized = name.replaceAll("\\", "/");
    const parts = normalized.split("/").filter((part) => part && part !== ".");
    if (normalized.includes("\0") || normalized.startsWith("/") || parts.includes("..")) {
      cache.set(name, null);
      return null;
    }
    const base = parts.at(-1);
    if (!base || !/^[A-Za-z0-9_.-]+\.lua$/.test(base)) {
      cache.set(name, null);
      return null;
    }
    const cands = /^c\d+\.lua$/.test(base)
      ? subdirs.map((d) => join(root, d, base))
      : [join(root, base)];
    let out: string | null = null;
    for (const c of cands) {
      const candidate = resolve(c);
      if (!inside(root, candidate) || !existsSync(candidate)) continue;
      try {
        if (statSync(candidate).isFile()) { out = readFileSync(candidate, "utf8"); break; }
      } catch {
        // A missing or unreadable script behaves like an absent script to the core.
      }
    }
    cache.set(name, out);
    return out;
  };
}
