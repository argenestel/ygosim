import { describe, expect, it } from "vitest";
import {
  OcgDuelMode,
  OcgLocation,
  OcgLogType,
  OcgMessageType,
  OcgQueryFlags,
  OcgPosition,
  OcgProcessResult,
  OcgResponseType,
  SelectBattleCMDAction,
  SelectIdleCMDAction,
  type OcgCardData,
  type OcgCoreSync,
  type OcgDuelHandle,
  type OcgMessage,
  type OcgResponse,
} from "ocgcore-wasm";
import { createCompatibleCore } from "../src/core.js";
import { loadCardDb, toOcgCard } from "../src/carddb.js";
import { makeScriptReader } from "../src/data.js";

const TEST_CARD = 89631139;
const PENDULUM_CARD = 368382; // Dinomist Brachion: right scale 6.
const LINK_CARD = 1861629; // Decode Talker: link arrows 0x85 (133).

// The operation runs while its activation is resolving, so the core must
// accept every current CHAININFO_* value in the active chain context.
const chainInfoScript = `
local s,id=GetID()
function s.initial_effect(c)
  local e=Effect.CreateEffect(c)
  e:SetType(EFFECT_TYPE_IGNITION)
  e:SetRange(LOCATION_HAND)
  e:SetOperation(function()
    for info=1,33 do Duel.GetChainInfo(0,info) end
    Debug.Message('CHAININFO_1_33_OK')
  end)
  c:RegisterEffect(e)
end
`;

function responseFor(message: OcgMessage): OcgResponse {
  switch (message.type) {
    case OcgMessageType.ROCK_PAPER_SCISSORS:
      return { type: OcgResponseType.ROCK_PAPER_SCISSORS, value: 1 as const };
    case OcgMessageType.SELECT_IDLECMD:
      if (message.activates.length) return { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.SELECT_ACTIVATE, index: 0 };
      if (message.to_ep) return { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_EP, index: null };
      if (message.to_bp) return { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_BP, index: null };
      throw new Error("idle command had no usable action");
    case OcgMessageType.SELECT_BATTLECMD:
      return { type: OcgResponseType.SELECT_BATTLECMD, action: SelectBattleCMDAction.TO_EP, index: null };
    case OcgMessageType.SELECT_EFFECTYN:
      return { type: OcgResponseType.SELECT_EFFECTYN, yes: true };
    case OcgMessageType.SELECT_YESNO:
      return { type: OcgResponseType.SELECT_YESNO, yes: true };
    case OcgMessageType.SELECT_CHAIN:
      return { type: OcgResponseType.SELECT_CHAIN, index: null };
    default:
      throw new Error(`unexpected core response ${message.type}`);
  }
}

async function createTestDuel(core: OcgCoreSync, cards: Map<number, OcgCardData>): Promise<{ core: OcgCoreSync; handle: OcgDuelHandle; errors: string[]; debug: string[] }> {
  const errors: string[] = [];
  const debug: string[] = [];
  const read = makeScriptReader();
  const handle = core.createDuel({
    flags: OcgDuelMode.MODE_MR5,
    seed: [1n, 2n, 3n, 4n],
    team1: { startingLP: 8000, startingDrawCount: 1, drawCountPerTurn: 1 },
    team2: { startingLP: 8000, startingDrawCount: 1, drawCountPerTurn: 1 },
    cardReader: (code) => cards.get(code) ?? null,
    scriptReader: (name) => name === `c${TEST_CARD}.lua` ? chainInfoScript : read(name),
    errorHandler: (type, message) => {
      if (type === OcgLogType.ERROR) errors.push(message);
      else debug.push(message);
    },
  });
  if (!handle) throw new Error("failed to create core duel");
  for (const name of ["constant.lua", "utility.lua"]) {
    const script = read(name);
    if (!script || !core.loadScript(handle, name, script)) throw new Error(`failed to load ${name}`);
  }
  for (const team of [0, 1] as const) {
    for (let i = 0; i < 40; i++) {
      core.duelNewCard(handle, {
        team,
        duelist: 0,
        code: TEST_CARD,
        controller: team,
        location: i === 0 ? OcgLocation.HAND : OcgLocation.DECK,
        sequence: 0,
        position: OcgPosition.FACEDOWN_DEFENSE,
      });
    }
  }
  for (const [code, sequence] of [[PENDULUM_CARD, 0], [LINK_CARD, 1]] as const) {
    core.duelNewCard(handle, {
      team: 0, duelist: 0, code, controller: 0, location: OcgLocation.MZONE, sequence,
      position: OcgPosition.FACEUP_ATTACK,
    });
  }
  core.startDuel(handle);
  return { core, handle, errors, debug };
}

describe("modern CHAININFO flags", () => {
  it("accepts every CHAININFO flag while a real card activation resolves", async () => {
    const db = await loadCardDb();
    const core = await createCompatibleCore();
    const cards = new Map([TEST_CARD, PENDULUM_CARD, LINK_CARD].map(code => [code, toOcgCard(db.raw.get(code)!)] as const));
    const duel = await createTestDuel(core, cards);
    try {
      let activated = false;
      for (let attempt = 0; attempt < 100 && !activated; attempt++) {
        const status = core.duelProcess(duel.handle);
        const messages = core.duelGetMessage(duel.handle);
        const idle = messages.find((message) => message.type === OcgMessageType.SELECT_IDLECMD);
        const customActivation = idle?.type === OcgMessageType.SELECT_IDLECMD
          ? idle.activates.findIndex((card) => card.code === TEST_CARD)
          : -1;
        if (customActivation >= 0) activated = true;
        const response = messages.find((message) => [
          OcgMessageType.ROCK_PAPER_SCISSORS,
          OcgMessageType.SELECT_IDLECMD,
          OcgMessageType.SELECT_BATTLECMD,
          OcgMessageType.SELECT_EFFECTYN,
          OcgMessageType.SELECT_YESNO,
          OcgMessageType.SELECT_CHAIN,
        ].includes(message.type));
        if (response) {
          const responseValue: OcgResponse = response.type === OcgMessageType.SELECT_IDLECMD && customActivation >= 0
            ? { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.SELECT_ACTIVATE, index: customActivation }
            : responseFor(response);
          core.duelSetResponse(duel.handle, responseValue);
        }
        else if (status === OcgProcessResult.END) break;
      }
      expect(activated).toBe(true);
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = core.duelProcess(duel.handle);
        const messages = core.duelGetMessage(duel.handle);
        if (duel.errors.length) break;
        if (status === OcgProcessResult.END) break;
        const response = messages.find((message) => [
          OcgMessageType.ROCK_PAPER_SCISSORS,
          OcgMessageType.SELECT_IDLECMD,
          OcgMessageType.SELECT_BATTLECMD,
          OcgMessageType.SELECT_EFFECTYN,
          OcgMessageType.SELECT_YESNO,
          OcgMessageType.SELECT_CHAIN,
        ].includes(message.type));
        if (response) core.duelSetResponse(duel.handle, responseFor(response));
      }
      expect(duel.errors).toEqual([]);
      expect(duel.debug).toContain("CHAININFO_1_33_OK");
      const pendulum = core.duelQuery(duel.handle, {
        controller: 0, location: OcgLocation.MZONE, sequence: 0, overlaySequence: 0,
        flags: OcgQueryFlags.RSCALE,
      });
      const link = core.duelQuery(duel.handle, {
        controller: 0, location: OcgLocation.MZONE, sequence: 1, overlaySequence: 0,
        flags: OcgQueryFlags.LINK,
      });
      expect(pendulum?.rightScale).toBe(6);
      expect(link?.link).toEqual({ rating: 3, marker: 0x85 });
    } finally {
      core.destroyDuel(duel.handle);
    }
  }, 30_000);
});
