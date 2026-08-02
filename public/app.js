"use strict";

const svg = document.getElementById("svg");
const world = document.getElementById("world");
const overlay = document.getElementById("overlay");
const rc = rough.svg(svg);
const NS = "http://www.w3.org/2000/svg";

const COLORS = {
  black: "#1f2430", blue: "#2557d6", red: "#d63b3b", green: "#1f9d55",
  orange: "#e08a00", purple: "#7b46c4", gray: "#8a919c",
};
const FILLS = {
  black: "#e9eaee", blue: "#e4ebfb", red: "#fbe6e6", green: "#e3f4ea",
  orange: "#fbf0dc", purple: "#efe6fa", gray: "#eef0f2",
};

let scene = [];
let prevJson = new Map();          // id -> JSON.stringify(el) of the last render
let view = { x: -100, y: -80, w: 1800, h: 1125 };
let boardId = (location.pathname.match(/^\/b\/([a-f0-9]{6,32})$/) || [])[1] || null;
let boardUpdatedAt = null;
let selected = new Set();          // ids the user marked as reference for the agent

/* ---------- utilities ---------- */

const hashSeed = str => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2 ** 31 || 7;
};

const colorOf = el => COLORS[el.color] || COLORS.black;
const fillOf = el => FILLS[el.color] || FILLS.black;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function roughOpts(el, extra = {}) {
  return {
    seed: hashSeed(el.id),
    roughness: 1.4,
    bowing: 1,
    stroke: colorOf(el),
    strokeWidth: 2,
    ...extra,
  };
}

const CHAR_W = 0.62; // average char width of the handwritten font

function wrapLines(content, maxWidth, fontSize) {
  const perLine = maxWidth > 0 ? Math.max(3, Math.floor(maxWidth / (fontSize * CHAR_W))) : Infinity;
  const lines = [];
  for (const paragraph of String(content).split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (let word of words) {
      while (word.length > perLine) { // unbreakable token longer than the line: hard break
        if (line) { lines.push(line); line = ""; }
        lines.push(word.slice(0, perLine));
        word = word.slice(perLine);
      }
      if (!word) continue;
      if (line && line.length + 1 + word.length > perLine) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function makeText(x, y, content, { size = 16, color = COLORS.black, anchor = "middle", maxWidth = 0, maxHeight = 0, minSize = 9 } = {}) {
  const wrap = fontSize => wrapLines(content, maxWidth, fontSize);

  // Shrink the font until the line block fits the available height.
  let fontSize = size;
  let lines = wrap(fontSize);
  while (maxHeight > 0 && fontSize > minSize && lines.length * fontSize * 1.25 > maxHeight) {
    fontSize -= 1;
    lines = wrap(fontSize);
  }

  const text = document.createElementNS(NS, "text");
  text.setAttribute("x", x);
  text.setAttribute("y", y);
  text.setAttribute("fill", color);
  text.setAttribute("font-size", fontSize);
  text.setAttribute("text-anchor", anchor);
  // Without this the alphabetic baseline shifts the block ~0.35em above the requested center.
  text.setAttribute("dominant-baseline", "central");
  const lineHeight = fontSize * 1.25;
  const y0 = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((lineText, i) => {
    const tspan = document.createElementNS(NS, "tspan");
    tspan.setAttribute("x", x);
    tspan.setAttribute("y", y0 + i * lineHeight);
    tspan.textContent = lineText;
    text.appendChild(tspan);
  });
  return text;
}

/* ---------- geometry (arrow anchors) ---------- */

const NOTE_FONT = 14;

function geometryOf(el) {
  if (["box", "ellipse", "diamond", "cylinder", "note"].includes(el.type)) {
    const geometry = { x: num(el.x), y: num(el.y), w: num(el.w, 120), h: num(el.h, 60) };
    if (el.type === "note" && el.text) {
      // Notes carry prose: grow vertically to fit readable text instead of shrinking it.
      const needed = wrapLines(el.text, geometry.w - 20, NOTE_FONT).length * NOTE_FONT * 1.25 + 20;
      geometry.h = Math.max(geometry.h, Math.ceil(needed));
    }
    return geometry;
  }
  return null;
}

function anchorPoint(geometry, towards) {
  const cx = geometry.x + geometry.w / 2, cy = geometry.y + geometry.h / 2;
  const dx = towards.x - cx, dy = towards.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const scaleX = dx ? (geometry.w / 2 + 8) / Math.abs(dx) : Infinity;
  const scaleY = dy ? (geometry.h / 2 + 8) / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/* ---------- drawing each element type ---------- */

function drawElement(el, geometryMap) {
  const group = document.createElementNS(NS, "g");
  group.dataset.id = el.id;
  const color = colorOf(el);

  if (el.type === "box" || el.type === "note") {
    const { x, y, w, h } = geometryOf(el);
    const isNote = el.type === "note";
    const opts = roughOpts(el, isNote
      ? { fill: "#fff8b8", fillStyle: "solid", stroke: "#c9b458" }
      : el.fill ? { fill: fillOf(el), fillStyle: "hachure", fillWeight: 1, hachureGap: 7 } : {});
    group.appendChild(rc.rectangle(x, y, w, h, opts));
    const label = isNote ? el.text : el.label;
    if (label) group.appendChild(makeText(x + w / 2, y + h / 2, label, {
      size: isNote ? NOTE_FONT : 16, color: isNote ? "#6b5d1f" : color,
      maxWidth: w - 20, maxHeight: h - 14, minSize: isNote ? 12 : 9,
    }));
  }

  else if (el.type === "ellipse") {
    const { x, y, w, h } = geometryOf(el);
    const opts = roughOpts(el, el.fill ? { fill: fillOf(el), fillStyle: "hachure", fillWeight: 1, hachureGap: 7 } : {});
    group.appendChild(rc.ellipse(x + w / 2, y + h / 2, w, h, opts));
    if (el.label) group.appendChild(makeText(x + w / 2, y + h / 2, el.label, { color, maxWidth: w * 0.72, maxHeight: h * 0.7 }));
  }

  else if (el.type === "diamond") {
    const { x, y, w, h } = geometryOf(el);
    const points = [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
    const opts = roughOpts(el, el.fill ? { fill: fillOf(el), fillStyle: "hachure", fillWeight: 1, hachureGap: 7 } : {});
    group.appendChild(rc.polygon(points, opts));
    if (el.label) group.appendChild(makeText(x + w / 2, y + h / 2, el.label, { color, maxWidth: w * 0.55, maxHeight: h * 0.55 }));
  }

  else if (el.type === "cylinder") {
    const { x, y, w, h } = geometryOf(el);
    const ry = Math.min(18, h / 4);
    const d = `M ${x} ${y + ry}
      A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry}
      L ${x + w} ${y + h - ry}
      A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z
      M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}`;
    group.appendChild(rc.path(d, roughOpts(el)));
    // Safe text zone: below the top ellipse (2*ry) and above the bottom arc (ry).
    if (el.label) group.appendChild(makeText(x + w / 2, y + ry * 2 + (h - ry * 3) / 2, el.label, { color, maxWidth: w - 24, maxHeight: h - ry * 3 - 6 }));
  }

  else if (el.type === "arrow" || el.type === "line") {
    let points = Array.isArray(el.points) ? el.points.map(p => ({ x: num(p[0]), y: num(p[1]) })) : [];
    if (el.type === "arrow" && el.from && el.to) {
      const gFrom = geometryMap.get(el.from), gTo = geometryMap.get(el.to);
      if (!gFrom || !gTo) return null;
      const centerFrom = { x: gFrom.x + gFrom.w / 2, y: gFrom.y + gFrom.h / 2 };
      const centerTo = { x: gTo.x + gTo.w / 2, y: gTo.y + gTo.h / 2 };
      points = [anchorPoint(gFrom, centerTo), anchorPoint(gTo, centerFrom)];
    }
    if (points.length < 2) return null;
    const opts = roughOpts(el, el.dashed ? { strokeLineDash: [8, 6] } : {});
    group.appendChild(rc.linearPath(points.map(p => [p.x, p.y]), opts));
    if (el.type === "arrow") {
      const tip = points[points.length - 1], before = points[points.length - 2];
      const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
      const headLen = 14;
      for (const spread of [Math.PI / 7, -Math.PI / 7]) {
        group.appendChild(rc.line(
          tip.x, tip.y,
          tip.x - headLen * Math.cos(angle - spread),
          tip.y - headLen * Math.sin(angle - spread),
          roughOpts(el)));
      }
    }
    if (el.label) {
      const mid = points[Math.floor((points.length - 1) / 2)];
      const midNext = points[Math.min(Math.floor((points.length - 1) / 2) + 1, points.length - 1)];
      const lx = (mid.x + midNext.x) / 2, ly = (mid.y + midNext.y) / 2 - 8;
      const bg = document.createElementNS(NS, "rect");
      const labelText = makeText(lx, ly, el.label, { size: 13, color, maxWidth: 190 });
      group.appendChild(bg);
      group.appendChild(labelText);
      requestAnimationFrame(() => {
        const bb = labelText.getBBox();
        bg.setAttribute("x", bb.x - 5); bg.setAttribute("y", bb.y - 3);
        bg.setAttribute("width", bb.width + 10); bg.setAttribute("height", bb.height + 6);
        bg.setAttribute("fill", "#fbfaf7"); bg.setAttribute("rx", 4);
      });
    }
  }

  else if (el.type === "text") {
    group.appendChild(makeText(num(el.x), num(el.y), el.text || "", {
      size: num(el.size, 16), color, anchor: "start" in el ? el.start : "middle",
    }));
  }

  else return null;

  return group;
}

/* ---------- selection (user reference for the agent) ---------- */

/* Our own geometric hit-test in world coordinates — native SVG hit-testing
   fails for transparent strokes on synthesized/composited events. */

function arrowPointsOf(el, geometryMap) {
  if (el.type === "arrow" && el.from && el.to) {
    const gFrom = geometryMap.get(el.from), gTo = geometryMap.get(el.to);
    if (!gFrom || !gTo) return null;
    const centerFrom = { x: gFrom.x + gFrom.w / 2, y: gFrom.y + gFrom.h / 2 };
    const centerTo = { x: gTo.x + gTo.w / 2, y: gTo.y + gTo.h / 2 };
    return [anchorPoint(gFrom, centerTo), anchorPoint(gTo, centerFrom)];
  }
  if (Array.isArray(el.points) && el.points.length >= 2)
    return el.points.map(p => ({ x: num(p[0]), y: num(p[1]) }));
  return null;
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function hitTest(px, py) {
  const rect = svg.getBoundingClientRect();
  const tolerance = 12 * (view.w / rect.width); // ~12 screen px, in world units
  const geometryMap = new Map();
  for (const el of scene) {
    const geometry = geometryOf(el);
    if (geometry) geometryMap.set(el.id, geometry);
  }
  for (let i = scene.length - 1; i >= 0; i--) { // topmost first (reverse drawing order)
    const el = scene[i];
    if (el.type === "arrow" || el.type === "line") {
      const points = arrowPointsOf(el, geometryMap);
      if (!points) continue;
      for (let s = 0; s < points.length - 1; s++)
        if (distToSegment(px, py, points[s], points[s + 1]) <= tolerance) return el.id;
    } else {
      const node = world.querySelector(`g[data-id="${CSS.escape(el.id)}"]`);
      if (!node) continue;
      let bb;
      try { bb = node.getBBox(); } catch { continue; }
      if (px >= bb.x - 6 && px <= bb.x + bb.width + 6 && py >= bb.y - 6 && py <= bb.y + bb.height + 6) return el.id;
    }
  }
  return null;
}

function toWorld(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  return {
    x: view.x + (clientX - rect.left) / rect.width * view.w,
    y: view.y + (clientY - rect.top) / rect.height * view.h,
  };
}

let selectionTimer = null;
function pushSelection() {
  if (!boardId) return;
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(async () => {
    try {
      await fetch(`/api/boards/${boardId}/selection`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
    } catch { /* best-effort */ }
  }, 350);
}

function syncSelection() {
  overlay.innerHTML = "";
  for (const id of [...selected]) {
    const node = world.querySelector(`g[data-id="${CSS.escape(id)}"]`);
    if (!node) { selected.delete(id); continue; }
    let bb;
    try { bb = node.getBBox(); } catch { continue; }
    const outline = document.createElementNS(NS, "rect");
    outline.setAttribute("x", bb.x - 9); outline.setAttribute("y", bb.y - 9);
    outline.setAttribute("width", bb.width + 18); outline.setAttribute("height", bb.height + 18);
    outline.setAttribute("rx", 8);
    outline.setAttribute("fill", "none");
    outline.setAttribute("stroke", "#2557d6");
    outline.setAttribute("stroke-width", "2");
    outline.setAttribute("stroke-dasharray", "7 5");
    outline.style.pointerEvents = "none";
    overlay.appendChild(outline);
  }
  setStatus(selected.size
    ? `${selected.size} selected as reference — Esc clears`
    : "ready", selected.size ? "busy" : "idle");
  pushSelection();
}

function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  syncSelection();
}

window.addEventListener("keydown", event => {
  if (event.key === "Escape" && selected.size) { selected.clear(); syncSelection(); }
});

/* ---------- render + animation ---------- */

function renderScene(newScene, { animate = true } = {}) {
  const geometryMap = new Map();
  for (const el of newScene) {
    const geometry = geometryOf(el);
    if (geometry) geometryMap.set(el.id, geometry);
  }

  const newIds = new Set(newScene.map(el => el.id));
  const oldNodes = new Map([...world.children].map(node => [node.dataset.id, node]));

  for (const [id, node] of oldNodes) {
    if (!newIds.has(id)) {
      node.style.transition = "opacity .4s";
      node.style.opacity = "0";
      setTimeout(() => node.remove(), 450);
    }
  }

  const toReveal = [];
  for (const el of newScene) {
    const json = JSON.stringify(el);
    const existing = oldNodes.get(el.id);
    if (existing && prevJson.get(el.id) === json) {
      world.appendChild(existing); // unchanged: keep node, just reorder
      continue;
    }
    existing?.remove();
    const node = drawElement(el, geometryMap);
    if (!node) continue;
    world.appendChild(node);
    if (animate) { node.style.opacity = "0"; toReveal.push(node); }
  }

  prevJson = new Map(newScene.map(el => [el.id, JSON.stringify(el)]));
  scene = newScene;

  syncSelection(); // prune ids gone from the scene and redraw outlines

  if (toReveal.length) revealSequentially(toReveal);
  fitView();
}

async function revealSequentially(nodes) {
  for (const node of nodes) {
    node.style.opacity = "1";
    const paths = [...node.querySelectorAll("path, line")];
    const texts = [...node.querySelectorAll("text, rect")];
    texts.forEach(t => { t.style.opacity = "0"; });
    const duration = Math.min(650, 250 + paths.length * 40);
    paths.forEach((p, i) => {
      let len = 0;
      try { len = p.getTotalLength(); } catch {}
      if (!len) return;
      p.style.strokeDasharray = len;
      p.style.strokeDashoffset = len;
      p.getBoundingClientRect();
      p.style.transition = `stroke-dashoffset ${duration}ms ease ${i * 30}ms`;
      p.style.strokeDashoffset = "0";
    });
    await new Promise(r => setTimeout(r, duration * 0.7));
    texts.forEach(t => { t.style.transition = "opacity .3s"; t.style.opacity = "1"; });
    await new Promise(r => setTimeout(r, 120));
    setTimeout(() => paths.forEach(p => {
      p.style.strokeDasharray = ""; p.style.strokeDashoffset = ""; p.style.transition = "";
    }), duration + 400);
  }
}

/* ---------- viewport (pan / zoom / fit) ---------- */

function applyView() {
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
}

function sceneBBox() {
  if (!scene.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of scene) {
    const geometry = geometryOf(el);
    const points = geometry
      ? [[geometry.x, geometry.y], [geometry.x + geometry.w, geometry.y + geometry.h]]
      : el.type === "text"
        ? [[num(el.x) - 150, num(el.y) - 30], [num(el.x) + 150, num(el.y) + 10]]
        : (el.points || []).map(p => [num(p[0]), num(p[1])]);
    for (const [px, py] of points) {
      minX = Math.min(minX, px); minY = Math.min(minY, py);
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
    }
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

function fitView() {
  const bb = sceneBBox();
  if (!bb) return;
  const pad = 90;
  const rect = svg.getBoundingClientRect();
  const aspect = rect.width / rect.height;
  let w = Math.max(bb.w + pad * 2, 700);
  let h = Math.max(bb.h + pad * 2, 700 / aspect);
  if (w / h > aspect) h = w / aspect; else w = h * aspect;
  const target = { x: bb.x + bb.w / 2 - w / 2, y: bb.y + bb.h / 2 - h / 2, w, h };
  const start = { ...view }, t0 = performance.now(), D = 350;
  const step = now => {
    const t = Math.min(1, (now - t0) / D), e = 1 - (1 - t) ** 3;
    view = {
      x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e,
      w: start.w + (target.w - start.w) * e, h: start.h + (target.h - start.h) * e,
    };
    applyView();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

svg.addEventListener("wheel", event => {
  event.preventDefault();
  const rect = svg.getBoundingClientRect();
  const mx = view.x + (event.clientX - rect.left) / rect.width * view.w;
  const my = view.y + (event.clientY - rect.top) / rect.height * view.h;
  const factor = event.deltaY > 0 ? 1.1 : 1 / 1.1;
  view.w *= factor; view.h *= factor;
  view.x = mx - (mx - view.x) * factor;
  view.y = my - (my - view.y) * factor;
  applyView();
}, { passive: false });

let pan = null;
svg.addEventListener("pointerdown", event => {
  pan = { px: event.clientX, py: event.clientY, vx: view.x, vy: view.y };
  svg.classList.add("panning");
  svg.setPointerCapture(event.pointerId);
});
svg.addEventListener("pointermove", event => {
  if (!pan) return;
  const rect = svg.getBoundingClientRect();
  view.x = pan.vx - (event.clientX - pan.px) / rect.width * view.w;
  view.y = pan.vy - (event.clientY - pan.py) / rect.height * view.h;
  applyView();
});
svg.addEventListener("pointerup", event => {
  const wasClick = pan && Math.hypot(event.clientX - pan.px, event.clientY - pan.py) < 5;
  pan = null;
  svg.classList.remove("panning");
  if (!wasClick) return;
  const point = toWorld(event.clientX, event.clientY);
  const id = hitTest(point.x, point.y);
  if (id) toggleSelect(id);
  else if (selected.size) { selected.clear(); syncSelection(); }
});

/* ---------- UI ---------- */

const statusEl = document.getElementById("status");
const narrationEl = document.getElementById("narration");
const toastEl = document.getElementById("toast");

function setStatus(text, cls = "idle") {
  statusEl.textContent = text;
  statusEl.className = cls;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastEl.hidden = true; }, 8000);
}

function showNarration(text, seconds) {
  if (!text) return;
  narrationEl.innerHTML = "";
  narrationEl.append(text);
  if (seconds != null) {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${seconds}s`;
    narrationEl.appendChild(meta);
  }
  narrationEl.hidden = false;
}

function setBoardTitle(title) {
  if (!title) return;
  document.title = `${title} — Lousa`;
  document.getElementById("boardTitle").textContent = title;
}

/* ---------- board (source: agents via API) ---------- */

async function loadBoard() {
  if (!boardId) return;
  try {
    const response = await fetch(`/api/boards/${boardId}`);
    if (!response.ok) throw new Error("Board not found.");
    const board = await response.json();
    boardUpdatedAt = board.updatedAt;
    selected = new Set(board.selection || []);
    setBoardTitle(board.title);
    showNarration(board.narration);
    renderScene(board.scene || []);
  } catch (error) { toast(error.message); }
}

/* Live-update: an agent may edit this board via PUT — reflect it on screen. */
setInterval(async () => {
  if (!boardId) return;
  try {
    const response = await fetch(`/api/boards/${boardId}`);
    if (!response.ok) return;
    const board = await response.json();
    if (board.updatedAt === boardUpdatedAt) return;
    boardUpdatedAt = board.updatedAt;
    setBoardTitle(board.title);
    showNarration(board.narration);
    renderScene(board.scene || []);
    setStatus(`updated ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`, "idle");
  } catch { /* servidor pode estar reiniciando */ }
}, 3000);

document.getElementById("fitBtn").addEventListener("click", fitView);

document.getElementById("exportBtn").addEventListener("click", () => {
  const bb = sceneBBox();
  if (!bb) return toast("Nothing to export yet.");
  const pad = 60;
  const clone = svg.cloneNode(true);
  clone.setAttribute("viewBox", `${bb.x - pad} ${bb.y - pad} ${bb.w + pad * 2} ${bb.h + pad * 2}`);
  clone.setAttribute("width", (bb.w + pad * 2) * 2);
  clone.setAttribute("height", (bb.h + pad * 2) * 2);
  const style = document.createElementNS(NS, "style");
  style.textContent = `text{font-family:"Segoe Print","Bradley Hand","Comic Sans MS",cursive}`;
  clone.prepend(style);
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.width; canvas.height = img.height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fbfaf7";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const a = document.createElement("a");
    a.download = "lousa.png";
    a.href = canvas.toDataURL("image/png");
    a.click();
  };
  img.src = url;
});

applyView();
loadBoard();
