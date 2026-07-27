"use strict";

/* stdio MCP endpoint: proxies newline-delimited JSON-RPC from an agent host to
   the Lousa HTTP /mcp. Targets LOUSA_URL when set (remote/self-hosted); otherwise
   ensures a detached local server and targets it — so the viewer is always up. */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT) || 4666;
const LOG_FILE = path.join(require("os").tmpdir(), "lousa-local.log");

const log = message => process.stderr.write(`[lousa-mcp] ${message}\n`);

async function healthy(base) {
  try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}

async function ensureLocalServer() {
  const base = `http://127.0.0.1:${PORT}`;
  if (await healthy(base)) return base;
  log(`starting local server on port ${PORT} (log: ${LOG_FILE})`);
  const out = fs.openSync(LOG_FILE, "a");
  spawn(process.execPath, [path.join(__dirname, "server.js")], {
    detached: true, stdio: ["ignore", out, out],
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  }).unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await healthy(base)) return base;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`local server did not come up — see ${LOG_FILE}`);
}

async function main() {
  const headers = { "content-type": "application/json" };
  let base;
  if (process.env.LOUSA_URL) {
    base = process.env.LOUSA_URL.replace(/\/$/, "");
    if (process.env.LOUSA_TOKEN) headers.authorization = `Bearer ${process.env.LOUSA_TOKEN}`;
  } else {
    base = await ensureLocalServer();
  }
  const target = `${base}/mcp`;
  log(`target: ${target}`);

  let pending = 0, stdinClosed = false;
  const maybeExit = () => { if (stdinClosed && pending === 0) process.exit(0); };

  const handle = async line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const isNotification = message.id === undefined || message.id === null;
    pending++;
    try {
      const response = await fetch(target, { method: "POST", headers, body: line, signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      if (!isNotification) {
        if (response.ok && text.trim()) process.stdout.write(text.trim() + "\n");
        else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `lousa: HTTP ${response.status} ${text.slice(0, 200)}` } }) + "\n");
      }
    } catch (error) {
      if (!isNotification) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `lousa: ${error.message}` } }) + "\n");
    } finally {
      pending--;
      maybeExit();
    }
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handle(line);
    }
  });
  process.stdin.on("end", () => { stdinClosed = true; maybeExit(); });
}

main().catch(error => { log(`fatal: ${error.message}`); process.exit(1); });
