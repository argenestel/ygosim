import type { Deck } from "@ygosim/protocol";

const MAX_PASSCODE = 99_999_999;

function parseDirective(line: string, lineNumber: number, deck: Deck, current: keyof Deck | undefined, seen: Set<keyof Deck>): keyof Deck | undefined {
  if (line === "#main") {
    if (seen.has("main")) throw new Error(`invalid .ydk line ${lineNumber}: duplicate #main section`);
    if (seen.has("extra") || seen.has("side")) throw new Error(`invalid .ydk line ${lineNumber}: #main must be first`);
    seen.add("main");
    return "main";
  }
  if (line === "#extra") {
    if (!seen.has("main")) throw new Error(`invalid .ydk line ${lineNumber}: #extra before #main`);
    if (seen.has("extra")) throw new Error(`invalid .ydk line ${lineNumber}: duplicate #extra section`);
    if (seen.has("side")) throw new Error(`invalid .ydk line ${lineNumber}: #extra after !side`);
    seen.add("extra");
    return "extra";
  }
  if (line === "!side") {
    if (!seen.has("main")) throw new Error(`invalid .ydk line ${lineNumber}: !side before #main`);
    if (seen.has("side")) throw new Error(`invalid .ydk line ${lineNumber}: duplicate !side section`);
    seen.add("side");
    return "side";
  }
  if (/^#(?:created(?:\s+by(?:\s+.*)?)?|updated(?:\s+by(?:\s+.*)?)?)$/.test(line)) return current;
  if (line.startsWith("#") || line.startsWith("!")) {
    throw new Error(`invalid .ydk line ${lineNumber}: unknown directive`);
  }
  if (!current) throw new Error(`invalid .ydk line ${lineNumber}: card appears before #main`);
  if (!/^\d+$/.test(line)) throw new Error(`invalid .ydk line ${lineNumber}: expected a passcode`);
  const code = Number(line);
  if (!Number.isSafeInteger(code) || code < 1 || code > MAX_PASSCODE) {
    throw new Error(`invalid .ydk line ${lineNumber}: passcode out of range`);
  }
  deck[current].push(code);
  return current;
}

/** Parse a YGOPro/EDOPro .ydk file and reject malformed content. */
export function parseYdk(text: string): Deck {
  if (typeof text !== "string") throw new TypeError(".ydk input must be a string");
  const deck: Deck = { main: [], extra: [], side: [] };
  const seen = new Set<keyof Deck>();
  let current: keyof Deck | undefined;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/^\uFEFF/, "").trim();
    if (!line) continue;
    current = parseDirective(line, index + 1, deck, current, seen);
  }
  if (!seen.has("main")) throw new Error("invalid .ydk: missing #main section");
  return deck;
}

