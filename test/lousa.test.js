"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolated fs storage for the whole test run (must be set before requiring modules).
process.env.LOUSA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lousa-test-"));
delete process.env.LOUSA_BUCKET;
delete process.env.LOUSA_TOKEN;

const boards = require("../boards.js");
const { handleMcp } = require("../mcp.js");
const { handleRequest } = require("../core.js");

const SCENE = [
  { id: "a", type: "box", x: 0, y: 0, w: 200, h: 80, label: "Service", color: "blue" },
  { id: "b", type: "cylinder", x: 400, y: 0, w: 160, h: 110, label: "DB", color: "purple" },
  { id: "ab", type: "arrow", from: "a", to: "b", label: "writes" },
];

/* ---------- boards ---------- */

test("createBoard sanitizes and stamps expiry (default 12h sliding)", async () => {
  const board = await boards.createBoard({ title: "t", scene: SCENE, requests: ["draw it"] });
  assert.match(board.id, /^[a-f0-9]{12}$/);
  assert.equal(board.scene.length, 3);
  assert.equal(board.ttlHours, 12);
  const hours = (Date.parse(board.expiresAt) - Date.parse(board.updatedAt)) / 3600000;
  assert.ok(Math.abs(hours - 12) < 0.01);
});

test("updateBoard replaces scene, prunes selection, slides expiry", async () => {
  const board = await boards.createBoard({ title: "t", scene: SCENE });
  await boards.setSelection(board.id, ["a", "ab", "ghost"]);
  const selection = await boards.getSelection(board.id);
  assert.deepEqual(selection.selection, ["a", "ab"]); // "ghost" filtered out
  const updated = await boards.updateBoard(board.id, { scene: SCENE.slice(0, 2) }); // drop the arrow
  assert.equal(updated.scene.length, 2);
  assert.deepEqual(updated.selection, ["a"]); // "ab" pruned with its element
});

test("ttlHours 0 means permanent; tiny ttl expires and is lazily deleted", async () => {
  const permanent = await boards.createBoard({ title: "keep", scene: [], ttlHours: 0 });
  assert.equal(permanent.expiresAt, null);

  const ephemeral = await boards.createBoard({ title: "gone", scene: [], ttlHours: 1e-9 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await boards.getBoard(ephemeral.id), null); // expired on read
  const list = await boards.listBoards();
  assert.ok(list.some(b => b.id === permanent.id));
  assert.ok(!list.some(b => b.id === ephemeral.id));
});

test("invalid board id is rejected", async () => {
  await assert.rejects(() => boards.getBoard("../etc/passwd"), /Invalid board id/);
});

/* ---------- MCP ---------- */

function mcpRequest(payload, { token } = {}) {
  return handleMcp({
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: Buffer.from(JSON.stringify(payload)),
  }, { authorized: true, baseUrl: "http://test" });
}

test("MCP initialize / tools list / create+get round-trip", async () => {
  const init = JSON.parse((await mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).body);
  assert.equal(init.result.serverInfo.name, "lousa");

  const tools = JSON.parse((await mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" })).body);
  assert.deepEqual(tools.result.tools.map(t => t.name).sort(),
    ["create_board", "delete_board", "get_board", "get_selection", "list_boards", "update_board"]);

  const created = JSON.parse((await mcpRequest({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "create_board", arguments: { title: "via mcp", scene: SCENE } },
  })).body);
  const { id, url } = JSON.parse(created.result.content[0].text);
  assert.equal(url, `http://test/b/${id}`);

  const fetched = JSON.parse((await mcpRequest({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "get_board", arguments: { id } },
  })).body);
  assert.equal(JSON.parse(fetched.result.content[0].text).title, "via mcp");
});

test("MCP notification gets 202 and no body", async () => {
  const response = await mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(response.status, 202);
});

/* ---------- core HTTP routing ---------- */

function coreRequest(method, urlPath, { body, query, headers } = {}) {
  return handleRequest({
    method,
    path: urlPath,
    query: new URLSearchParams(query || ""),
    headers: { host: "127.0.0.1:0", ...(headers || {}) },
    body: Buffer.from(body ? JSON.stringify(body) : ""),
  });
}

test("health, static viewer route and 404", async () => {
  assert.equal((await coreRequest("GET", "/api/health")).status, 200);
  const viewer = await coreRequest("GET", "/b/aaaaaaaaaaaa");
  assert.equal(viewer.status, 200);
  assert.match(viewer.headers["content-type"], /text\/html/);
  assert.equal((await coreRequest("GET", "/api/boards/ffffffffffff")).status, 404);
});

test("LOUSA_TOKEN gates global routes but not per-board capability routes", async () => {
  process.env.LOUSA_TOKEN = "secret";
  try {
    assert.equal((await coreRequest("GET", "/api/boards")).status, 401);
    assert.equal((await coreRequest("GET", "/api/boards", { query: "t=secret" })).status, 200);
    assert.equal((await coreRequest("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status, 401);
    const board = await boards.createBoard({ title: "cap", scene: [] });
    assert.equal((await coreRequest("GET", `/api/boards/${board.id}`)).status, 200); // id is the capability
  } finally {
    delete process.env.LOUSA_TOKEN;
  }
});

test("path traversal on static files is blocked", async () => {
  const response = await coreRequest("GET", "/..%2f..%2fetc%2fpasswd");
  assert.ok([400, 403, 404].includes(response.status));
});
