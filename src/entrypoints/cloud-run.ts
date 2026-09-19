import { main } from "./server.js";
export { upstreamForRequest } from "./server.js";
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
