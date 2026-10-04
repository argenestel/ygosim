import { startServer } from "./server.js";

const service = await startServer({ port: 0 });
export default service.http;
