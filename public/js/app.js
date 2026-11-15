// NightTrace interface. Data flow:
//   manifest (example file or /api) -> NTF1 frames -> shared stretch -> canvases
//   A/B selection -> checks (checks.js) -> marks in RA/Dec -> URL state / card / JSON.
import { t, setLang, getLang, uiLang, FULL, AUTO, num, pct, duration, dateUTC, DICTS } from "./i18n.js";
import { makeGrid, fmtRA, fmtDec, fmtDeg } from "./sky.js";
import { decodeNTF, gunzipIfNeeded, CAT } from "./ntf.js";
import { frameStats, sharedStretch, renderGray, renderDifference, residualShift, pairChecks, candidateFacts, bandOverlap, STATUS } from "./checks.js";
import { encodeHash, decodeHash, parseImport, validateState, StateError, CATEGORIES, LIMITS, EXPORT_FORMAT, STATE_VERSION } from "./state.js";
import { EXAMPLES, UNAVAILABLE, MANIFESTS, MAP_PLACES } from "./examples.js";

const APP_VERSION = "1.0.0";
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem("nighttrace." + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("nighttrace." + k, v); } catch { /* optional */ } },
};

// DOM helper: strings always become text nodes (user text is never parsed as HTML).
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const safeHref = (u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch { return null; } };

const S = {
  field: null, frames: [], grid: null, stretch: null, contrast: "normal",
  a: 0, b: 1, mode: "swipe", tool: "inspect", slot: "b", blinkShow: 0, blinkTimer: null, blinkMs: 600, blinkOn: true,
  view: { scale: 1, tx: 0, ty: 0 }, split: 0.5,
  candidates: [], active: null, nextId: 1, note: "",
  pair: null, shiftCache: new Map(), loadSeq: 0, coach: 0, diffCanvas: null,
};

/* ---------------- i18n binding ---------------- */
function applyStaticText() {
  document.documentElement.lang = uiLang();
  document.title = t("app.title");
  document.querySelector('meta[name="description"]').content = t("app.description");
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-label]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nLabel)); el.title = t(el.dataset.i18nLabel); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $("markList").dataset.empty = t("marks.empty");
  const note = $("langNote");
  note.hidden = FULL.includes(getLang());
  note.textContent = t("settings.autoNote");
  fillBands();
  renderExamples();
  drawMap();
}

function setupSettings() {
  const sel = $("langSel");
  const full = h("optgroup", { label: "" }), auto = h("optgroup", { label: "" });
  for (const code of FULL) full.append(h("option", { value: code, lang: code }, code === "ru" ? "Русский" : "English"));
  for (const code of AUTO) {
    let name = code; try { name = new Intl.DisplayNames([code], { type: "language" }).of(code); } catch { /* keep code */ }
    auto.append(h("option", { value: code, lang: code }, name));
  }
  sel.append(full, auto);
  const label = () => { full.label = t("settings.full"); auto.label = t("settings.auto"); };
  const saved = store.get("lang");
  const browserRu = /^(ru|be|uk|kk|ky)\b/i.test(navigator.language || "ru");
  setLang(saved || (browserRu ? "ru" : "en"));
  sel.value = getLang();
  sel.onchange = () => { setLang(sel.value); store.set("lang", sel.value); label(); applyStaticText(); refreshAll(); };
  label();
  const theme = $("themeSel");
  theme.value = store.get("theme") || "system";
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => { const v = theme.value; document.documentElement.dataset.theme = v === "system" ? (mq.matches ? "dark" : "light") : v; };
  theme.onchange = () => { store.set("theme", theme.value); apply(); };
  mq.addEventListener("change", apply);
  apply();
  const btn = $("settingsBtn"), menu = $("settingsMenu");
  btn.onclick = () => { menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); };
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest(".settings")) { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { menu.hidden = true; btn.focus(); } });
}

/* ---------------- Veil (loading / errors on the image) ---------------- */
function veil(content) {
  const v = $("veil");
  if (!content) { v.hidden = true; v.replaceChildren(); return; }
  v.hidden = false;
  v.replaceChildren(h("div", { class: "box" }, ...content));
}
function veilError(message, actions = []) {
  veil([h("p", { class: "err" }, message), h("div", { class: "search-actions" }, ...actions)]);
}

/* ---------------- Network ---------------- */
class FetchError extends Error { constructor(kind, status, body) { super(kind); this.kind = kind; this.status = status; this.body = body; } }

async function fetchRetry(url, { signal, onRetry, max = 2, binary = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal, headers: binary ? {} : { Accept: "application/json" } });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (attempt >= max) throw new FetchError("network", 0);
      onRetry?.(attempt + 1, max); await sleep(1500 * (attempt + 1), signal); continue;
    }
    if (res.ok) return res;
    let body = null; try { body = await res.json(); } catch { /* not JSON */ }
    const transient = [429, 502, 503, 504].includes(res.status);
    if (!transient || attempt >= max) throw new FetchError(res.status === 429 ? "rate" : res.status === 404 && !body ? "nobackend" : "http", res.status, body);
    const wait = Math.min(20, +res.headers.get("Retry-After") || 2 * (attempt + 1)) * 1000;
    onRetry?.(attempt + 1, max); await sleep(wait, signal);
  }
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const id = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(id); reject(new DOMException("aborted", "AbortError")); }, { once: true });
});

function errorText(e) {
  if (e instanceof FetchError) {
    if (e.kind === "rate") return t("error.rate");
    if (e.kind === "nobackend") return t("error.noBackend");
    if (e.kind === "network") return t("error.network");
    if (e.body?.state === "invalid") return t("search.invalid");
    return t("error.archive");
  }
  return t("error.archive");
}

/* ---------------- Loading a set of frames ---------------- */
async function loadFrames(manifest, { signal, onProgress }) {
  const infos = [...manifest.frames].sort((x, y) => Date.parse(x.date_avg) - Date.parse(y.date_avg));
  const out = new Array(infos.length);
  let done = 0, next = 0;
  const worker = async () => {
    while (next < infos.length) {
      const i = next++, info = infos[i];
      const url = info.file ? info.file : `/api/frame?${new URLSearchParams({ ra: manifest.field.ra, dec: manifest.field.dec, id: info.id })}`;
      let res;
      try { res = await fetchRetry(url, { signal, binary: true }); } catch (e) { if (e.name === "AbortError") throw e; e.frameId = info.obsid; throw e; }
      const frame = decodeNTF(await gunzipIfNeeded(await res.arrayBuffer()));
      if (frame.width !== manifest.grid.size) throw Object.assign(new Error("size"), { frameId: info.obsid });
      frame.info = info;
      frame.stats = frameStats(frame);
      out[i] = frame;
      onProgress?.(++done, infos.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

async function openManifest(manifest, opts = {}) {
  const seq = ++S.loadSeq;
  stopBlink();
  const controller = new AbortController();
  S.loadAbort?.abort(); S.loadAbort = controller;
  veil([h("p", {}, t("stage.frames", { done: 0, total: manifest.frames.length }))]);
  let frames;
  try {
    frames = await loadFrames(manifest, { signal: controller.signal,
      onProgress: (d, n) => { if (seq === S.loadSeq) veil([h("p", {}, t("stage.frames", { done: d, total: n }))]); } });
  } catch (e) {
    if (e.name === "AbortError" || seq !== S.loadSeq) return false;
    veilError(t("error.frame", { id: e.frameId || "?" }) + " " + errorText(e),
      [h("button", { class: "btn", type: "button", onclick: () => openManifest(manifest, opts) }, t("action.retry"))]);
    return false;
  }
  if (seq !== S.loadSeq) return false;
  veil([h("p", {}, t("stage.prepare"))]);
  await new Promise((r) => requestAnimationFrame(r));
  S.manifest = manifest;
  S.frames = frames;
  S.grid = makeGrid(manifest.grid);
  S.field = opts.field;
  S.shiftCache.clear();
  S.candidates = []; S.active = null; S.nextId = 1; S.note = "";
  if (opts.contrast) { S.contrast = opts.contrast; $("contrastSel").value = opts.contrast; }
  restyle();
  const find = (sel, fallback) => {
    if (sel === "first") return 0; if (sel === "last") return frames.length - 1;
    const i = frames.findIndex((f) => f.info.id === sel || f.info.obsid === sel);
    return i >= 0 ? i : fallback;
  };
  S.a = find(opts.a ?? "first", 0); S.b = find(opts.b ?? "last", frames.length - 1);
  if (S.a === S.b) S.b = S.a === 0 ? 1 : 0;
  if (opts.marks) {
    for (const m of opts.marks) {
      const id = S.nextId++;
      S.candidates.push({ id, c: m.c, points: m.p.map(([frame, ra, dec]) => ({ frame, ra, dec })) });
      S.active = id;
    }
  }
  S.note = opts.note || "";
  $("noteIn").value = S.note;
  S.mode = "swipe";
  setTool("inspect");
  veil(null);
  if (opts.view) applyView(opts.view);
  else { fit(); if (opts.zoom) zoomAt(opts.zoom, ...viewCenter()); }
  refreshAll();
  // The requested mode is applied only after the pair checks exist, so a saved "difference"
  // is restored when (and only when) the restored pair allows it.
  setMode(opts.mode || "swipe", true);
  saveUrl();
  return true;
}

function restyle() {
  S.stretch = sharedStretch(S.frames, S.contrast);
  for (const f of S.frames) {
    const c = f.canvas || (f.canvas = document.createElement("canvas"));
    c.width = f.width; c.height = f.height;
    const ctx = c.getContext("2d"), img = ctx.createImageData(f.width, f.height);
    renderGray(f, S.stretch, img.data);
    ctx.putImageData(img, 0, 0);
  }
  S.diffKey = null;
}

/* ---------------- Examples, search, restore ---------------- */
const manifestCache = new Map();
async function getExampleManifest(name, signal) {
  if (manifestCache.has(name)) return manifestCache.get(name);
  const res = await fetchRetry(`data/examples/${name}/manifest.json`, { signal });
  const m = await res.json();
  manifestCache.set(name, m);
  return m;
}

async function openExample(id, extra = {}) {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) { veilError(t("error.unknownExample"), [exampleButton()]); return false; }
  closeRegion();
  veil([h("p", {}, t("viewer.loading"))]);
  let m;
  try { m = await getExampleManifest(ex.manifest); } catch (e) { veilError(errorText(e), [h("button", { class: "btn", type: "button", onclick: () => openExample(id, extra) }, t("action.retry"))]); return false; }
  if (extra.requireIds && !extra.requireIds.every((tok) => m.frames.some((f) => f.id === tok))) { veilError(t("error.mismatch"), [exampleButton()]); return false; }
  return openManifest(m, { field: { kind: "example", ex: ex.manifest, preset: id, ra: m.field.ra, dec: m.field.dec, title: m.title },
    a: extra.a ?? ex.a, b: extra.b ?? ex.b, mode: extra.mode ?? ex.mode, marks: extra.marks, note: extra.note, zoom: ex.zoom,
    contrast: extra.contrast, view: extra.view });
}
const exampleButton = () => h("button", { class: "btn", type: "button", onclick: () => openExample("cats-eye") }, t("action.example"));

let search = null;
const searchCache = new Map();
function setSearchStatus(nodes) { $("searchStatus").replaceChildren(...[].concat(nodes)); }

async function runSearch(ra, dec, band) {
  search?.controller.abort();
  const controller = new AbortController();
  const me = { controller }; search = me;
  $("searchBtn").disabled = true; $("cancelBtn").hidden = false;
  const key = `${ra.toFixed(4)},${dec.toFixed(4)},${band}`;
  const done = () => { if (search === me) { $("searchBtn").disabled = false; $("cancelBtn").hidden = true; search = null; } };
  try {
    let result, cached = null;
    if (searchCache.has(key)) { result = searchCache.get(key); cached = "tab"; }
    else {
      setSearchStatus(h("p", {}, t("stage.search")));
      const res = await fetchRetry(`/api/search?${new URLSearchParams({ ra, dec, band })}`, { signal: controller.signal,
        onRetry: (n, max) => { if (search === me) setSearchStatus(h("p", {}, t("stage.retry", { n, max }))); } });
      result = await res.json();
      if (search !== me) return;
      if (/HIT|STALE/i.test(res.headers.get("x-vercel-cache") || "")) cached = "cdn";
      if (result.complete) searchCache.set(key, result);
    }
    const notes = [];
    if (cached) notes.push(h("p", { class: "caption" }, t(cached === "tab" ? "search.cachedTab" : "search.cachedCdn")));
    if (result.stats?.collections_failed?.length) notes.push(h("p", { class: "caption" }, t("search.partial", { list: result.stats.collections_failed.join(", ") })));
    if (result.stats?.failed) notes.push(h("p", { class: "caption" }, t("search.framesFailed", { n: result.stats.failed, total: result.stats.examined })));
    if (!["ready", "spectral_only"].includes(result.state)) {
      const msg = { no_results: "search.noResults", no_coverage: "search.noCoverage", single: "search.single" }[result.state] || "error.archive";
      setSearchStatus([h("p", { class: "err" }, t(msg)), ...notes, exampleButton()]);
      return;
    }
    setSearchStatus([h("p", {}, result.state === "spectral_only" ? t("search.spectral")
      : t("search.ready", { found: result.stats.found, examined: result.stats.examined, chosen: result.frames.length })), ...notes]);
    closeRegion();
    await openManifest(result, { field: { kind: "search", ra: result.field.ra, dec: result.field.dec, band }, a: result.pair?.a ?? "first", b: result.pair?.b ?? "last" });
  } catch (e) {
    if (e.name === "AbortError") { if (search === me || !search) setSearchStatus(h("p", {}, t("search.cancelled"))); return; }
    if (search === me) setSearchStatus([h("p", { class: "err" }, errorText(e)),
      h("div", { class: "search-actions" }, h("button", { class: "btn", type: "button", onclick: () => runSearch(ra, dec, band) }, t("action.retry")), exampleButton())]);
  } finally { done(); }
}

async function restoreState(st, { fromFile = false } = {}) {
  const common = { a: st.a, b: st.b, mode: st.mode, marks: st.marks, note: st.note, contrast: st.contrast, view: st.view };
  let ok;
  if (st.src.ex) {
    const preset = EXAMPLES.find((e) => e.manifest === st.src.ex);
    if (!preset) { veilError(t("error.unknownExample"), [exampleButton()]); return; }
    ok = await openExample(preset.id, { ...common, requireIds: st.src.ids });
  } else {
    veil([h("p", {}, t("stage.search"))]);
    let data;
    try {
      const res = await fetchRetry(`/api/observations?${new URLSearchParams({ ra: st.src.ra, dec: st.src.dec, ids: st.src.ids.join(",") })}`);
      data = await res.json();
    } catch (e) {
      const detail = e.body?.failed?.join(", ") || errorText(e);
      veilError(t("error.source", { detail }), [h("button", { class: "btn", type: "button", onclick: () => restoreState(st, { fromFile }) }, t("action.retry")), exampleButton()]);
      return;
    }
    ok = await openManifest(data, { field: { kind: "search", ra: st.src.ra, dec: st.src.dec, band: st.src.band }, ...common });
  }
  if (ok && fromFile) showSaveMsg(t("save.imported"));
}

/* ---------------- Modes, tools, blink ---------------- */
function setMode(mode, quiet) {
  if (mode === "difference" && !S.pair?.differenceAllowed) {
    $("toolHint").textContent = differenceOffText();
    if (!quiet) return;
    mode = "swipe";
  }
  S.mode = mode;
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  $("blinkCtl").hidden = mode !== "blink";
  if (mode === "blink" && S.blinkOn) startBlink(); else stopBlink();
  if (mode === "difference" && S.tool === "mark") setTool("inspect");
  draw();
}
function setTool(tool) {
  S.tool = tool;
  document.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === tool)));
  $("viewer").classList.toggle("marking", tool === "mark");
  if (tool === "mark") {
    if (S.mode === "difference") setMode("swipe");
    if (!S.candidates.length) newCandidate();
  }
  updateHint();
}
function updateHint() {
  let text = "";
  if (S.mode === "difference") text = t("mode.differenceNote");
  else if (S.tool === "mark") text = t("tool.markHint", { slot: S.mode === "swipe" ? "A | B" : S.mode === "blink" ? (S.blinkShow ? "B" : "A") : S.slot.toUpperCase() });
  else if (S.mode === "swipe") text = t("mode.swipeHint");
  $("toolHint").textContent = text;
}
function startBlink() {
  stopBlink(true);
  S.blinkOn = true;
  S.blinkTimer = setInterval(() => { S.blinkShow ^= 1; draw(); }, S.blinkMs);
  $("blinkBtn").textContent = t("blink.pause");
}
function stopBlink(keepFlag) {
  clearInterval(S.blinkTimer); S.blinkTimer = null;
  if (!keepFlag) { S.blinkOn = S.mode === "blink" ? false : S.blinkOn; }
  $("blinkBtn").textContent = t("blink.play");
}

/* ---------------- Drawing ---------------- */
function visibleSlots() {
  if (S.mode === "swipe") return ["a", "b"];
  if (S.mode === "blink") return [S.blinkShow ? "b" : "a"];
  if (S.mode === "single") return [S.slot];
  return [];
}
function draw() {
  if (!S.frames.length) return;
  const A = S.frames[S.a], B = S.frames[S.b];
  const ca = $("canA").getContext("2d"), cb = $("canB").getContext("2d");
  let main = A;
  if (S.mode === "blink") main = S.blinkShow ? B : A;
  if (S.mode === "single") main = S.slot === "a" ? A : B;
  ca.clearRect(0, 0, 512, 512);
  if (S.mode === "difference") {
    const key = `${S.a}-${S.b}`;
    if (S.diffKey !== key) {
      const c = S.diffCanvas || (S.diffCanvas = document.createElement("canvas"));
      c.width = A.width; c.height = A.height;
      const ctx = c.getContext("2d"), img = ctx.createImageData(A.width, A.height);
      S.diffScale = renderDifference(A, B, img.data).scale;
      ctx.putImageData(img, 0, 0); S.diffKey = key;
    }
    ca.drawImage(S.diffCanvas, 0, 0);
  } else ca.drawImage(main.canvas, 0, 0);
  $("canB").hidden = S.mode !== "swipe";
  $("viewer").classList.toggle("diff", S.mode === "difference");
  if (S.mode === "swipe") { cb.clearRect(0, 0, 512, 512); cb.drawImage(B.canvas, 0, 0); }
  $("split").hidden = S.mode !== "swipe";
  // tags
  const tag = (el, slot, f, extra) => {
    el.replaceChildren(h("span", { class: slot === "a" ? "tag-a-dot" : "tag-b-dot" }), h("b", {}, slot.toUpperCase()), " " + dateUTC(f.info.date_avg, false) + " · λ " + num(f.info.wavelength_um, 3) + (extra || ""));
  };
  const showA = S.mode !== "single" || S.slot === "a", showB = S.mode !== "single" || S.slot === "b";
  if (S.mode === "blink") { tag($("tagA"), S.blinkShow ? "b" : "a", main); $("tagB").hidden = true; $("tagA").hidden = false; }
  else if (S.mode === "difference") { $("tagA").hidden = false; $("tagB").hidden = true; $("tagA").replaceChildren(h("b", {}, "B − A"), ` ±${num(S.diffScale, 1)} MJy/sr`); }
  else { $("tagA").hidden = !showA; $("tagB").hidden = !showB; if (showA) tag($("tagA"), "a", A); if (showB) tag($("tagB"), "b", B); }
  const rel = [...new Set(S.frames.map((f) => f.info.release))].join(" + ");
  $("sourceLine").textContent = t("viewer.source", { release: rel });
  applyTransform();
  updateHint();
  updateTimelineMarks();
}

function applyTransform() {
  const { scale, tx, ty } = S.view;
  $("world").style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  $("world").classList.toggle("pixelated", scale >= 2);
  const r = $("viewer").getBoundingClientRect();
  const x = r.width * S.split;
  $("split").style.left = x + "px";
  const ix = (x - tx) / scale, pct100 = Math.max(0, Math.min(100, ix / 512 * 100));
  $("canB").style.clipPath = `inset(0 0 0 ${pct100}%)`;
  $("grip").setAttribute("aria-valuenow", String(Math.round(S.split * 100)));
  drawOverlay();
  saveUrl();
}
function fit() {
  const r = $("viewer").getBoundingClientRect();
  if (!r.width || !r.height) return;
  const s = Math.min(r.width, r.height) / 512;
  S.view = { scale: s, tx: (r.width - 512 * s) / 2, ty: (r.height - 512 * s) / 2, min: s * 0.5 };
  applyTransform();
}
function zoomAt(f, cx, cy) {
  const v = S.view, ns = Math.max(v.min || 0.2, Math.min(24, v.scale * f)), k = ns / v.scale;
  v.tx = cx - (cx - v.tx) * k; v.ty = cy - (cy - v.ty) * k; v.scale = ns; applyTransform();
}
const viewCenter = () => { const r = $("viewer").getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
// Zoom relative to "fit" and the grid pixel at the centre of the viewer.
function viewState() {
  const r = $("viewer").getBoundingClientRect(), fitScale = Math.min(r.width, r.height) / 512;
  if (!S.view || !fitScale) return undefined;
  const clamp = (v) => Math.max(-64, Math.min(576, v));
  return { z: Math.max(0.5, Math.min(64, S.view.scale / fitScale)), x: clamp((r.width / 2 - S.view.tx) / S.view.scale), y: clamp((r.height / 2 - S.view.ty) / S.view.scale) };
}
function applyView(v) {
  fit();
  if (!v || !S.view) return;
  const r = $("viewer").getBoundingClientRect();
  S.view.scale = Math.max(S.view.min || 0.2, Math.min(24, S.view.scale * v.z));
  S.view.tx = r.width / 2 - v.x * S.view.scale; S.view.ty = r.height / 2 - v.y * S.view.scale;
  applyTransform();
}

function drawOverlay() {
  const svg = $("overlay");
  svg.replaceChildren();
  if (!S.grid || !S.frames.length) return;
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; svg.append(e); return e; };
  const { scale, tx, ty } = S.view;
  const toScreen = (ra, dec) => { const [px, py] = S.grid.toPixel(ra, dec); return [tx + (px + 0.5) * scale, ty + (py + 0.5) * scale]; };
  const ida = S.frames[S.a].info.id, idb = S.frames[S.b].info.id;
  const vis = visibleSlots().map((s) => (s === "a" ? ida : idb));
  const order = new Map(S.frames.map((f, i) => [f.info.id, i]));
  // Prepared ephemeris (Pluto example): open ticks around the predicted position, never covering the object.
  const eph = S.manifest?.ephemeris;
  if (eph?.positions) {
    for (const [slot, id] of [["A", ida], ["B", idb]]) {
      const pos = eph.positions[id];
      if (!pos || !vis.includes(id)) continue;
      const [x, y] = toScreen(pos.ra, pos.dec), g0 = Math.max(6, 2.5 * scale), g1 = g0 + Math.max(8, 2 * scale);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) el("line", { class: "eph", x1: x + dx * g0, y1: y + dy * g0, x2: x + dx * g1, y2: y + dy * g1 });
      const below = slot === "B";
      el("text", { class: "eph-label", x: below ? x + g1 + 3 : x - g1 - 3, y: below ? y + g1 + 10 : y - g1 - 2, "text-anchor": below ? "start" : "end" },
        `${eph.object[uiLang()] || eph.object.en} · DE421 · ${slot}`);
    }
  }
  S.candidates.forEach((c, ci) => {
    const pts = c.points.filter((p) => order.has(p.frame)).sort((p, q) => order.get(p.frame) - order.get(q.frame));
    const xy = pts.map((p) => toScreen(p.ra, p.dec));
    if (xy.length > 1) el("polyline", { class: "trace", points: xy.map((p) => p.join(",")).join(" ") });
    pts.forEach((p, i) => {
      const [x, y] = xy[i];
      const slot = p.frame === ida ? "A" : p.frame === idb ? "B" : dateUTC(S.frames[order.get(p.frame)].info.date_avg, false);
      const r = Math.max(7, 2.2 * scale);
      el("circle", { cx: x, cy: y, r, class: "pt" + (vis.includes(p.frame) ? " here" : "") + (c.id === S.active ? " active" : "") });
      el("text", { x: x + r + 3, y: y - r + 2 }, `${ci + 1}·${slot}`);
    });
  });
}

/* ---------------- Pointer interaction ---------------- */
function setupViewer() {
  const viewer = $("viewer"), ptrs = new Map();
  let pinch = null, moved = 0, downAt = null;
  viewer.addEventListener("wheel", (e) => { e.preventDefault(); const r = viewer.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  viewer.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".zoom, .grip")) return;
    viewer.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    moved = 0; downAt = [e.clientX, e.clientY];
    viewer.classList.add("dragging");
    if (ptrs.size === 2) { const [p, q] = [...ptrs.values()]; pinch = Math.hypot(p[0] - q[0], p[1] - q[1]); }
  });
  viewer.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    moved = Math.max(moved, Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]));
    if (ptrs.size === 2 && pinch) {
      const [p, q] = [...ptrs.values()], d = Math.hypot(p[0] - q[0], p[1] - q[1]), r = viewer.getBoundingClientRect();
      zoomAt(d / pinch, (p[0] + q[0]) / 2 - r.left, (p[1] + q[1]) / 2 - r.top); pinch = d;
    } else if (ptrs.size === 1 && (S.tool !== "mark" || moved > 6)) {
      S.view.tx += e.clientX - prev[0]; S.view.ty += e.clientY - prev[1]; applyTransform();
    }
  });
  const up = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const wasSingle = ptrs.size === 1;
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
    if (!ptrs.size) viewer.classList.remove("dragging");
    if (e.type === "pointerup" && wasSingle && moved <= 6 && S.tool === "mark") {
      const r = viewer.getBoundingClientRect();
      placeMark(e.clientX - r.left, e.clientY - r.top);
    }
  };
  viewer.addEventListener("pointerup", up); viewer.addEventListener("pointercancel", up);
  // Keep the zoom and the centre on resize (and on the first layout), instead of resetting to "fit".
  let lastRect = null;
  new ResizeObserver(() => {
    const r = viewer.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (S.view && lastRect && S.frames.length) {
      const fitOld = Math.min(lastRect.width, lastRect.height) / 512;
      const v = { z: S.view.scale / fitOld, x: (lastRect.width / 2 - S.view.tx) / S.view.scale, y: (lastRect.height / 2 - S.view.ty) / S.view.scale };
      lastRect = r; applyView(v);
    } else { lastRect = r; fit(); }
  }).observe(viewer);
  const grip = $("grip");
  grip.addEventListener("pointerdown", (e) => { e.stopPropagation(); grip.setPointerCapture(e.pointerId); grip.dataset.drag = "1"; });
  grip.addEventListener("pointermove", (e) => { if (!grip.dataset.drag) return; const r = viewer.getBoundingClientRect(); S.split = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); applyTransform(); });
  const release = () => delete grip.dataset.drag;
  grip.addEventListener("pointerup", release); grip.addEventListener("pointercancel", release);
  grip.addEventListener("keydown", (e) => {
    if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); S.split = Math.max(0, Math.min(1, S.split + (e.key === "ArrowLeft" ? -0.05 : 0.05))); applyTransform(); }
  });
  $("zIn").onclick = () => zoomAt(1.6, ...viewCenter());
  $("zOut").onclick = () => zoomAt(1 / 1.6, ...viewCenter());
  $("zFit").onclick = fit;
}

function placeMark(sx, sy) {
  if (!S.frames.length || S.mode === "difference") return;
  const { scale, tx, ty } = S.view;
  const px = (sx - tx) / scale - 0.5, py = (sy - ty) / scale - 0.5;
  if (px < 0 || py < 0 || px > 511 || py > 511) return;
  let slot;
  if (S.mode === "swipe") slot = sx < $("viewer").getBoundingClientRect().width * S.split ? "a" : "b";
  else if (S.mode === "blink") { stopBlink(); slot = S.blinkShow ? "b" : "a"; }
  else slot = S.slot;
  const frame = S.frames[slot === "a" ? S.a : S.b].info.id;
  let cand = S.candidates.find((c) => c.id === S.active);
  if (!cand) cand = newCandidate();
  const [ra, dec] = S.grid.toSky(px, py);
  const existing = cand.points.find((p) => p.frame === frame);
  if (existing) { existing.ra = ra; existing.dec = dec; }
  else {
    if (cand.points.length >= LIMITS.points) return;
    cand.points.push({ frame, ra, dec });
  }
  refreshMarks();
}
function newCandidate() {
  if (S.candidates.length >= LIMITS.candidates) return null;
  const c = { id: S.nextId++, c: "unsure", points: [] };
  S.candidates.push(c); S.active = c.id;
  refreshMarks();
  return c;
}

/* ---------------- Timeline ---------------- */
function buildTimeline() {
  const track = $("track");
  track.querySelectorAll(".tick, .tick-label").forEach((n) => n.remove());
  const times = S.frames.map((f) => Date.parse(f.info.date_avg));
  const t0 = Math.min(...times), t1 = Math.max(...times), span = t1 - t0;
  let pos = times.map((x, i) => (span > 0 ? (x - t0) / span : (S.frames.length > 1 ? i / (S.frames.length - 1) : 0.5)));
  const MIN = 0.035; for (let i = 1; i < pos.length; i++) if (pos[i] - pos[i - 1] < MIN) pos[i] = pos[i - 1] + MIN;
  const over = pos[pos.length - 1]; if (over > 1) pos = pos.map((p) => p / over);
  S.tickPos = pos;
  let lastLabel = -1;
  const minGap = 84 / Math.max(120, track.getBoundingClientRect().width);
  S.frames.forEach((f, i) => {
    const b = h("button", { type: "button", class: "tick", style: `left:${pos[i] * 100}%`,
      "aria-label": t("timeline.tick", { date: dateUTC(f.info.date_avg) + " UTC", wl: num(f.info.wavelength_um, 3) }),
      onclick: () => assign(S.slot, i) });
    b.dataset.i = i;
    track.append(b);
    const last = i === S.frames.length - 1;
    if (i === 0 || (pos[i] - lastLabel > minGap && (last || pos[pos.length - 1] - pos[i] > minGap))) {
      lastLabel = pos[i];
      track.append(h("span", { class: "tick-label", style: `left:${pos[i] * 100}%` }, dateUTC(f.info.date_avg, false)));
    }
  });
  $("tlSpan").textContent = span > 0 ? `${dateUTC(new Date(t0).toISOString(), false)} → ${dateUTC(new Date(t1).toISOString(), false)} UTC · ${S.frames.length}` : "";
}
function updateTimelineMarks() {
  document.querySelectorAll("#track .tick").forEach((b) => {
    const i = +b.dataset.i;
    b.classList.toggle("is-a", i === S.a); b.classList.toggle("is-b", i === S.b);
    b.querySelectorAll(".slot").forEach((s) => s.remove());
    if (i === S.a) b.append(h("span", { class: "slot a", "aria-hidden": "true" }, "A"));
    if (i === S.b) b.append(h("span", { class: "slot b", "aria-hidden": "true" }, "B"));
    b.setAttribute("aria-pressed", String(i === S.a || i === S.b));
  });
  document.querySelectorAll("[data-slot]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.slot === S.slot)));
}
function assign(slot, i) {
  const n = S.frames.length;
  i = ((i % n) + n) % n;
  if (slot === "a") { if (i === S.b) S.b = S.a; S.a = i; } else { if (i === S.a) S.a = S.b; S.b = i; }
  if (S.mode === "single") S.slot = slot;
  refreshAll();
}

/* ---------------- Panel ---------------- */
function computePair() {
  const A = S.frames[S.a], B = S.frames[S.b], key = `${S.a}-${S.b}`;
  if (!S.shiftCache.has(key)) S.shiftCache.set(key, residualShift(A, B, A.width));
  S.pair = pairChecks(A, B, S.shiftCache.get(key), S.manifest?.ephemeris || null);
  S.pair.shift = S.shiftCache.get(key);
}

function renderCompare() {
  const A = S.frames[S.a].info, B = S.frames[S.b].info, p = S.pair;
  const row = (label, va, vb) => [h("span", { class: "h" }, label), h("span", { class: "v" }, va), h("span", { class: "v" }, vb)];
  const level = p.level;
  $("compareBody").replaceChildren(
    h("div", { class: "kv" },
      h("span"), h("span", {}, h("span", { class: "badge a" }, "A")), h("span", {}, h("span", { class: "badge b" }, "B")),
      ...row(t("compare.date"), dateUTC(A.date_avg), dateUTC(B.date_avg)),
      ...row(t("compare.lambda"), `${num(A.wavelength_um, 4)} ± ${num(A.bandwidth_um / 2, 4)}`, `${num(B.wavelength_um, 4)} ± ${num(B.bandwidth_um / 2, 4)}`),
      ...row("OBSID", A.obsid, B.obsid)),
    h("p", { class: "kv-line" }, `${t("compare.interval")}: `, h("b", {}, duration(p.dtSec))),
    h("p", { class: "verdict " + (level === "comparable" ? "ok" : level === "partial" ? "warn" : "fail") },
      h("b", {}, t(level === "comparable" ? "compare.time" : "compare.spectral")), " — ", t(`check.wavelength.${level === "unknown" ? "partial" : level}`)),
  );
}

function checkText(c) {
  const v = c.values, A = S.frames[S.a].info, B = S.frames[S.b].info;
  switch (c.id) {
    case "interval": return t("check.interval.text", { dt: duration(v.dtSec) }) + (v.sameVisit ? " " + t("check.interval.same") : "");
    case "wavelength": {
      const r = (x) => (x ? `${num(x[0], 3)}–${num(x[1], 3)}` : t("misc.unknown"));
      return t("check.wavelength.text", { la: num(v.la, 4), wa: num(v.wa / 2, 4), lb: num(v.lb, 4), wb: num(v.wb / 2, 4), ov: pct(v.overlap) }) + " " +
        t(`check.wavelength.${v.level === "unknown" ? "partial" : v.level}`) + " " + t("check.wavelength.range", { ra: r(v.rangeA), rb: r(v.rangeB) });
    }
    case "coverage": return t("check.coverage.text", { both: pct(v.both) });
    case "quality": return t("check.quality.text", { abad: pct(v.qa.bad), atr: pct(v.qa.tr), aart: pct(v.qa.art), bbad: pct(v.qb.bad), btr: pct(v.qb.tr), bart: pct(v.qb.art), da: v.dqa[0] || "—", db: v.dqa[1] || "—" });
    case "registration": {
      if (!v.shift) return t("check.registration.none");
      let s = t("check.registration.text", { dx: num(v.shift.dx, 2), dy: num(v.shift.dy, 2), total: num(v.shift.total * S.grid.pixelArcsec, 1) });
      if (v.shift.atEdge) s += " " + t("check.registration.edge");
      else if (!v.reliable) s += " " + t("check.registration.unreliable", { r: num(v.shift.correlation, 2) });
      if (v.solved) s += " " + t("check.registration.solved", { sa: num(v.starsA, 0), sb: num(v.starsB, 0) });
      else s += " " + t(v.unsolved ? "check.registration.unsolved" : "check.registration.astrometryUnknown");
      return s;
    }
    case "ephemeris": {
      if (!v.a) return t("check.ephemeris.text");
      return t("check.ephemeris.prepared", { object: v.object[uiLang()] || v.object.en, motion: num(v.motionArcsec, 1), px: num(v.motionArcsec / S.grid.pixelArcsec, 1),
        oa: num(v.a.centroid_offset_arcsec, 1), ob: num(v.b.centroid_offset_arcsec, 1), sa: num(v.a.peak_contrast, 0), sb: num(v.b.peak_contrast, 0) });
    }
    case "processing": return t("check.processing.text", { ra: v.ra, va: v.va, da: v.da, rb: v.rb, vb: v.vb, db: v.db }) + (v.va !== v.vb ? " " + t("check.processing.differs") : "");
    case "psf": return t("check.psf.text", { pa: num(v.pa, 2), pb: num(v.pb, 2) }) + (c.status === STATUS.WARN ? " " + t("check.psf.warn") : "");
    default: return t(`check.${c.id}.text`);
  }
}
function renderChecks() {
  $("checkList").replaceChildren(...S.pair.checks.map((c) => h("li", {},
    h("span", { class: "name" }, t(`check.${c.id}`)), h("span", { class: "st " + c.status }, t(`status.${c.status}`)),
    h("span", { class: "text" }, checkText(c)))));
  document.querySelector('[data-mode="difference"]').setAttribute("aria-disabled", String(!S.pair.differenceAllowed));
  document.querySelector('[data-mode="difference"]').title = S.pair.differenceAllowed ? t("mode.differenceNote") : differenceOffText();
}
function differenceOffText() {
  const reasons = (S.pair?.blockers || []).map((b) => t(`mode.blocker.${b}`));
  return t("mode.differenceOff") + (reasons.length ? " " + t("mode.blockedBy", { list: reasons.join("; ") }) : "");
}

function candidateSummary(c) {
  const facts = candidateFacts(c, S.frames, S.grid, S.pair?.shift);
  c.facts = facts;
  return facts;
}
function renderMarks() {
  const list = $("markList");
  list.replaceChildren();
  const ida = S.frames[S.a].info.id, idb = S.frames[S.b].info.id;
  const order = new Map(S.frames.map((f, i) => [f.info.id, f]));
  S.candidates.forEach((c, ci) => {
    const facts = candidateSummary(c);
    const sel = h("select", { "aria-label": t("marks.category"), onchange: (e) => { c.c = e.target.value; saveUrl(); } },
      ...CATEGORIES.map((k) => h("option", { value: k, selected: c.c === k }, t(`cat.${k}`))));
    const pts = h("ul", { class: "pts" }, ...[...c.points].sort((p, q) => Date.parse(order.get(p.frame).info.date_avg) - Date.parse(order.get(q.frame).info.date_avg)).map((p) => {
      const slot = p.frame === ida ? "A" : p.frame === idb ? "B" : "·";
      return h("li", {}, h("span", { class: "mono" }, `${t("marks.point", { slot, date: dateUTC(order.get(p.frame).info.date_avg, false) })} · ${fmtDeg(p.ra, 5)} ${fmtDeg(p.dec, 5)}`),
        h("button", { type: "button", class: "linkbtn", onclick: () => { c.points = c.points.filter((x) => x !== p); refreshMarks(); } }, t("marks.deletePoint")));
    }));
    const lines = [];
    if (facts.separation !== undefined) lines.push(t("facts.offset", { sep: num(facts.separation, 1), px: num(facts.separationPx, 1), dt: duration(facts.dtHours * 3600), rate: facts.rate === null ? "—" : num(facts.rate, 2) }));
    const inside = facts.measures.filter((m) => m.inside);
    if (inside.length) {
      lines.push(t("facts.brightness", { values: inside.map((m) => num(m.sum, 1)).join(" → ") }));
      lines.push(t("facts.wave", { values: inside.map((m) => num(m.wavelength, 3)).join(" → ") }));
      const names = inside.flatMap((m) => [m.bad && "bad", m.flags & CAT.TRANSIENT && "TRANSIENT/OUTLIER", m.flags & CAT.ARTIFACT && "PERSIST/GHOST/STREAK/HALO"]).filter(Boolean);
      lines.push(t("facts.flags", { list: names.length ? [...new Set(names)].join(", ") : t("misc.none") }));
    }
    if (facts.measures.some((m) => !m.inside)) lines.push(t("facts.outside"));
    const exp = c.points.length ? h("ul", { class: "exp", "aria-label": t("exp.title") }, ...facts.explanations.map((x) => h("li", {},
      h("span", {}, t(`exp.${x.id}`)), h("span", { class: "st " + x.status }, t(`status.${x.status}`)), h("span", { class: "why" }, t(`why.${x.why}`))))) : null;
    list.append(h("div", { class: "cand" + (c.id === S.active ? " active" : ""), "data-active": t("marks.active") },
      h("div", { class: "cand-head" },
        h("button", { type: "button", class: "cand-title", title: t("marks.select"), onclick: () => { S.active = c.id; refreshMarks(); } }, t("marks.object", { n: ci + 1 })),
        sel,
        h("button", { type: "button", class: "linkbtn", onclick: () => { S.candidates = S.candidates.filter((x) => x !== c); if (S.active === c.id) S.active = S.candidates.at(-1)?.id ?? null; refreshMarks(); } }, t("marks.delete"))),
      pts, lines.length ? h("p", { class: "facts" }, lines.join(" ")) : null,
      exp ? h("p", { class: "caption" }, t("exp.title")) : null, exp));
  });
  $("newCandidate").disabled = S.candidates.length >= LIMITS.candidates;
}

function renderSource() {
  const A = S.frames[S.a].info, B = S.frames[S.b].info;
  const links = (f, slot) => h("div", { class: "links" }, h("b", {}, `${slot} · ${f.obsid}`),
    ...[["source.cutout", f.links?.irsa_cutout], ["source.file", f.links?.irsa_file], ["source.aws", f.links?.aws_file]]
      .map(([k, u]) => (safeHref(u) ? h("a", { href: safeHref(u), target: "_blank", rel: "noopener noreferrer" }, t(k) + " ↗") : null)));
  $("sourceBody").replaceChildren(h("p", { class: "caption" }, t("source.frames")), links(A, "A"), links(B, "B"),
    h("p", { class: "caption" }, h("b", {}, t("source.processing") + ": "), t("source.processingText", { pix: num(S.grid.pixelArcsec, 2) })),
    h("p", { class: "caption mono" }, `Space · ← → · A/B · 1–4 · M/V · + − 0`));
}

function fieldTitle() {
  if (!S.field) return "—";
  if (S.field.title) return S.field.title[uiLang()] || S.field.title.ru;
  return t("misc.fieldCustom", { ra: fmtDeg(S.field.ra, 3), dec: fmtDeg(S.field.dec, 3) });
}

function refreshMarks() { renderMarks(); drawOverlay(); saveUrl(); }
function refreshAll() {
  if (!S.frames.length) return;
  computePair();
  if (S.mode === "difference" && !S.pair.differenceAllowed) setMode("swipe", true);
  $("fieldName").textContent = fieldTitle();
  $("fieldCoords").textContent = `${fmtRA(S.field.ra)} ${fmtDec(S.field.dec)}`;
  buildTimeline(); draw(); renderCompare(); renderChecks(); renderMarks(); renderSource();
  $("noteCount").textContent = t("note.count", { n: S.note.length, max: LIMITS.note });
  $("sheetSummary").textContent = `A ${dateUTC(S.frames[S.a].info.date_avg, false)} · B ${dateUTC(S.frames[S.b].info.date_avg, false)} · ${t(S.pair.level === "comparable" ? "compare.time" : "compare.spectral")}`;
  saveUrl();
}

/* ---------------- URL state, export, import ---------------- */
function currentState() {
  // Every frame the state refers to is listed; nothing is dropped silently (validation rejects a state
  // that does not fit, and the caller reports it). Example frames come from the prepared set.
  const ids = S.field.kind === "example"
    ? [...new Set([S.frames[S.a].info.id, S.frames[S.b].info.id, ...S.candidates.flatMap((c) => c.points.map((p) => p.frame))])]
    : S.frames.map((f) => f.info.id);
  return {
    v: STATE_VERSION,
    src: { ...(S.field.kind === "example" ? { ex: S.field.ex } : {}), ra: S.field.ra, dec: S.field.dec, ids, ...(S.field.band ? { band: S.field.band } : {}) },
    a: S.frames[S.a].info.id, b: S.frames[S.b].info.id, mode: S.mode, contrast: S.contrast, view: viewState(),
    marks: S.candidates.filter((c) => c.points.length).map((c) => ({ c: c.c, p: c.points.map((p) => [p.frame, p.ra, p.dec]) })),
    note: S.note,
  };
}
let urlTimer = null;
function saveUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    if (!S.frames.length) return;
    try { history.replaceState(null, "", "#" + encodeHash(currentState())); }
    catch (e) { if (e instanceof StateError) showSaveMsg(t("save.tooLarge"), true); }
  }, 150);
}
function shareUrl() { return location.origin + location.pathname + "#" + encodeHash(currentState()); }
function showSaveMsg(text, err) { $("saveMsg").replaceChildren(err ? h("span", { class: "err" }, text) : text); }
async function copyLink(target = $("saveMsg")) {
  let url;
  try { url = shareUrl(); } catch { showSaveMsg(t("save.tooLarge"), true); return; }
  try { await navigator.clipboard.writeText(url); showSaveMsg(t("save.copied")); }
  catch { showSaveMsg(t("save.copyFail", { url })); }
}

function exportDocument() {
  // The JSON file must be saved even when the state is too large for a link.
  const st = validateState(currentState());
  let link = null;
  try { link = shareUrl(); } catch (e) { if (!(e instanceof StateError)) throw e; }
  const frame = (f) => ({ ...f.info, file: undefined });
  return {
    format: EXPORT_FORMAT, format_version: STATE_VERSION, app_version: APP_VERSION,
    status: "user observation, not a confirmed discovery",
    created_utc: new Date().toISOString(), link, state: st,
    field: { ra: S.field.ra, dec: S.field.dec, grid: S.manifest.grid, title: S.field.title || null },
    frames: { a: frame(S.frames[S.a]), b: frame(S.frames[S.b]), all_in_set: S.frames.map((f) => f.info.id) },
    marks: S.candidates.filter((c) => c.points.length).map((c) => ({ category: c.c, points: c.points,
      measurements: c.facts ? { separation_arcsec: c.facts.separation ?? null, interval_hours: c.facts.dtHours ?? null, rate_arcsec_per_hour: c.facts.rate ?? null,
        per_frame: c.facts.measures, explanations: c.facts.explanations } : null })),
    note: S.note,
    checks: S.pair.checks.map((c) => ({ id: c.id, status: c.status, values: c.values })),
    processing: { ...(S.manifest.processing || {}), display_stretch: S.stretch, residual_shift_px: S.pair.shift },
    sources: { archive: "NASA/IPAC Infrared Science Archive (IRSA), SPHEREx Level 2", cloud_copy: "s3://nasa-irsa-spherex" },
  };
}
function downloadJSON() {
  let doc;
  try { doc = exportDocument(); } catch (e) { showSaveMsg(e instanceof StateError ? stateErrorText(e) : t("save.exportFail"), true); return; }
  if (!doc.link) showSaveMsg(t("save.jsonOnly"));
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `nighttrace-${S.frames[S.a].info.obsid}-${S.frames[S.b].info.obsid}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importJSON(file) {
  if (!file) return;
  try {
    if (file.size > LIMITS.json) throw new StateError("too_large");
    const st = parseImport(await file.text());
    await restoreState(st, { fromFile: true });
  } catch (e) {
    showSaveMsg(stateErrorText(e), true);
  }
}
const stateErrorText = (e) => (e instanceof StateError && DICTS.ru[`error.state.${e.code}`] ? t(`error.state.${e.code}`) : t("error.state.generic", { code: e.code || e.message }));

/* ---------------- Observation card ---------------- */
function openCard() {
  if (!S.frames.length) return;
  const A = S.frames[S.a].info, B = S.frames[S.b].info, p = S.pair;
  let link = "";
  try { link = shareUrl(); } catch { link = t("save.tooLarge"); }
  const sec = (title, ...body) => h("section", { class: "j-sec" }, h("h2", {}, title), h("div", {}, ...body));
  const what = S.candidates.filter((c) => c.points.length).map((c) => t(`cat.${c.c}`));
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const subject = what.length ? cap(t("card.subjectText", { what: [...new Set(what)].join(", "), region: fieldTitle(), a: A.obsid, b: B.obsid })) : t("card.subjectNone") + `: ${A.obsid} / ${B.obsid}`;
  const frameRow = (slot, f) => h("tr", {}, h("td", {}, h("span", { class: "badge " + slot.toLowerCase() }, slot)), h("td", { class: "mono" }, f.obsid),
    h("td", { class: "mono" }, dateUTC(f.date_avg) + " UTC"), h("td", { class: "mono" }, `${num(f.wavelength_um, 4)} ± ${num(f.bandwidth_um / 2, 4)} µm`),
    h("td", { class: "mono" }, `${f.release} ${f.processing_version} D${f.detector}`),
    h("td", {}, ...[["IRSA", f.links?.irsa_file], ["AWS", f.links?.aws_file]].map(([k, u]) => safeHref(u) ? h("a", { href: safeHref(u), target: "_blank", rel: "noopener noreferrer" }, k + " ↗ ") : null)));
  const marks = S.candidates.filter((c) => c.points.length);
  const order = new Map(S.frames.map((f) => [f.info.id, f.info]));
  const limits = [t("card.limit.always")];
  if (p.level === "different") limits.push(t("card.limit.spectral")); else if (p.level === "partial") limits.push(t("card.limit.partial"));
  if (p.dtSec < 3600) limits.push(t("card.limit.sameVisit"));
  limits.push(t("card.limit.unchecked"));
  const created = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const logo = document.querySelector(".logo").cloneNode(true);
  $("cardBody").replaceChildren(
    h("header", { class: "j-head" }, logo, h("div", {}, h("h1", { id: "cardTitle" }, t("card.title")), h("span", { class: "mono caption" }, "NightTrace " + APP_VERSION)),
      h("div", { class: "meta" }, `${t("card.created")}: ${created}`, h("br"), `${A.obsid} → ${B.obsid}`)),
    h("p", { class: "j-status" }, t("card.status")),
    sec(t("card.subject"), h("p", {}, subject)),
    sec(t("card.region"), h("p", { class: "mono" }, `${fieldTitle()} · RA ${fmtRA(S.field.ra)} (${fmtDeg(S.field.ra)}) · Dec ${fmtDec(S.field.dec)} (${fmtDeg(S.field.dec)}) ICRS`),
      h("p", { class: "caption" }, t("card.fov", { fov: num(512 * S.grid.pixelArcsec / 60, 1), pix: num(S.grid.pixelArcsec, 2) }))),
    sec(t("card.sources"), h("table", { class: "j-table" }, h("tbody", {}, frameRow("A", A), frameRow("B", B))),
      h("p", { class: "caption" }, `${t("compare.interval")}: ${duration(p.dtSec)} · ${t(p.level === "comparable" ? "compare.time" : "compare.spectral")}`)),
    sec(t("card.marks"), marks.length ? h("ul", {}, ...marks.map((c, i) => h("li", {}, h("b", {}, `${t("marks.object", { n: i + 1 })} — ${t(`cat.${c.c}`)}: `),
      c.points.map((pt) => `${dateUTC(order.get(pt.frame)?.date_avg, false)} RA ${fmtDeg(pt.ra, 5)} Dec ${fmtDeg(pt.dec, 5)}`).join("; "),
      c.facts?.separation !== undefined ? ". " + t("facts.offset", { sep: num(c.facts.separation, 1), px: num(c.facts.separationPx, 1), dt: duration(c.facts.dtHours * 3600), rate: c.facts.rate === null ? "—" : num(c.facts.rate, 2) }) : ""))) : h("p", {}, t("card.noMarks"))),
    sec(t("card.checks"), h("ul", {}, ...p.checks.map((c) => h("li", {}, h("b", {}, t(`check.${c.id}`)), " — ", h("span", { class: "st " + c.status }, t(`status.${c.status}`)), ". ", checkText(c))))),
    sec(t("card.limits"), h("ul", {}, ...limits.map((x) => h("li", {}, x)))),
    sec(t("card.note"), S.note ? h("p", { class: "j-note" }, S.note) : h("p", { class: "caption" }, t("card.noNote"))),
    sec(t("card.repro"), h("p", { class: "mono", style: "overflow-wrap:anywhere;font-size:12px" }, link),
      h("p", { class: "caption" }, t("source.processingText", { pix: num(S.grid.pixelArcsec, 2) })),
      h("p", { class: "caption" }, t("card.stretch", { low: num(S.stretch.low, 3), high: num(S.stretch.high, 2), soft: num(S.stretch.soft, 3) })),
      h("p", { class: "caption" }, t("source.disclaimer"))),
  );
  $("card").showModal();
}

/* ---------------- Region chooser and sky map ---------------- */
function fillBands() {
  const sel = $("bandSel"), v = sel.value || "0.9";
  sel.replaceChildren(...["0.9", "1.3", "2.0", "3.0", "4.1", "4.7"].map((b) => h("option", { value: b }, t(`band.${b}`))));
  sel.value = v;
}
function renderExamples() {
  $("exampleList").replaceChildren(
    ...EXAMPLES.map((ex) => h("li", {}, h("button", { type: "button", onclick: () => { coachStop(); openExample(ex.id); } }, h("b", {}, t(`example.${ex.id}`)), h("span", {}, t(`example.${ex.id}.text`))))),
    ...UNAVAILABLE.map((id) => h("li", {}, h("div", { class: "unavailable" }, h("b", {}, t(`example.${id}`)), t(`example.${id}.text`)))));
}
const project = (ra, dec) => [44 + (360 - ra) * 2, 20 + (90 - dec) * 2];
function drawMap() {
  const svg = $("skymap"), NS = "http://www.w3.org/2000/svg";
  const el = (parent, tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; parent.append(e); return e; };
  svg.replaceChildren();
  // Background: real SPHEREx DR1 all-sky map (2.19 um channel), same projection as the chart.
  const sky = el(svg, "image", { class: "sky", href: "img/sky-spherex-2um.jpg", x: 44, y: 20, width: 720, height: 360, preserveAspectRatio: "none" });
  sky.addEventListener("load", () => svg.classList.add("has-sky"));
  sky.addEventListener("error", () => { svg.classList.remove("has-sky"); sky.remove(); });
  const surface = el(svg, "rect", { class: "surface", x: 44, y: 20, width: 720, height: 360 });
  const grid = el(svg, "g", { class: "grid" });
  for (let a = 0; a <= 360; a += 30) { const [x] = project(a, 0); el(grid, "line", { x1: x, x2: x, y1: 20, y2: 380 }); if (a % 60 === 0) el(grid, "text", { x, y: 396, "text-anchor": "middle" }, `${a / 15}h`); }
  for (let d = -60; d <= 60; d += 30) { const [, y] = project(0, d); el(grid, "line", { x1: 44, x2: 764, y1: y, y2: y }); el(grid, "text", { x: 38, y: y + 4, "text-anchor": "end" }, `${d}°`); }
  const R = Math.PI / 180, pts = [];
  for (let a = 360; a >= 0; a -= 2) { const d = Math.atan(-Math.cos(27.12825 * R) * Math.cos((a - 192.85948) * R) / Math.sin(27.12825 * R)) / R; pts.push(project(a, d).join(",")); }
  el(grid, "polyline", { class: "galactic", points: pts.join(" ") });
  for (const p of MAP_PLACES) {
    const [x, y] = project(p.ra, p.dec);
    const g = el(svg, "g", { class: "place", tabindex: 0, role: "button", "aria-label": p[uiLang()] || p.ru });
    el(g, "circle", { cx: x, cy: y, r: 5 });
    const right = p.side ? p.side === "right" : p.ra > 300;
    el(g, "text", { x: right ? x + 9 : x - 9, y: y + 4 + (p.dy || 0), "text-anchor": right ? "start" : "end" }, p[uiLang()] || p.ru);
    const choose = () => { setPin(p.ra, p.dec); if (p.ex) { coachStop(); openExample(p.ex); } };
    g.addEventListener("click", (e) => { e.stopPropagation(); choose(); });
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
  }
  S.pin = el(svg, "circle", { class: "pin", r: 9, cx: -50, cy: -50 });
  surface.addEventListener("click", (e) => {
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    setPin(Math.min(359.9999, Math.max(0, 360 - (pt.x - 44) / 2)), Math.max(-90, Math.min(90, 90 - (pt.y - 20) / 2)));
  });
  if ($("raIn").value) setPin(+$("raIn").value, +$("decIn").value);
}
function setPin(ra, dec) {
  $("raIn").value = ra.toFixed(4); $("decIn").value = dec.toFixed(4);
  const [x, y] = project(ra, dec); S.pin?.setAttribute("cx", x); S.pin?.setAttribute("cy", y);
}
function openRegion() {
  $("region").hidden = false; $("fieldBtn").setAttribute("aria-expanded", "true");
  if (S.field && !$("raIn").value) setPin(S.field.ra, S.field.dec);
  $("raIn").focus();
}
function closeRegion() { $("region").hidden = true; $("fieldBtn").setAttribute("aria-expanded", "false"); }

/* ---------------- Onboarding ---------------- */
const COACH = [
  { el: "modeSeg" }, { el: "toolSeg" }, { el: "secChecks", panel: true }, { el: "secSave", panel: true },
];
async function coachStart() {
  closeRegion();
  const ok = await openExample("false-change");
  if (!ok) return;
  S.coach = 1; coachShow();
}
function coachShow() {
  document.querySelectorAll(".highlight").forEach((e) => e.classList.remove("highlight"));
  if (!S.coach) { $("coach").hidden = true; return; }
  const step = COACH[S.coach - 1];
  $("coach").hidden = false;
  $("coachStep").textContent = t("coach.step", { n: S.coach });
  $("coachTitle").textContent = t(`coach.${S.coach}.title`);
  $("coachText").textContent = t(`coach.${S.coach}.text`);
  $("coachNext").textContent = t(S.coach === 4 ? "coach.done" : "coach.next");
  const target = $(step.el);
  target.classList.add("highlight");
  if (step.panel) { $("work").classList.remove("collapsed"); $("panel").classList.add("open"); target.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }
  $("coachNext").focus();
}
function coachStop() { S.coach = 0; coachShow(); }

/* ---------------- Keyboard ---------------- */
function setupKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest("input, select, textarea, dialog, [role=slider]")) return;
    if (e.target.closest("button") && (e.key === " " || e.key === "Enter")) return;
    if (!S.frames.length) return;
    const k = e.key;
    if (k === " ") { e.preventDefault(); if (S.mode !== "blink") setMode("blink"); else if (S.blinkTimer) stopBlink(); else startBlink(); }
    else if (k === "ArrowRight" || k === "ArrowLeft") { e.preventDefault(); const i = (S.slot === "a" ? S.a : S.b) + (k === "ArrowRight" ? 1 : -1); assign(S.slot, i); }
    else if (k === "a" || k === "A" || k === "b" || k === "B") { S.slot = k.toLowerCase(); if (S.mode === "single") draw(); updateTimelineMarks(); }
    else if (["1", "2", "3", "4"].includes(k)) setMode(["swipe", "blink", "difference", "single"][+k - 1]);
    else if (k === "m" || k === "M") setTool("mark");
    else if (k === "v" || k === "V") setTool("inspect");
    else if (k === "+" || k === "=") zoomAt(1.6, ...viewCenter());
    else if (k === "-") zoomAt(1 / 1.6, ...viewCenter());
    else if (k === "0") fit();
  });
}

/* ---------------- Wiring ---------------- */
function setup() {
  setupSettings();
  applyStaticText();
  setupViewer();
  setupKeys();
  document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  document.querySelectorAll("[data-slot]").forEach((b) => (b.onclick = () => { S.slot = b.dataset.slot; if (S.mode === "single") draw(); updateTimelineMarks(); updateHint(); }));
  $("prevBtn").onclick = () => assign(S.slot, (S.slot === "a" ? S.a : S.b) - 1);
  $("nextBtn").onclick = () => assign(S.slot, (S.slot === "a" ? S.a : S.b) + 1);
  $("blinkBtn").onclick = () => (S.blinkTimer ? stopBlink() : startBlink());
  $("blinkSpeed").onchange = (e) => { S.blinkMs = +e.target.value; if (S.blinkTimer) startBlink(); };
  $("contrastSel").onchange = (e) => { S.contrast = e.target.value; if (S.frames.length) { restyle(); draw(); saveUrl(); } };
  $("newCandidate").onclick = () => { newCandidate(); setTool("mark"); };
  $("noteIn").oninput = (e) => { S.note = e.target.value.slice(0, LIMITS.note); $("noteCount").textContent = t("note.count", { n: S.note.length, max: LIMITS.note }); saveUrl(); };
  $("copyBtn").onclick = () => copyLink(); $("cardCopy").onclick = () => copyLink();
  $("exportBtn").onclick = downloadJSON; $("cardExport").onclick = downloadJSON;
  $("importIn").onchange = (e) => { importJSON(e.target.files[0]); e.target.value = ""; };
  $("cardBtn").onclick = openCard;
  $("cardClose").onclick = () => $("card").close();
  $("cardPrint").onclick = () => window.print();
  $("fieldBtn").onclick = () => ($("region").hidden ? openRegion() : closeRegion());
  $("regionClose").onclick = closeRegion;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("region").hidden) { closeRegion(); $("fieldBtn").focus(); } });
  $("searchForm").onsubmit = (e) => {
    e.preventDefault();
    const ra = Number($("raIn").value.replace(",", ".")), dec = Number($("decIn").value.replace(",", "."));
    if (!$("raIn").value.trim() || !$("decIn").value.trim() || !Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 360 || dec < -90 || dec > 90) {
      setSearchStatus(h("p", { class: "err" }, t("search.invalid"))); return;
    }
    setPin(ra, dec); coachStop();
    runSearch(ra, dec, $("bandSel").value);
  };
  $("cancelBtn").onclick = () => search?.controller.abort();
  $("startBtn").onclick = coachStart;
  $("coachNext").onclick = () => { if (S.coach >= 4) coachStop(); else { S.coach++; coachShow(); } };
  $("coachClose").onclick = coachStop;
  $("panelBtn").onclick = () => {
    const collapsed = $("work").classList.toggle("collapsed");
    $("panelBtn").setAttribute("aria-expanded", String(!collapsed));
    $("panelBtn").setAttribute("aria-label", t(collapsed ? "panel.expand" : "panel.collapse"));
    requestAnimationFrame(fit);
  };
  $("sheetHandle").onclick = () => { const open = $("panel").classList.toggle("open"); $("sheetHandle").setAttribute("aria-expanded", String(open)); };
  window.addEventListener("hashchange", () => { try { const st = decodeHash(location.hash); if (st && JSON.stringify(st) !== JSON.stringify(currentStateSafe())) restoreState(st); } catch (e) { veilError(stateErrorText(e), [exampleButton()]); } });
}
function currentStateSafe() { try { return S.frames.length ? currentState() : null; } catch { return null; } }

async function main() {
  setup();
  let st = null;
  try { st = decodeHash(location.hash); }
  catch (e) { veilError(stateErrorText(e), [exampleButton()]); return; }
  if (st) await restoreState(st);
  else await openExample("cats-eye");
}
main();

// Exposed for automated browser checks only (read-only snapshot).
window.__nighttrace = { state: () => ({ a: S.a, b: S.b, mode: S.mode, frames: S.frames.length, candidates: S.candidates.map((c) => ({ c: c.c, n: c.points.length })), pair: S.pair && { level: S.pair.level, differenceAllowed: S.pair.differenceAllowed, shift: S.pair.shift } }) };
