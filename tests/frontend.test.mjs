// Browser-module tests, run with: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { encodeHash, decodeHash, parseImport, validateState, StateError, LIMITS, EXPORT_FORMAT } from "../public/js/state.js";
import { makeGrid, separationArcsec, fmtRA, fmtDec, waveAt } from "../public/js/sky.js";
import { bandOverlap, overlapLevel, residualShift, pairChecks, candidateFacts, frameStats } from "../public/js/checks.js";
import { decodeNTF, gunzipIfNeeded } from "../public/js/ntf.js";
import { DICTS } from "../public/js/i18n.js";

const A = "dr1:l2b-v27-2026-211:2026W01_1A_0076_1:1", B = "dr1:l2b-v27-2026-211:2026W01_1A_0631_1:1";
const base = () => ({ v: 1, src: { ex: "cats-eye", ra: 269.6392, dec: 66.6331, ids: [A, B] }, a: A, b: B, mode: "swipe",
  marks: [{ c: "motion", p: [[A, 269.6596, 66.62824], [B, 269.6188, 66.62824]] }], note: "Тест <b>&</b>" });

test("state survives a link round trip", () => {
  const hash = encodeHash(base());
  assert.ok(hash.startsWith("o=1."));
  assert.deepEqual(decodeHash("#" + hash), validateState(base()));
});

test("state rejects tampered or oversized input", () => {
  const bad = [
    (s) => { s.v = 2; }, (s) => { s.src.ids = [A]; }, (s) => { s.a = "x"; }, (s) => { s.b = s.a; },
    (s) => { s.src.ids[1] = "https://evil.example"; }, (s) => { s.marks[0].c = "planet"; }, (s) => { s.marks[0].p[0][1] = 999; },
    (s) => { s.note = "x".repeat(LIMITS.note + 1); }, (s) => { s.marks[0].p.push([A, 1, 1]); }, (s) => { s.src.ra = NaN; },
  ];
  for (const mutate of bad) { const s = base(); mutate(s); assert.throws(() => validateState(s), StateError); }
  assert.throws(() => decodeHash("#o=1.%%%"), StateError);
  assert.throws(() => decodeHash("#o=9.abc"), (e) => e.code === "newer_version");
  assert.equal(decodeHash(""), null);
});

test("JSON import checks format and version", () => {
  const doc = { format: EXPORT_FORMAT, format_version: 1, state: base() };
  assert.equal(parseImport(JSON.stringify(doc)).note, base().note);
  assert.throws(() => parseImport("{"), (e) => e.code === "json");
  assert.throws(() => parseImport(JSON.stringify({ ...doc, format: "other" })), (e) => e.code === "format");
  assert.throws(() => parseImport("x".repeat(LIMITS.json + 1)), (e) => e.code === "too_large");
});

test("field grid matches the server convention", () => {
  const g = makeGrid({ crval: [269.6392, 66.6331], size: 512, pixel_arcsec: 6.15 });
  const [ra, dec] = g.toSky(255.5, 255.5);
  assert.ok(Math.abs(ra - 269.6392) < 1e-9 && Math.abs(dec - 66.6331) < 1e-9);
  const [px, py] = g.toPixel(...g.toSky(37, 410));
  assert.ok(Math.abs(px - 37) < 1e-6 && Math.abs(py - 410) < 1e-6);
  assert.ok(g.toSky(255.5, 0)[1] > 66.6331, "row 0 is north");
  assert.ok(Math.abs(separationArcsec(10, 0, 10, 1 / 3600) - 1) < 1e-6);
  assert.equal(fmtRA(269.6392), "17h58m33.4s");
  assert.equal(fmtDec(-5.391), "−05°23′28″");
});

test("wavelength lookup interpolates the server grid", () => {
  const grid = { size: 2, pixels: [0, 511], wavelength_um: [[0.9, 1.0], [0.9, 1.0]], bandwidth_um: [[0.02, 0.02], [0.02, 0.02]] };
  const [lam, bw] = waveAt(grid, 255.5, 100);
  assert.ok(Math.abs(lam - 0.95) < 1e-9 && bw === 0.02);
  assert.equal(waveAt({ ...grid, wavelength_um: [[null, 1], [0.9, 1]] }, 10, 10), null);
});

test("band overlap levels", () => {
  assert.equal(overlapLevel(bandOverlap(0.9, 0.024, 0.9, 0.024)), "comparable");
  assert.equal(overlapLevel(bandOverlap(0.9028, 0.0236, 0.9495, 0.0242)), "different");
  assert.equal(overlapLevel(bandOverlap(0.9, 0.024, 0.918, 0.024)), "partial");
  assert.equal(overlapLevel(null), "unknown");
});

function synthetic(shiftX = 0, shiftY = 0, seed = 1) {
  const n = 256, data = new Float32Array(n * n), flags = new Uint8Array(n * n);
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const stars = Array.from({ length: 120 }, () => [rnd() * n, rnd() * n, 5 + rnd() * 40]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = 1 + (rnd() - 0.5) * 0.2;
    for (const [sx, sy, f] of stars) { const d2 = (x - sx - shiftX) ** 2 + (y - sy - shiftY) ** 2; if (d2 < 30) v += f * Math.exp(-d2 / 2.5); }
    data[y * n + x] = v;
  }
  const frame = { data, flags, width: n, height: n };
  frame.stats = frameStats(frame);
  return frame;
}

test("residual shift measures a known misregistration", () => {
  const a = synthetic(0, 0), b = synthetic(1.4, -0.6);
  const s = residualShift(a, b, 256, 96, 3);
  assert.ok(Math.abs(s.dx - 1.4) < 0.3 && Math.abs(s.dy + 0.6) < 0.3, JSON.stringify(s));
  const same = residualShift(a, synthetic(0, 0), 256, 96, 3);
  assert.ok(same.total < 0.1);
});

test("checks never mark unknowns as passed and gate the difference mode", () => {
  const info = (lam, date) => ({ id: date, date_avg: date, wavelength_um: lam, bandwidth_um: 0.024, l2_dqa: "Pass",
    processing_version: "v", detector: 1, release: "DR1", astrometry_solved: true, psf_fwhm_arcsec: 7.5 });
  const a = synthetic(), b = synthetic();
  a.info = info(0.90, "2025-01-01T00:00:00Z"); b.info = info(0.95, "2025-01-04T00:00:00Z");
  const r = pairChecks(a, b, { dx: 0, dy: 0, total: 0, atEdge: false });
  assert.equal(r.level, "different");
  assert.equal(r.differenceAllowed, false);
  for (const id of ["ephemeris", "catalogs", "photometry"]) assert.equal(r.checks.find((c) => c.id === id).status, "unchecked");
  assert.equal(pairChecks(a, b, null).checks.find((c) => c.id === "registration").status, "unchecked");
  b.info = info(0.901, "2025-01-04T00:00:00Z");
  const good = { dx: 0.1, dy: 0, total: 0.1, atEdge: false, correlation: 0.9, reliable: true };
  assert.equal(pairChecks(a, b, good).differenceAllowed, true);
});

test("difference stays closed when quality, astrometry or alignment are not established", () => {
  const info = (over = {}) => ({ id: "x", date_avg: "2025-01-01T00:00:00Z", wavelength_um: 0.9, bandwidth_um: 0.024, l2_dqa: "Pass",
    processing_version: "v", detector: 1, release: "DR1", astrometry_solved: true, psf_fwhm_arcsec: 7.5, ...over });
  const a = synthetic(), b = synthetic();
  const good = { dx: 0.1, dy: 0, total: 0.1, atEdge: false, correlation: 0.9, reliable: true };
  const run = (ia, ib, shift = good) => { a.info = info(ia); b.info = { ...info(ib), date_avg: "2025-01-04T00:00:00Z" }; return pairChecks(a, b, shift); };
  // The reviewer's case: DQA Fail, astrometry not solved, tiny shift with correlation 0.01.
  const r = run({ l2_dqa: "Fail" }, { astrometry_solved: false }, { dx: 0.1, dy: 0, total: 0.1, atEdge: false, correlation: 0.01, reliable: false });
  assert.equal(r.differenceAllowed, false);
  assert.notEqual(r.checks.find((c) => c.id === "registration").status, "ok");
  assert.equal(r.checks.find((c) => c.id === "quality").status, "fail");
  assert.deepEqual([...r.blockers].sort(), ["astrometry", "quality", "registration_unreliable"]);
  assert.equal(run({ l2_dqa: "Fail" }, {}).differenceAllowed, false);
  assert.equal(run({}, { l2_dqa: undefined }).differenceAllowed, false, "unknown DQA is not a pass");
  assert.equal(run({}, { astrometry_solved: false }).differenceAllowed, false);
  assert.equal(run({}, { astrometry_solved: undefined }).differenceAllowed, false);
  const weak = run({}, {}, { ...good, correlation: 0.2, reliable: false });
  assert.equal(weak.differenceAllowed, false);
  assert.equal(weak.checks.find((c) => c.id === "registration").status, "unchecked");
  assert.equal(run({}, {}, { ...good, total: 0.8, dx: 0.8 }).differenceAllowed, false);
  assert.equal(run({}, {}).differenceAllowed, true);
});

test("residual shift on unrelated frames is not reported as reliable", () => {
  const s = residualShift(synthetic(0, 0, 1), synthetic(0, 0, 999), 256, 96, 3);
  assert.equal(s.reliable, false, JSON.stringify(s));
  assert.equal(residualShift(synthetic(), synthetic(0.3, 0.2), 256, 96, 3).reliable, true);
});

test("every difference blocker has an explanation in both languages", () => {
  for (const b of ["wavelength", "coverage", "quality", "registration_unreliable", "registration_shift", "astrometry"])
    for (const lang of ["ru", "en"]) assert.ok(DICTS[lang][`mode.blocker.${b}`], `${lang} ${b}`);
});

test("an example link may reference marks on many frames without losing any", () => {
  const ids = Array.from({ length: 15 }, (_, i) => `dr1:l2b-v27-2026-211:2026W01_1A_${String(i + 100).padStart(4, "0")}_1:1`);
  const s = { v: 1, src: { ex: "cats-eye", ra: 269.6392, dec: 66.6331, ids }, a: ids[0], b: ids[14], mode: "swipe",
    marks: [{ c: "motion", p: ids.slice(0, 8).map((id, i) => [id, 269.6 + i * 1e-3, 66.6]) }, { c: "unsure", p: ids.slice(8).map((id) => [id, 269.6, 66.6]) }], note: "" };
  const v = validateState(s);
  assert.equal(v.src.ids.length, 15);
  assert.equal(v.marks.flatMap((m) => m.p).length, 15);
  assert.deepEqual(decodeHash("#" + encodeHash(s)), v);
  // A search link is restored through /api/observations (8 ids at most): more is rejected, not cut.
  assert.throws(() => validateState({ ...s, src: { ...s.src, ex: undefined, ids: ids.slice(0, 9) } }), (e) => e.code === "frames");
});

test("a state too large for a link is still valid for the JSON file", () => {
  const ids = Array.from({ length: 15 }, (_, i) => `dr1:l2b-v27-2026-211:2026W01_1A_${String(i + 100).padStart(4, "0")}_1:1`);
  const marks = Array.from({ length: LIMITS.candidates }, (_, c) => ({ c: "unsure", p: ids.map((id, i) => [id, 269.6 + c * 1e-3 + i * 1e-4, 66.6 + i * 1e-4]) }));
  const s = { v: 1, src: { ex: "cats-eye", ra: 269.6392, dec: 66.6331, ids }, a: ids[0], b: ids[1], mode: "swipe", marks, note: "ж".repeat(LIMITS.note) };
  assert.throws(() => encodeHash(s), (e) => e.code === "too_large");
  const doc = { format: EXPORT_FORMAT, format_version: 1, state: validateState(s) };
  assert.equal(parseImport(JSON.stringify(doc)).marks.length, LIMITS.candidates);
});

test("contrast and view are saved and validated", () => {
  const s = { ...base(), contrast: "strong", view: { z: 3.25, x: 300.5, y: 120 } };
  const back = decodeHash("#" + encodeHash(s));
  assert.equal(back.contrast, "strong");
  assert.deepEqual(back.view, { z: 3.25, x: 300.5, y: 120 });
  for (const bad of [{ contrast: "max" }, { view: { z: 1e6, x: 0, y: 0 } }, { view: { z: 2, x: NaN, y: 0 } }, { view: "big" }])
    assert.throws(() => validateState({ ...base(), ...bad }), StateError);
  assert.equal(validateState(base()).view, undefined, "old links without view still work");
});

test("candidate facts measure offsets and keep explanations open", () => {
  const g = makeGrid({ crval: [100, 10], size: 256, pixel_arcsec: 6.15 });
  const a = synthetic(), b = synthetic();
  a.info = { id: "A", date_avg: "2025-01-01T00:00:00Z", wave_grid: null };
  b.info = { id: "B", date_avg: "2025-01-01T10:00:00Z", wave_grid: null };
  const [ra1, dec1] = g.toSky(100, 100), [ra2, dec2] = g.toSky(110, 100);
  const f = candidateFacts({ points: [{ frame: "B", ra: ra2, dec: dec2 }, { frame: "A", ra: ra1, dec: dec1 }] }, [a, b], g, { total: 0.1 });
  assert.ok(Math.abs(f.separationPx - 10) < 0.01 && Math.abs(f.dtHours - 10) < 1e-9);
  const ex = Object.fromEntries(f.explanations.map((e) => [e.id, e]));
  assert.equal(ex.motion.why, "offset_measured");
  assert.notEqual(ex.motion.status, "ok", "motion is never declared confirmed");
  assert.equal(ex.spectral.status, "unchecked");
});

test("NTF decoder reads gzip frames written by the server", async () => {
  const buf = readFileSync(new URL("../public/data/examples/orion/frames/2026W11_2A_0519_1_D1.ntf", import.meta.url));
  const raw = await gunzipIfNeeded(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const f = decodeNTF(raw);
  assert.equal(f.width, 512);
  assert.ok(f.data.some(Number.isFinite));
  assert.throws(() => decodeNTF(new ArrayBuffer(20)));
});

test("Russian and English dictionaries have the same keys and placeholders", () => {
  const ru = DICTS.ru, en = DICTS.en;
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  for (const k of Object.keys(ru)) {
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(ph(ru[k]), ph(en[k]), k);
  }
});

test("every interface key used in HTML and app.js exists", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../public/js/app.js", import.meta.url), "utf8");
  const keys = new Set([...html.matchAll(/data-i18n(?:-label|-ph)?="([^"]+)"/g)].map((m) => m[1]));
  for (const m of js.matchAll(/\bt\("([a-z][\w.-]+)"/g)) keys.add(m[1]);
  for (const k of keys) assert.ok(k in DICTS.ru, k);
});

test("ephemeris check is informative only with prepared positions for both frames", () => {
  const info = (id, date) => ({ id, date_avg: date, wavelength_um: 0.81, bandwidth_um: 0.02, l2_dqa: "Pass",
    processing_version: "v", detector: 1, release: "DR1", astrometry_solved: true, psf_fwhm_arcsec: 7.5 });
  const a = synthetic(), b = synthetic();
  a.info = info("A", "2026-04-25T05:37:21Z"); b.info = info("B", "2026-04-27T21:10:15Z");
  const eph = { object: { en: "Pluto" }, source: "DE421", positions: { A: { ra: 308.518908, dec: -22.889286 }, B: { ra: 308.533885, dec: -22.894766 } } };
  const r = pairChecks(a, b, null, eph).checks.find((c) => c.id === "ephemeris");
  assert.equal(r.status, "info");
  assert.ok(Math.abs(r.values.motionArcsec - 53.4) < 0.5, String(r.values.motionArcsec));
  const none = pairChecks(a, b, null, { ...eph, positions: { A: eph.positions.A } }).checks.find((c) => c.id === "ephemeris");
  assert.equal(none.status, "unchecked");
});
