// ygosim-agent: same tools as the MCP server over stdin/stdout JSON lines.
// In:  {"id":1,"tool":"create_room","args":{"vsAI":true}}   (also {"tool":"help"})
// Out: {"id":1,"ok":true,"text":"..."} | {"id":1,"ok":false,"error":"..."}
import { createInterface } from "node:readline";
import { z } from "zod";
import { Session, configFromEnv } from "./tools.js";

export async function handleLine(session: Session, line: string): Promise<object | null> {
  if (!line.trim()) return null;
  let req: any;
  try { req = JSON.parse(line); } catch { return { ok: false, error: "invalid JSON" }; }
  if (!req || typeof req !== "object" || Array.isArray(req)) return { ok: false, error: "request must be an object" };
  const id = req.id ?? null;
  const tools = session.tools();
  if (req.tool === "help") return { id, ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description, args: Object.keys(t.shape) })) };
  const t = tools.find((x) => x.name === req.tool);
  if (!t) return { id, ok: false, error: `unknown tool ${req.tool}; try {"tool":"help"}` };
  try {
    const args = z.object(t.shape).parse(req.args ?? {});
    return { id, ok: true, text: await t.run(args) };
  } catch (e: any) {
    return { id, ok: false, error: e?.message ?? String(e) };
  }
}

export function runCli() {
  const session = new Session(configFromEnv());
  const rl = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { session.client.close(); process.exit(0); });
  rl.on("line", (line) => {
    queue = queue.then(async () => { const r = await handleLine(session, line); if (r) process.stdout.write(JSON.stringify(r) + "\n"); });
  });
  rl.on("close", () => queue.then(() => { session.client.close(); }));
}
