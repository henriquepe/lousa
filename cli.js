#!/usr/bin/env node
"use strict";

/* lousa CLI
   - `lousa` / `lousa serve` — start the local server (viewer + HTTP API + /mcp)
   - `lousa mcp`             — stdio MCP endpoint for agent hosts; ensures the
                               local server is running so the viewer works too */

const command = process.argv[2] || "serve";

for (const arg of ["--port", "-p"]) {
  const index = process.argv.indexOf(arg);
  if (index >= 0 && process.argv[index + 1]) process.env.PORT = process.argv[index + 1];
}

if (command === "serve") require("./server.js");
else if (command === "mcp") require("./mcp-stdio.js");
else if (command === "--help" || command === "help") {
  console.log(`lousa — a whiteboard where AI agents draw their explanations

Usage:
  lousa [serve] [--port N]   start the local server (default port 4666)
  lousa mcp [--port N]       stdio MCP endpoint (auto-starts the local server)

Environment:
  PORT, HOST                 server bind (default 127.0.0.1:4666)
  LOUSA_DATA_DIR             board storage (default ~/.lousa/boards)
  LOUSA_TOKEN                require bearer token on global routes and /mcp
  LOUSA_URL                  \`lousa mcp\` proxies to this remote server instead
  LOUSA_DEFAULT_TTL_HOURS    board expiry default (12; boards use ttlHours, 0 = keep)`);
} else {
  console.error(`Unknown command: ${command} (try \`lousa help\`)`);
  process.exit(1);
}
