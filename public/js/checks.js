// Measurements and comparability checks. Pure functions, no DOM.
// Every result says how it was obtained; unknowns are "unchecked", never "ok".
import { CAT } from "./ntf.js";
import { separationArcsec, waveAt } from "./sky.js";

export const STATUS = { OK: "ok", WARN: "warn", FAIL: "fail", UNCHECKED: "unchecked", INFO: "info" };
const UNUSABLE = CAT.BAD | CAT.NODATA;
const DEFECT = CAT.TRANSIENT | CAT.ARTIFACT;

function sample(values, step) {
  const out = [];
  for (let i = 0; i < values.length; i += step) if (Number.isFinite(values[i])) out.push(values[i]);
  return out.sort((a, b) => a - b);
}
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : NaN;

// Per-frame robust background (median) and noise (1.4826 * MAD) on usable pixels.
export function frameStats(frame) {
  const { data, flags } = frame;
  const vals = [];
  for (let i = 0; i < data.length; i += 7) if (!(flags[i] & (UNUSABLE | DEFECT)) && Number.isFinite(data[i])) vals.push(data[i]);
  vals.sort((a, b) => a - b);
  const median = quantile(vals, 0.5);
  const dev = vals.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  return { background: median, sigma: 1.4826 * quantile(dev, 0.5), usable: vals.length * 7 / data.length };
}

// One stretch for all frames of a field: asinh between -2 sigma and a high percentile
// of the pooled background-subtracted pixels. contrast picks the percentile.
export function sharedStretch(frames, contrast = "normal") {
  const q = { soft: 0.9995, normal: 0.9985, strong: 0.995 }[contrast] ?? 0.9985;
  const sigmas = frames.map((f) => f.stats.sigma).filter(Number.isFinite).sort((a, b) => a - b);
  const sigma = quantile(sigmas, 0.5);
  const pooled = [];
  for (const f of frames) {
    const s = sample(f.data, 13);
    for (const v of s) pooled.push(v - f.stats.background);
  }
  pooled.sort((a, b) => a - b);
  const low = -2 * sigma, high = Math.max(quantile(pooled, q), low + 10 * sigma), soft = 3 * sigma;
  return { method: "asinh", low, high, soft, sigma, percentile: q, background: "per-frame median" };
}

export function renderGray(frame, stretch, out) {
  const { data } = frame, bg = frame.stats.background;
  const norm = Math.asinh((stretch.high - stretch.low) / stretch.soft);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const v = data[i];
    let g = 0;
    if (Number.isFinite(v)) g = Math.round(255 * Math.min(1, Math.max(0, Math.asinh(Math.max(0, v - bg - stretch.low) / stretch.soft) / norm)));
    out[j] = out[j + 1] = out[j + 2] = g; out[j + 3] = Number.isFinite(v) ? 255 : 0;
  }
}

// B - A on usable, unflagged pixels; gray = 0, white = brighter in B, black = brighter in A.
// The grey scale spans +/- the larger of 6 combined sigma and the 99.5th percentile of |B - A|,
// so a few bright residuals do not saturate the whole picture.
export function renderDifference(a, b, out) {
  const n = a.data.length, d = new Float32Array(n), ok = new Uint8Array(n), mags = [];
  for (let i = 0; i < n; i++) {
    ok[i] = Number.isFinite(a.data[i]) && Number.isFinite(b.data[i]) && !((a.flags[i] | b.flags[i]) & (UNUSABLE | DEFECT)) ? 1 : 0;
    if (ok[i]) { d[i] = (b.data[i] - b.stats.background) - (a.data[i] - a.stats.background); if (i % 5 === 0) mags.push(Math.abs(d[i])); }
  }
  mags.sort((x, y) => x - y);
  const s = Math.max(Math.hypot(a.stats.sigma, b.stats.sigma) * 6, quantile(mags, 0.995)) || 1;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // Flagged pixels get a distinct colour so they never read as "brighter in A" (black).
    if (!ok[i]) { out[j] = 150; out[j + 1] = 105; out[j + 2] = 40; out[j + 3] = Number.isFinite(a.data[i]) && Number.isFinite(b.data[i]) ? 255 : 0; continue; }
    const g = Math.round(128 + 127 * Math.max(-1, Math.min(1, d[i] / s)));
    out[j] = out[j + 1] = out[j + 2] = g; out[j + 3] = 255;
  }
  return { scale: s };
}

// Residual misregistration between two frames already on the same grid:
// cross-correlation of the central region over integer shifts, refined by a parabola.
export const MIN_CORRELATION = 0.5, MIN_PEAK_CONTRAST = 0.05;
export function residualShift(a, b, size, half = 96, maxShift = 3) {
  const c = Math.floor(size / 2);
  const clipA = a.stats.background + 50 * a.stats.sigma, clipB = b.stats.background + 50 * b.stats.sigma;
  const val = (f, clip, x, y) => {
    const i = y * size + x, v = f.data[i];
    if (!Number.isFinite(v) || (f.flags[i] & (UNUSABLE | DEFECT))) return null;
    return Math.min(v, clip) - f.stats.background;
  };
  const score = (dx, dy) => {
    let sab = 0, saa = 0, sbb = 0, n = 0;
    for (let y = c - half; y < c + half; y++) for (let x = c - half; x < c + half; x++) {
      const va = val(a, clipA, x, y), vb = val(b, clipB, x + dx, y + dy);
      if (va === null || vb === null) continue;
      sab += va * vb; saa += va * va; sbb += vb * vb; n++;
    }
    return n > 1000 && saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
  };
  const grid = {};
  let best = null;
  for (let dy = -maxShift; dy <= maxShift; dy++) for (let dx = -maxShift; dx <= maxShift; dx++) {
    const s = score(dx, dy); grid[`${dx},${dy}`] = s;
    if (Number.isFinite(s) && (!best || s > best.s)) best = { dx, dy, s };
  }
  if (!best) return null;
  const refine = (m, z, p) => (Number.isFinite(m) && Number.isFinite(p) && m - 2 * z + p < 0) ? 0.5 * (m - p) / (m - 2 * z + p) : 0;
  const fx = refine(grid[`${best.dx - 1},${best.dy}`], best.s, grid[`${best.dx + 1},${best.dy}`]);
  const fy = refine(grid[`${best.dx},${best.dy - 1}`], best.s, grid[`${best.dx},${best.dy + 1}`]);
  const dx = best.dx + fx, dy = best.dy + fy;
  const atEdge = Math.abs(best.dx) === maxShift || Math.abs(best.dy) === maxShift;
  // A peak is a measurement only when the frames really correlate and the peak is sharp:
  // high correlation, not on the search border, and clearly above the far-off-peak level.
  const far = Object.entries(grid).filter(([k]) => { const [x, y] = k.split(",").map(Number); return Math.max(Math.abs(x - best.dx), Math.abs(y - best.dy)) >= 2; })
    .map(([, v]) => v).filter(Number.isFinite);
  const farMax = far.length ? Math.max(...far) : NaN;
  const contrast = Number.isFinite(farMax) ? best.s - farMax : 0;
  const reliable = !atEdge && best.s >= MIN_CORRELATION && contrast >= MIN_PEAK_CONTRAST;
  return { dx, dy, total: Math.hypot(dx, dy), correlation: best.s, contrast, atEdge, reliable };
}

export function bandOverlap(l1, w1, l2, w2) {
  if (![l1, w1, l2, w2].every(Number.isFinite)) return null;
  const lo = Math.max(l1 - w1 / 2, l2 - w2 / 2), hi = Math.min(l1 + w1 / 2, l2 + w2 / 2);
  return Math.max(0, hi - lo) / Math.min(w1, w2);
}
export const overlapLevel = (o) => o === null ? "unknown" : o >= 0.5 ? "comparable" : o > 0 ? "partial" : "different";

const fracFlag = (f, bit) => { let n = 0, m = 0; for (let i = 0; i < f.flags.length; i++) { if (f.flags[i] & CAT.NODATA) continue; m++; if (f.flags[i] & bit) n++; } return m ? n / m : 0; };
function bothValid(a, b) { let n = 0; for (let i = 0; i < a.data.length; i++) if (Number.isFinite(a.data[i]) && Number.isFinite(b.data[i])) n++; return n / a.data.length; }

// Pair checks. Each: {id, status, values{...}} — the UI turns ids into sentences.
export function pairChecks(A, B, shift, ephemeris = null) {
  const ia = A.info, ib = B.info;
  const dtSec = Math.abs(Date.parse(ib.date_avg) - Date.parse(ia.date_avg)) / 1000;
  const ov = bandOverlap(ia.wavelength_um, ia.bandwidth_um, ib.wavelength_um, ib.bandwidth_um);
  const level = overlapLevel(ov);
  const checks = [];
  checks.push({ id: "interval", status: dtSec < 3600 ? STATUS.INFO : STATUS.OK, values: { dtSec, sameVisit: dtSec < 3600 } });
  checks.push({ id: "wavelength", status: { comparable: STATUS.OK, partial: STATUS.WARN, different: STATUS.FAIL, unknown: STATUS.UNCHECKED }[level],
    values: { la: ia.wavelength_um, wa: ia.bandwidth_um, lb: ib.wavelength_um, wb: ib.bandwidth_um, overlap: ov, level,
      rangeA: ia.wavelength_range_um, rangeB: ib.wavelength_range_um } });
  const both = bothValid(A, B);
  checks.push({ id: "coverage", status: both >= 0.9 ? STATUS.OK : both >= 0.5 ? STATUS.WARN : STATUS.FAIL, values: { both } });
  const qa = { bad: fracFlag(A, CAT.BAD), tr: fracFlag(A, CAT.TRANSIENT), art: fracFlag(A, CAT.ARTIFACT) };
  const qb = { bad: fracFlag(B, CAT.BAD), tr: fracFlag(B, CAT.TRANSIENT), art: fracFlag(B, CAT.ARTIFACT) };
  const worst = Math.max(qa.bad + qa.tr + qa.art, qb.bad + qb.tr + qb.art);
  const dqa = [ia.l2_dqa, ib.l2_dqa];
  const dqaFail = dqa.some((d) => d && d !== "Pass"), dqaKnown = dqa.every((d) => typeof d === "string" && d);
  const qualityStatus = dqaFail ? STATUS.FAIL : worst > 0.1 ? STATUS.WARN : dqaKnown ? STATUS.OK : STATUS.UNCHECKED;
  checks.push({ id: "quality", status: qualityStatus, values: { qa, qb, dqa } });
  const solved = ia.astrometry_solved === true && ib.astrometry_solved === true;
  const unsolved = ia.astrometry_solved === false || ib.astrometry_solved === false;
  let regStatus;
  if (!shift || !shift.reliable) regStatus = shift && shift.atEdge ? STATUS.FAIL : STATUS.UNCHECKED;
  else if (shift.total > 1) regStatus = STATUS.FAIL;
  else if (shift.total > 0.5 || !solved) regStatus = STATUS.WARN;
  else regStatus = STATUS.OK;
  checks.push({ id: "registration", status: regStatus,
    values: { shift, solved, unsolved, reliable: !!shift?.reliable, starsA: ia.astrometry_nstars, starsB: ib.astrometry_nstars } });
  const same = ia.processing_version === ib.processing_version;
  checks.push({ id: "processing", status: same && ia.detector === ib.detector ? STATUS.OK : STATUS.INFO,
    values: { va: ia.processing_version, vb: ib.processing_version, da: ia.detector, db: ib.detector, ra: ia.release, rb: ib.release } });
  const pa = ia.psf_fwhm_arcsec, pb = ib.psf_fwhm_arcsec;
  const psfRatio = Number.isFinite(pa) && Number.isFinite(pb) ? Math.max(pa, pb) / Math.min(pa, pb) : null;
  checks.push({ id: "psf", status: psfRatio === null ? STATUS.UNCHECKED : psfRatio > 1.15 ? STATUS.WARN : STATUS.OK, values: { pa, pb, psfRatio } });
  // Only a prepared, measured ephemeris for this field counts; anything else stays unchecked.
  const ea = ephemeris?.positions?.[ia.id], eb = ephemeris?.positions?.[ib.id];
  if (ea && eb) {
    checks.push({ id: "ephemeris", status: STATUS.INFO, values: { object: ephemeris.object, source: ephemeris.source,
      motionArcsec: separationArcsec(ea.ra, ea.dec, eb.ra, eb.dec), a: ea, b: eb } });
  } else checks.push({ id: "ephemeris", status: STATUS.UNCHECKED, values: {} });
  checks.push({ id: "catalogs", status: STATUS.UNCHECKED, values: {} });
  checks.push({ id: "photometry", status: STATUS.UNCHECKED, values: {} });
  // Difference is a science-like view: allow it only when every precondition was actually verified.
  const blockers = [];
  if (level !== "comparable") blockers.push("wavelength");
  if (both < 0.5) blockers.push("coverage");
  if (!dqaKnown || dqaFail) blockers.push("quality");
  if (!shift || !shift.reliable) blockers.push("registration_unreliable");
  else if (shift.total > 0.5) blockers.push("registration_shift");
  if (!solved) blockers.push("astrometry");
  const differenceAllowed = blockers.length === 0;
  return { checks, level, overlap: ov, dtSec, differenceAllowed, blockers };
}

// Measurements at one marked position in one frame (3x3 pixel box, background subtracted).
export function measureAt(frame, grid, ra, dec) {
  const [px, py] = grid.toPixel(ra, dec);
  const x = Math.round(px), y = Math.round(py), n = grid.size;
  if (!(x >= 1 && y >= 1 && x < n - 1 && y < n - 1)) return { inside: false };
  let sum = 0, count = 0, flags = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const i = (y + dy) * n + (x + dx);
    flags |= frame.flags[i];
    if (Number.isFinite(frame.data[i])) { sum += frame.data[i] - frame.stats.background; count++; }
  }
  const wave = waveAt(frame.info.wave_grid, px, py);
  return { inside: true, px, py, sum: count ? sum * 9 / count : null, snr: count ? (sum / count) / frame.stats.sigma : null,
    flags, defect: !!(flags & DEFECT), bad: !!(flags & UNUSABLE), wavelength: wave?.[0] ?? null, bandwidth: wave?.[1] ?? null };
}

// Facts for one candidate across the frames where it was marked.
export function candidateFacts(candidate, frames, grid, shift) {
  const byId = new Map(frames.map((f) => [f.info.id, f]));
  const points = candidate.points.filter((p) => byId.has(p.frame))
    .map((p) => ({ ...p, frameObj: byId.get(p.frame), time: Date.parse(byId.get(p.frame).info.date_avg) }))
    .sort((p, q) => p.time - q.time);
  const measures = points.map((p) => ({ frame: p.frame, date: p.frameObj.info.date_avg, ...measureAt(p.frameObj, grid, p.ra, p.dec) }));
  const facts = { points: points.length, measures };
  if (points.length >= 2) {
    const first = points[0], last = points[points.length - 1];
    facts.separation = separationArcsec(first.ra, first.dec, last.ra, last.dec);
    facts.separationPx = facts.separation / grid.pixelArcsec;
    facts.dtHours = (last.time - first.time) / 3.6e6;
    facts.rate = facts.dtHours > 0 ? facts.separation / facts.dtHours : null;
    const m0 = measures[0], m1 = measures[measures.length - 1];
    facts.overlapAtMark = bandOverlap(m0.wavelength, m0.bandwidth, m1.wavelength, m1.bandwidth);
  }
  const anyDefect = measures.some((m) => m.defect || m.bad);
  const shiftPx = shift ? shift.total : null;
  const exp = [];
  // Motion
  if (points.length < 2) exp.push({ id: "motion", status: STATUS.UNCHECKED, why: "one_position" });
  else if (facts.separationPx < 1.5) exp.push({ id: "motion", status: STATUS.INFO, why: "below_pixel" });
  else exp.push({ id: "motion", status: STATUS.WARN, why: "offset_measured" });
  // Registration error
  if (points.length < 2) exp.push({ id: "registration", status: STATUS.UNCHECKED, why: "one_position" });
  else if (shiftPx === null) exp.push({ id: "registration", status: STATUS.UNCHECKED, why: "no_shift" });
  else if (facts.separationPx <= shiftPx + 1) exp.push({ id: "registration", status: STATUS.WARN, why: "comparable_to_shift" });
  else exp.push({ id: "registration", status: STATUS.OK, why: "larger_than_shift" });
  // Image defect
  exp.push({ id: "defect", status: anyDefect ? STATUS.WARN : STATUS.INFO, why: anyDefect ? "flagged" : "no_flags" });
  // Spectral difference
  const ov = facts.overlapAtMark;
  exp.push({ id: "spectral", status: ov === undefined || ov === null ? STATUS.UNCHECKED : ov >= 0.5 ? STATUS.OK : STATUS.WARN,
    why: ov === undefined || ov === null ? "unknown" : ov >= 0.5 ? "overlap" : "no_overlap" });
  // Brightness change
  const sums = measures.filter((m) => m.inside && m.sum !== null);
  exp.push({ id: "brightness", status: sums.length >= 2 ? STATUS.INFO : STATUS.UNCHECKED, why: sums.length >= 2 ? "measured" : "one_position" });
  facts.explanations = exp;
  return facts;
}
