"use strict";

/* Board operations shared by the HTTP API and the MCP tools. */

const crypto = require("crypto");
const store = require("./store");

const BOARD_ID = /^[a-f0-9]{6,32}$/;

const DEFAULT_TTL_HOURS = Number(process.env.LOUSA_DEFAULT_TTL_HOURS) || 12;
const MAX_TTL_HOURS = 24 * 30;

function normalizeTtl(value) {
  if (value === undefined || value === null) return DEFAULT_TTL_HOURS;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_TTL_HOURS;
  return hours === 0 ? 0 : Math.min(hours, MAX_TTL_HOURS);
}

/* Expiry slides with updatedAt: a board in use stays alive. ttlHours 0 = permanent. */
function stampExpiry(board) {
  board.ttlHours = normalizeTtl(board.ttlHours);
  board.expiresAt = board.ttlHours === 0
    ? null
    : new Date(Date.parse(board.updatedAt) + board.ttlHours * 3600 * 1000).toISOString();
}

function effectiveExpiresAt(board) {
  if (normalizeTtl(board.ttlHours) === 0) return null;
  return board.expiresAt
    || new Date(Date.parse(board.updatedAt || board.createdAt || Date.now()) + DEFAULT_TTL_HOURS * 3600 * 1000).toISOString();
}

function isExpired(board) {
  const expiresAt = effectiveExpiresAt(board);
  return expiresAt !== null && Date.parse(expiresAt) < Date.now();
}

/* Loads a live board; an expired one is deleted on the spot (lazy cleanup, no cron). */
async function loadAlive(id) {
  const board = await store.get(assertId(id));
  if (!board) return null;
  if (isExpired(board)) {
    await store.remove(board.id);
    console.log(`[board] expired ${board.id} "${board.title}"`);
    return null;
  }
  return board;
}

function sanitizeScene(scene) {
  if (!Array.isArray(scene)) throw new Error("scene must be an array.");
  const seen = new Set();
  return scene.slice(0, 400).map((el, i) => {
    if (!el || typeof el !== "object" || typeof el.type !== "string") return null;
    let id = typeof el.id === "string" && el.id ? el.id.slice(0, 64) : `auto-${i}`;
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    return { ...el, id };
  }).filter(Boolean);
}

function cleanRequests(value) {
  return Array.isArray(value) ? value.slice(-40).map(r => String(r).slice(0, 500)) : [];
}

function assertId(id) {
  if (!BOARD_ID.test(String(id || ""))) throw new Error("Invalid board id.");
  return String(id);
}

async function createBoard({ title, narration, scene, requests, ttlHours }) {
  const board = {
    id: crypto.randomBytes(6).toString("hex"),
    title: String(title || "Untitled").slice(0, 120),
    narration: String(narration || "").slice(0, 600),
    scene: sanitizeScene(scene || []),
    requests: cleanRequests(requests),
    ttlHours,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  stampExpiry(board);
  await store.put(board);
  console.log(`[board] created ${board.id} "${board.title}" (${board.scene.length} els, ttl ${board.ttlHours}h)`);
  return board;
}

async function getBoard(id) {
  return loadAlive(id);
}

async function updateBoard(id, patch) {
  const board = await loadAlive(id);
  if (!board) return null;
  if (patch.scene !== undefined) {
    board.scene = sanitizeScene(patch.scene);
    const sceneIds = new Set(board.scene.map(el => el.id));
    if (Array.isArray(board.selection)) board.selection = board.selection.filter(elId => sceneIds.has(elId));
  }
  if (patch.title !== undefined) board.title = String(patch.title).slice(0, 120);
  if (patch.narration !== undefined) board.narration = String(patch.narration).slice(0, 600);
  if (patch.appendRequest) board.requests = cleanRequests([...(board.requests || []), String(patch.appendRequest)]);
  if (patch.ttlHours !== undefined) board.ttlHours = patch.ttlHours;
  board.updatedAt = new Date().toISOString();
  stampExpiry(board);
  await store.put(board);
  console.log(`[board] updated ${id} (${board.scene.length} els)`);
  return board;
}

async function deleteBoard(id) {
  await store.remove(assertId(id));
  console.log(`[board] deleted ${id}`);
}

async function listBoards() {
  const boards = await store.list();
  const expired = boards.filter(isExpired);
  await Promise.all(expired.map(b => store.remove(b.id).then(() => console.log(`[board] expired ${b.id} "${b.title}"`)).catch(() => {})));
  return boards
    .filter(b => !isExpired(b))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(b => ({
      id: b.id, title: b.title, narration: b.narration,
      elements: (b.scene || []).length, createdAt: b.createdAt, updatedAt: b.updatedAt,
      ttlHours: normalizeTtl(b.ttlHours), expiresAt: effectiveExpiresAt(b),
    }));
}

async function getSelection(id) {
  const board = await loadAlive(id);
  if (!board) return null;
  const selection = Array.isArray(board.selection) ? board.selection : [];
  return {
    selection,
    selectionAt: board.selectionAt || null,
    elements: (board.scene || []).filter(el => selection.includes(el.id)),
  };
}

async function setSelection(id, ids) {
  const board = await loadAlive(id);
  if (!board) return null;
  const sceneIds = new Set((board.scene || []).map(el => el.id));
  board.selection = (Array.isArray(ids) ? ids : []).slice(0, 100).map(String).filter(elId => sceneIds.has(elId));
  board.selectionAt = new Date().toISOString();
  // no updatedAt bump: selection must not re-render viewers
  await store.put(board);
  console.log(`[board] selection ${id}: [${board.selection.join(", ")}]`);
  return { selection: board.selection, selectionAt: board.selectionAt };
}

module.exports = { createBoard, getBoard, updateBoard, deleteBoard, listBoards, getSelection, setSelection, BOARD_ID };
