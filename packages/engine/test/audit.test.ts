import createCore from "ocgcore-wasm";
import { expect, it } from "vitest";
import { loadCardDb } from "../src/carddb.js";
import { makeScriptReader } from "../src/data.js";
import { loadBatch } from "../scripts/audit-scripts.js";

it("audits Lua compilation and initial_effect errors with the affected card code", async () => {
  const db = await loadCardDb(), core = await createCore({ sync: true });
  const read = makeScriptReader(), card = db.raw.get(83746708)!;
  for (const script of ["not valid lua !!!", `local s,id=GetID()\nfunction s.initial_effect(c) error('audit initialization regression') end`]) {
    const errors: Array<{ code: number; name: string; error: string }> = [];
    loadBatch(core, db, [{ card, scriptCode: card.code }], name => name === `c${card.code}.lua` ? script : read(name), errors);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(card.code);
    expect(errors[0].error).toMatch(/syntax|near|audit initialization regression/);
  }
});

it("does not count ordinary Lua Debug.Message output as a load error", async () => {
  const db = await loadCardDb(), core = await createCore({ sync: true });
  const read = makeScriptReader(), card = db.raw.get(83746708)!;
  const script = `local s,id=GetID()\nfunction s.initial_effect(c) Debug.Message('audit-debug') end`;
  const errors: Array<{ code: number; name: string; error: string }> = [];
  loadBatch(core, db, [{ card, scriptCode: card.code }], name => name === `c${card.code}.lua` ? script : read(name), errors);
  expect(errors).toEqual([]);
});
