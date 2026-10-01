import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Session, configFromEnv } from "./tools.js";

const session = new Session(configFromEnv());
const server = new McpServer({ name: "ygosim", version: "0.1.0" });

for (const t of session.tools()) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (args: any) => {
    try {
      return { content: [{ type: "text" as const, text: await t.run(args ?? {}) }] };
    } catch (e: any) {
      return { isError: true, content: [{ type: "text" as const, text: `Error: ${e?.message ?? e}` }] };
    }
  });
}

await server.connect(new StdioServerTransport());
server.server.onclose = () => session.client.close();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { session.client.close(); process.exit(0); });
