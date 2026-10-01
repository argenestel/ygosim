import { startServer } from "./server.js";
const s = await startServer();
console.log(`[ygosim] server on http://localhost:${s.port}  (ws://localhost:${s.port}/ws)`);
