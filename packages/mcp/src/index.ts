/**
 * loopc-mcp bin: serve the Monkey D Loopy factory over stdio.
 * Dev runs via tsx; the published bin is the compiled ./dist/index.js (plain-node shebang
 * added at build by tsup).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
