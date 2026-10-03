import { startServer } from "./server.js";
const s = await startServer();
console.log(`[ygosim] server on http://localhost:${s.port}  (ws://localhost:${s.port}/ws)`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void s.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
});
