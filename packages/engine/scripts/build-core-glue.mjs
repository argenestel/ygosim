// Keep ocgcore-wasm 0.1.2's API/decoder, replacing only its native factory and
// binary loader, plus the upstream CardData offset fix (3c7d293).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [wrapper, output] = process.argv.slice(2);
const require = createRequire(import.meta.url);
// esbuild is already installed by the engine's Vitest/Vite toolchain.
const viteRequire = createRequire(createRequire(require.resolve("vitest/package.json")).resolve("vite"));
const { build } = viteRequire("esbuild");
const entry = join(wrapper, "src/index.ts");
let source = readFileSync(entry, "utf8");
source = source.replace('await createCoreJspi(init ?? {})', 'Promise.reject(new Error("Vendored ocgcore supports sync: true only"))');
source = source.slice(0, source.indexOf("async function createCoreJspi("))
  + source.slice(source.indexOf("function createImportMethodsBase("));
source = source.slice(0, source.indexOf("async function importFactoryJspi(")) + `
async function importFactorySync() {
  return (await import("./ocgcore.sync.mjs")).default;
}
async function importWasmSync() {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(new URL("./ocgcore.sync.wasm", import.meta.url));
  return new Uint8Array(bytes).buffer;
}
`;
writeFileSync(entry, source);
const dataPath = join(wrapper, "src/data.ts");
let data = readFileSync(dataPath, "utf8");
data = data.replace('setUint32(48, data.rscale', 'setUint32(44, data.rscale')
  .replace('setUint32(52, data.link_marker', 'setUint32(48, data.link_marker')
  .replace('setInt32(36, data.attack', 'setInt32(40, data.attack')
  .replace('setInt32(40, data.defense', 'setInt32(44, data.defense')
  .replace('setUint32(44, data.lscale', 'setUint32(48, data.lscale')
  .replace('setUint32(48, data.rscale', 'setUint32(52, data.rscale')
  .replace('setUint32(52, data.link_marker', 'setUint32(56, data.link_marker');
writeFileSync(dataPath, data);
await build({ absWorkingDir: wrapper, entryPoints: [entry], bundle: true, format: "esm", platform: "node",
  target: "es2020", external: ["./ocgcore.sync.mjs"], outfile: join(output, "index.mjs") });
