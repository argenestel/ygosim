// Best-effort readable view of an agent CLI's JSONL transcript (pi, codex, Claude Code).
export interface LogLine { kind: "say" | "think" | "tool" | "result" | "error" | "raw"; text: string }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const tool = (name: unknown) => String(name ?? "tool").replace(/^mcp__ygosim__/, "").replace(/^ygosim[.:/]/, "");
const args = (a: unknown) => { try { const j = JSON.stringify(a); return !j || j === "{}" ? "" : ` ${clip(j, 400)}`; } catch { return ""; } };
const textOf = (c: unknown): string => Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n").trim() : typeof c === "string" ? c : "";

function blocks(content: unknown, out: LogLine[]) {
  if (typeof content === "string") { if (content.trim()) out.push({ kind: "say", text: content.trim() }); return; }
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && String(b.text ?? "").trim()) out.push({ kind: "say", text: String(b.text).trim() });
    else if (b.type === "thinking" && String(b.thinking ?? "").trim()) out.push({ kind: "think", text: String(b.thinking).trim() });
    else if (b.type === "tool_use") out.push({ kind: "tool", text: `${tool(b.name)}${args(b.input)}` });
    else if (b.type === "tool_result") out.push({ kind: b.is_error ? "error" : "result", text: clip(textOf(b.content), 600) });
  }
}

export function parseTranscript(raw: string): LogLine[] {
  const out: LogLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { if (!line.startsWith("{")) out.push({ kind: "raw", text: clip(line, 300) }); continue; }
    switch (e?.type) {
      case "message_end": if (e.message?.role === "assistant") blocks(e.message.content, out); break;       // pi
      case "assistant": blocks(e.message?.content, out); break;                                              // Claude Code
      case "user": if (e.message?.role === "user") blocks(e.message.content, out); break;
      case "tool_execution_start": out.push({ kind: "tool", text: `${tool(e.toolName)}${args(e.args)}` }); break; // pi
      case "tool_execution_end": out.push({ kind: e.isError ? "error" : "result", text: clip(textOf(e.result?.content), 600) }); break;
      case "item.completed": {                                                                                // codex
        const it = e.item ?? {};
        if (it.type === "agent_message" && it.text) out.push({ kind: "say", text: String(it.text).trim() });
        else if (it.type === "reasoning" && it.text) out.push({ kind: "think", text: String(it.text).trim() });
        else if (it.type === "mcp_tool_call") {
          out.push({ kind: "tool", text: `${tool(it.tool)}${args(it.arguments)}` });
          const res = textOf(it.result?.content); if (res) out.push({ kind: it.error ? "error" : "result", text: clip(res, 600) });
        }
        break;
      }
      default: break;
    }
  }
  return out;
}
