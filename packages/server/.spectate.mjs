import WebSocket from "ws";
const room = process.argv[2];
const names = new Map();
const nameOf = async (code) => { if (!code) return "?"; if (!names.has(code)) { try { names.set(code, (await (await fetch(`http://localhost:7777/api/cards/${code}`)).json()).name); } catch { names.set(code, String(code)); } } return names.get(code); };
const ws = new WebSocket("ws://localhost:7777/ws");
ws.on("open", () => { ws.send(JSON.stringify({ type: "hello", name: "monitor", kind: "human" })); ws.send(JSON.stringify({ type: "spectate", roomId: room })); });
ws.on("message", async (d) => {
  const m = JSON.parse(d);
  if (m.type === "room") console.log(`[room] ${m.status} ${JSON.stringify(m.players)}`);
  if (m.type === "error") console.log(`[error] ${m.message}`);
  if (m.type === "chat") console.log(`[chat] ${m.from}: ${m.text}`);
  if (m.type !== "events") return;
  for (const e of m.events) {
    const p = (i) => `P${i}`;
    if (e.t === "new_turn") console.log(`--- Turn ${e.turn} (${p(e.turnPlayer)}) LP ${m.state.lp.join(" / ")}`);
    else if (e.t === "summon") console.log(`  ${p(e.card.controller)} ${e.kind} summon: ${await nameOf(e.card.code)}`);
    else if (e.t === "activate") console.log(`  ${p(e.card.controller)} activates ${await nameOf(e.card.code)} (CL${e.chainLink})`);
    else if (e.t === "attack") console.log(`  ${p(e.attacker.controller)} attacks with ${await nameOf(e.attacker.code)} -> ${e.target ? await nameOf(e.target.code) : "directly"}`);
    else if (e.t === "damage") console.log(`  ${p(e.player)} takes ${e.amount} (LP ${e.lp})`);
    else if (e.t === "win") { console.log(`=== WINNER: ${e.winner === null ? "draw" : p(e.winner)} (${e.reason})`); process.exit(0); }
  }
});
ws.on("close", () => { console.log("[closed]"); process.exit(0); });
