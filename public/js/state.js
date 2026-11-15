// Shareable observation state: versioned, validated, size-limited.
// Small state lives in the URL fragment (#o=...), which never reaches a server.
// Images and FITS files are never put into the URL — only frame identifiers.

export const STATE_VERSION = 1;
// frames: an example link may reference any of its prepared frames (the largest has 15);
// a search link is restored through /api/observations, which accepts at most 8 ids.
export const LIMITS = { frames: 16, searchFrames: 8, candidates: 12, points: 16, note: 1000, hash: 16000, json: 300000 };
export const CONTRASTS = ["soft", "normal", "strong"];
export const CATEGORIES = ["motion", "brightness", "artifact", "unsure"];
export const MODES = ["swipe", "blink", "difference", "single"];
const TOKEN = /^(dr1|qr3|qr2):l2b(?:_[a-z]+)?-v\d{1,3}-\d{4}-\d{3}:\d{4}W\d{2}_\d[A-Z]_\d{4}_\d:[1-6]$/;
const EXAMPLE = /^[a-z0-9-]{1,32}$/;
const BANDS = ["0.9", "1.3", "2.0", "3.0", "4.1", "4.7"];

export class StateError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

export function validateState(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new StateError("shape");
  if (s.v !== STATE_VERSION) throw new StateError(typeof s.v === "number" && s.v > STATE_VERSION ? "newer_version" : "version");
  const src = s.src;
  if (!src || typeof src !== "object") throw new StateError("source");
  const out = { v: STATE_VERSION, src: {} };
  if (src.ex !== undefined) {
    if (typeof src.ex !== "string" || !EXAMPLE.test(src.ex)) throw new StateError("source");
    out.src.ex = src.ex;
  }
  if (!finite(src.ra) || !finite(src.dec) || src.ra < 0 || src.ra >= 360 || src.dec < -90 || src.dec > 90) throw new StateError("coordinates");
  out.src.ra = round(src.ra, 4); out.src.dec = round(src.dec, 4);
  const maxFrames = out.src.ex ? LIMITS.frames : LIMITS.searchFrames;
  if (!Array.isArray(src.ids) || src.ids.length < 2 || src.ids.length > maxFrames) throw new StateError("frames");
  if (!src.ids.every((t) => typeof t === "string" && TOKEN.test(t)) || new Set(src.ids).size !== src.ids.length) throw new StateError("frames");
  out.src.ids = [...src.ids];
  if (src.band !== undefined) { if (!BANDS.includes(src.band)) throw new StateError("band"); out.src.band = src.band; }
  for (const k of ["a", "b"]) {
    if (!out.src.ids.includes(s[k])) throw new StateError("selection");
    out[k] = s[k];
  }
  if (out.a === out.b) throw new StateError("selection");
  out.mode = MODES.includes(s.mode) ? s.mode : "swipe";
  if (s.contrast !== undefined) { if (!CONTRASTS.includes(s.contrast)) throw new StateError("view"); out.contrast = s.contrast; }
  if (s.view !== undefined) {
    const v = s.view;
    if (!v || typeof v !== "object" || !finite(v.z) || !finite(v.x) || !finite(v.y) || v.z < 0.5 || v.z > 64 || v.x < -64 || v.x > 576 || v.y < -64 || v.y > 576) throw new StateError("view");
    out.view = { z: round(v.z, 3), x: round(v.x, 1), y: round(v.y, 1) };
  }
  const marks = s.marks ?? [];
  if (!Array.isArray(marks) || marks.length > LIMITS.candidates) throw new StateError("marks");
  out.marks = marks.map((c) => {
    if (!c || !CATEGORIES.includes(c.c) || !Array.isArray(c.p) || c.p.length < 1 || c.p.length > LIMITS.points) throw new StateError("marks");
    const seen = new Set();
    return { c: c.c, p: c.p.map((p) => {
      if (!Array.isArray(p) || p.length !== 3 || !out.src.ids.includes(p[0]) || seen.has(p[0])) throw new StateError("marks");
      if (!finite(p[1]) || !finite(p[2]) || p[1] < 0 || p[1] >= 360 || p[2] < -90 || p[2] > 90) throw new StateError("marks");
      seen.add(p[0]);
      return [p[0], round(p[1], 6), round(p[2], 6)];
    }) };
  });
  const note = s.note ?? "";
  if (typeof note !== "string" || note.length > LIMITS.note) throw new StateError("note");
  out.note = note;
  return out;
}

const b64url = {
  encode(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(s) {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new StateError("encoding");
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  },
};

export function encodeHash(state) {
  const clean = validateState(state);
  const encoded = "o=" + STATE_VERSION + "." + b64url.encode(JSON.stringify(clean));
  if (encoded.length > LIMITS.hash) throw new StateError("too_large");
  return encoded;
}

export function decodeHash(hash) {
  const h = (hash || "").replace(/^#/, "");
  if (!h) return null;
  if (h.length > LIMITS.hash + 10) throw new StateError("too_large");
  if (!h.startsWith("o=")) return null;
  const m = /^o=(\d+)\.([A-Za-z0-9_-]+)$/.exec(h);
  if (!m) throw new StateError("encoding");
  if (+m[1] !== STATE_VERSION) throw new StateError(+m[1] > STATE_VERSION ? "newer_version" : "version");
  let parsed;
  try { parsed = JSON.parse(b64url.decode(m[2])); } catch (e) { throw e instanceof StateError ? e : new StateError("encoding"); }
  return validateState(parsed);
}

export const EXPORT_FORMAT = "nighttrace.observation";

export function parseImport(text) {
  if (typeof text !== "string" || text.length > LIMITS.json) throw new StateError("too_large");
  let doc;
  try { doc = JSON.parse(text); } catch { throw new StateError("json"); }
  if (!doc || doc.format !== EXPORT_FORMAT) throw new StateError("format");
  if (doc.format_version !== STATE_VERSION) throw new StateError(doc.format_version > STATE_VERSION ? "newer_version" : "version");
  return validateState(doc.state);
}
