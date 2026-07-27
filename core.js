"use strict";

/* Roteamento HTTP compartilhado entre o servidor local (server.js) e a Lambda (lambda.js).
   reqInfo: { method, path, query (URLSearchParams), headers (minúsculas), body (Buffer) }
   retorno: { status, headers, body (string | Buffer) } */

const fs = require("fs");
const path = require("path");
const boards = require("./boards");
const { handleMcp } = require("./mcp");

const PUBLIC_DIR = path.join(__dirname, "public");
const ROUGH_JS = path.join(__dirname, "node_modules", "roughjs", "bundled", "rough.js");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const json = (status, body) => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

const file = (filePath, type) => {
  try { return { status: 200, headers: { "content-type": type, "cache-control": "no-store" }, body: fs.readFileSync(filePath) }; }
  catch { return { status: 404, headers: { "content-type": "text/plain" }, body: "Not found" }; }
};

function authorized(reqInfo) {
  const token = process.env.LOUSA_TOKEN;
  if (!token) return true; // dev local sem token configurado
  const header = reqInfo.headers["authorization"] || "";
  return header === `Bearer ${token}` || reqInfo.query.get("t") === token;
}

function baseUrlOf(reqInfo) {
  const host = reqInfo.headers["host"] || "127.0.0.1";
  const proto = reqInfo.headers["x-forwarded-proto"] || (host.startsWith("127.") || host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function parseBody(reqInfo) {
  try { return JSON.parse(reqInfo.body.toString("utf8")); }
  catch { throw new Error("Invalid JSON body."); }
}

async function handleRequest(reqInfo) {
  const { method, path: p } = reqInfo;
  const baseUrl = baseUrlOf(reqInfo);

  if (method === "GET" && p === "/api/health") return json(200, { ok: true });

  if (p === "/mcp") return handleMcp(reqInfo, { authorized: authorized(reqInfo), baseUrl });

  if (p === "/api/boards") {
    if (!authorized(reqInfo)) return json(401, { error: "Unauthorized." });
    if (method === "GET") return json(200, await boards.listBoards());
    if (method === "POST") {
      try {
        const board = await boards.createBoard(parseBody(reqInfo));
        return json(201, { id: board.id, url: `${baseUrl}/b/${board.id}`, updatedAt: board.updatedAt });
      } catch (error) { return json(400, { error: error.message }); }
    }
    return json(405, { error: "Method not allowed." });
  }

  const boardMatch = p.match(/^\/api\/boards\/([a-f0-9]{6,32})(\/selection)?$/);
  if (boardMatch) {
    const [, id, isSelection] = boardMatch;

    if (isSelection) {
      if (method === "GET") {
        const selection = await boards.getSelection(id);
        return selection ? json(200, selection) : json(404, { error: "Board not found." });
      }
      if (method === "PUT") {
        try {
          const result = await boards.setSelection(id, parseBody(reqInfo).ids);
          return result ? json(200, result) : json(404, { error: "Board not found." });
        } catch (error) { return json(400, { error: error.message }); }
      }
      return json(405, { error: "Method not allowed." });
    }

    if (method === "GET") {
      const board = await boards.getBoard(id);
      return board ? json(200, board) : json(404, { error: "Board not found." });
    }
    if (method === "PUT") {
      try {
        const board = await boards.updateBoard(id, parseBody(reqInfo));
        return board
          ? json(200, { id, url: `${baseUrl}/b/${id}`, updatedAt: board.updatedAt })
          : json(404, { error: "Board not found." });
      } catch (error) { return json(400, { error: error.message }); }
    }
    if (method === "DELETE") {
      if (!authorized(reqInfo)) return json(401, { error: "Unauthorized." });
      await boards.deleteBoard(id);
      return json(200, { ok: true });
    }
    return json(405, { error: "Method not allowed." });
  }

  if (method !== "GET") return json(405, { error: "Method not allowed." });

  if (/^\/b\/[a-f0-9]{6,32}$/.test(p)) return file(path.join(PUBLIC_DIR, "index.html"), MIME[".html"]);
  if (p === "/vendor/rough.js") return file(ROUGH_JS, MIME[".js"]);

  let requested;
  try { requested = decodeURIComponent(p === "/" ? "/gallery.html" : p); }
  catch { return { status: 400, headers: { "content-type": "text/plain" }, body: "Bad request" }; }
  const resolved = path.join(PUBLIC_DIR, path.normalize(requested));
  if (!resolved.startsWith(PUBLIC_DIR)) return { status: 403, headers: { "content-type": "text/plain" }, body: "Forbidden" };
  return file(resolved, MIME[path.extname(resolved)] || "application/octet-stream");
}

module.exports = { handleRequest };
