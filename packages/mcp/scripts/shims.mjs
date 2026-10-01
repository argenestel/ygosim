// tsc emits to dist/mcp/src/* because @ygosim/protocol ships raw .ts; add stable entrypoints.
import { writeFileSync, chmodSync } from "node:fs";
for (const f of ["index", "cli"]) {
  const p = new URL(`../dist/${f}.js`, import.meta.url);
  const entry = f === "cli" ? 'import { runCli } from "./mcp/src/cli.js";\nrunCli();' : 'import "./mcp/src/index.js";';
  writeFileSync(p, `#!/usr/bin/env node\n${entry}\n`);
  chmodSync(p, 0o755);
}
