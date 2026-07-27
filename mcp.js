"use strict";

/* MCP server (streamable HTTP, stateless): JSON-RPC 2.0 over POST /mcp.
   No sessions — every request is independent, which fits Lambda. */

const boards = require("./boards");

const PROTOCOL_VERSION = "2025-06-18";

const COLORS = ["black", "blue", "red", "green", "orange", "purple", "gray"];

const ELEMENT_SCHEMA = {
  type: "object",
  required: ["id", "type"],
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "Stable, unique element id. Keep the same id across updates so the viewer only animates what changed." },
    type: { enum: ["box", "ellipse", "diamond", "cylinder", "arrow", "line", "text", "note"] },
    x: { type: "number" }, y: { type: "number" },
    w: { type: "number" }, h: { type: "number" },
    label: { type: "string", description: "Short label inside a shape (box/ellipse/diamond/cylinder) or on an arrow." },
    text: { type: "string", description: "Content for type=text and type=note." },
    size: { type: "number", description: "type=text only: 16 body, 22 subtitle, 32 title." },
    color: { enum: COLORS },
    fill: { type: "boolean", description: "Light hachure fill on the shape." },
    dashed: { type: "boolean" },
    from: { type: "string", description: "arrow: id of the source element (anchors are computed automatically)." },
    to: { type: "string", description: "arrow: id of the target element." },
    points: {
      type: "array", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      description: "For line, or a free arrow without from/to: [[x,y],...] in board coordinates.",
    },
  },
};

const SCENE_SCHEMA = {
  type: "array",
  items: ELEMENT_SCHEMA,
  description: "The complete scene, in drawing order (titles and shapes before the arrows that connect them).",
};

const DRAWING_GUIDE = `You author the drawing: think like a senior engineer sketching on a whiteboard. Coordinates: x grows right, y grows down; design within ~1600x1000 (exceed if needed). Guidelines: flow left-to-right or top-to-bottom; generous spacing (>=60 between shapes); few colors with meaning (blue components, green happy path, red errors/bottlenecks, gray context, purple storage); short labels; title via type=text size=32; caveats as type=note; prefer arrows with from/to (ids). cylinder = database/storage, diamond = decision. Label language = the conversation's language. The viewer renders with a hand-drawn stroke and animates elements in sequence.`;

const TOOLS = [
  {
    name: "create_board",
    description: `Creates a board (a hand-drawn visual explanation) on Lousa and returns {id, url}. Open/share the url with the user — the drawing animates in as if sketched live. ${DRAWING_GUIDE}`,
    inputSchema: {
      type: "object",
      required: ["title", "scene"],
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Short board title." },
        narration: { type: "string", description: "1-2 sentences about what the drawing shows (shown as a card in the viewer)." },
        scene: SCENE_SCHEMA,
        requests: { type: "array", items: { type: "string" }, description: "The user request(s) that originated the board." },
        ttlHours: { type: "number", description: "Hours until the board expires and is deleted (default 12; 0 = permanent; max 720). Expiry slides on every update. Use 0 only if the user asks to keep the board." },
      },
    },
  },
  {
    name: "update_board",
    description: "Updates an existing board. The scene you send REPLACES the current one entirely: keep unchanged elements byte-identical (same id and fields) — the viewer animates only what changed, live in the user's open tab; to remove an element, omit it. If the user's request references something they pointed at (\"what I selected\", \"this part\"), call get_selection first to learn the target.",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        scene: SCENE_SCHEMA,
        title: { type: "string" },
        narration: { type: "string" },
        appendRequest: { type: "string", description: "The user's follow-up request, for the board history." },
        ttlHours: { type: "number", description: "Changes expiry (default 12h since last update; 0 = permanent). Use 0 when the user asks to keep/pin the board." },
      },
    },
  },
  {
    name: "get_board",
    description: "Reads a full board (title, narration, scene, requests, selection).",
    inputSchema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } },
  },
  {
    name: "list_boards",
    description: "Lists existing boards (id, title, narration, element count, dates).",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "get_selection",
    description: "Returns what the user selected in the viewer (click toggles; Esc clears): {selection: ids, selectionAt, elements}. Use when the user references \"what I selected\" / \"this part\" — those elements are the target of the request. An old selectionAt may be residue from a previous request; when in doubt, confirm the target.",
    inputSchema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } },
  },
  {
    name: "delete_board",
    description: "Deletes a board permanently.",
    inputSchema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } },
  },
];

async function callTool(name, args, baseUrl) {
  const boardUrl = id => `${baseUrl}/b/${id}`;
  switch (name) {
    case "create_board": {
      const board = await boards.createBoard(args || {});
      return { id: board.id, url: boardUrl(board.id) };
    }
    case "update_board": {
      const { id, ...patch } = args || {};
      const board = await boards.updateBoard(id, patch);
      if (!board) throw new Error(`Board ${id} not found.`);
      return { id: board.id, url: boardUrl(board.id), elements: board.scene.length, updatedAt: board.updatedAt };
    }
    case "get_board": {
      const board = await boards.getBoard(args?.id);
      if (!board) throw new Error(`Board ${args?.id} not found.`);
      return { ...board, url: boardUrl(board.id) };
    }
    case "list_boards": {
      const list = await boards.listBoards();
      return list.map(b => ({ ...b, url: boardUrl(b.id) }));
    }
    case "get_selection": {
      const selection = await boards.getSelection(args?.id);
      if (!selection) throw new Error(`Board ${args?.id} not found.`);
      return selection;
    }
    case "delete_board": {
      await boards.deleteBoard(args?.id);
      return { ok: true };
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

async function handleRpc(message, baseUrl) {
  const { id, method, params } = message || {};
  const reply = result => ({ jsonrpc: "2.0", id, result });
  const fail = (code, msg) => ({ jsonrpc: "2.0", id, error: { code, message: msg } });

  if (id === undefined || id === null) return null; // notification — no reply

  try {
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "lousa", title: "Lousa — a whiteboard where AI agents draw", version: "0.1.0" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        try {
          const result = await callTool(params?.name, params?.arguments, baseUrl);
          return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        } catch (error) {
          return reply({ content: [{ type: "text", text: `Error: ${error.message}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    return fail(-32603, error.message);
  }
}

/* HTTP entrypoint: reqInfo {method, headers, body Buffer} → {status, headers, body} */
async function handleMcp(reqInfo, { authorized, baseUrl }) {
  const jsonResponse = (status, body) => ({
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body),
  });

  if (!authorized) return jsonResponse(401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized. Pass Authorization: Bearer <token> or ?t=<token>." } });
  if (reqInfo.method !== "POST") return { status: 405, headers: { allow: "POST" }, body: "Method Not Allowed" };

  let payload;
  try { payload = JSON.parse(reqInfo.body.toString("utf8")); }
  catch { return jsonResponse(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }

  if (Array.isArray(payload)) {
    const replies = (await Promise.all(payload.map(m => handleRpc(m, baseUrl)))).filter(Boolean);
    return replies.length ? jsonResponse(200, replies) : { status: 202, headers: {}, body: "" };
  }
  const reply = await handleRpc(payload, baseUrl);
  return reply ? jsonResponse(200, reply) : { status: 202, headers: {}, body: "" };
}

module.exports = { handleMcp };
