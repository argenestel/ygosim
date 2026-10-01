// tsc emits to dist/mcp/src/* because @ygosim/protocol ships raw .ts; add stable entrypoints.
import { writeFileSync, chmodSync } from "node:fs";
for (const f of ["index", "cli"]) {
  const p = new URL(`../dist/${f}.js`, import.meta.url);
  writeFileSync(p, `#!/usr/bin/env node\nimport "./mcp/src/${f}.js";\n`);
  chmodSync(p, 0o755);
}
