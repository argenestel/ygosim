// Dev-only stress fixture (?fixture=1): a crowded board, a 10-card hand, an active
// chain with a target and long card text, fed through the real duel screen so the
// arena layout can be checked without playing a game to that state.
import type { CardRef, ClientMsg, DuelState, Location, PlayerIdx, Prompt, ServerMsg } from "@ygosim/protocol";
import type { Conn } from "../net";

const MON = [89631139, 46986414, 44508094, 70095154, 40640057];
const SPELL = [55144522, 44095762, 5318639, 24094653, 83764718];
const HAND = [14558127, 24224830, 89631139, 46986414, 86066372, 63977008, 5318639, 83764718, 44508094, 40640057];

let n = 0;
const card = (p: PlayerIdx, location: Location, sequence: number, code: number | undefined, position: CardRef["position"], extra: Partial<CardRef> = {}): CardRef =>
  ({ uid: `fx${n++}`, code, owner: p, controller: p, location, sequence, position, ...extra });

function side(p: PlayerIdx, you: PlayerIdx): CardRef[] {
  const mine = p === you;
  const out: CardRef[] = [];
  const pos: CardRef["position"][] = ["atk", "def", "facedown_def", "atk", "atk"];
  MON.forEach((c, i) => out.push(card(p, "mzone", i, pos[i] === "facedown_def" && !mine ? undefined : c, pos[i], { atk: 1000 + i * 500, def: 800 + i * 300 })));
  SPELL.forEach((c, i) => out.push(card(p, "szone", i, i % 2 && !mine ? undefined : c, i % 2 ? "facedown" : "faceup")));
  out.push(card(p, "szone", 5, 73628505, "faceup")); // field spell
  for (let i = 0; i < 12; i++) out.push(card(p, "grave", i, MON[i % 5], "faceup"));
  for (let i = 0; i < 4; i++) out.push(card(p, "banished", i, SPELL[i % 5], "faceup"));
  for (let i = 0; i < 20; i++) out.push(card(p, "deck", i, undefined, "facedown"));
  for (let i = 0; i < 15; i++) out.push(card(p, "extra", i, mine ? 84013237 : undefined, "facedown"));
  if (mine) HAND.forEach((c, i) => out.push(card(p, "hand", i, c, "faceup")));
  else for (let i = 0; i < 6; i++) out.push(card(p, "hand", i, undefined, "facedown"));
  return out;
}

export function createFixtureConn(onMsg: (m: ServerMsg) => void): Conn {
  n = 0;
  const you: PlayerIdx = 0;
  const cards = [...side(0, you), ...side(1, you)];
  // Xyz with materials in my EMZ, a Link in the opponent's.
  cards.push(card(0, "mzone", 5, 84013237, "atk", { atk: 2500, def: 2000, overlays: [card(0, "mzone", 5, 40640057, "faceup"), card(0, "mzone", 5, 70095154, "faceup")] }));
  cards.push(card(1, "mzone", 5, 1861629, "atk", { atk: 2300 }));
  const myMon = cards.filter((c) => c.controller === 0 && c.location === "mzone");
  const opMon = cards.filter((c) => c.controller === 1 && c.location === "mzone");
  const hand = cards.filter((c) => c.controller === 0 && c.location === "hand");
  const state: DuelState = {
    duelId: "fixture", turn: 7, turnPlayer: 0, phase: "main1", lp: [6400, 2850], you,
    cards,
    chain: [
      { card: opMon[3], desc: "Destroy 1 card on the field.", targets: [myMon[0]] },
      { card: hand[0], desc: "Negate the effect that would add a card from the Deck to the hand." },
    ],
  };
  const prompt: Prompt = {
    promptId: "fixture-1", kind: "idle", text: "Choose a main-phase action.", min: 1, max: 1,
    options: [
      ...hand.slice(0, 6).map((c, i) => ({ id: `h${i}`, label: i % 2 ? "Activate" : "Normal Summon", card: c })),
      ...myMon.slice(0, 3).map((c, i) => ({ id: `m${i}`, label: "Activate effect", card: c })),
      { id: "bp", label: "Go to Battle Phase" },
      { id: "ep", label: "Go to End Phase" },
      { id: "sh", label: "Shuffle hand" },
    ],
  };
  setTimeout(() => {
    onMsg({ type: "welcome", clientId: "fixture" });
    onMsg({ type: "room", roomId: "FIXTURE", players: ["You", "Rival Agent"], status: "dueling" });
    onMsg({ type: "prompt", prompt, state });
  }, 50);
  return { send(_m: ClientMsg) { /* static fixture */ }, close() {} };
}

export const isFixture = import.meta.env.DEV && new URLSearchParams(location.search).get("fixture") === "1";
