// Field grid geometry and coordinate formatting.
// Mirrors nighttrace/wcs.py FieldGrid: TAN projection centred on the field,
// north up, east left, pixel (0,0) = top-left pixel centre.

const D2R = Math.PI / 180;

export function makeGrid(g) {
  const ra0 = g.crval[0], dec0 = g.crval[1];
  const scale = g.pixel_arcsec / 3600;
  const c = (g.size - 1) / 2;
  return {
    ra: ra0, dec: dec0, size: g.size, pixelArcsec: g.pixel_arcsec,
    toSky(px, py) {
      const xi = -(px - c) * scale * D2R, eta = (c - py) * scale * D2R;
      const d0 = dec0 * D2R, rho = Math.hypot(xi, eta), cc = Math.atan(rho);
      if (rho === 0) return [ra0, dec0];
      const dec = Math.asin(Math.cos(cc) * Math.sin(d0) + eta * Math.sin(cc) * Math.cos(d0) / rho);
      const ra = ra0 * D2R + Math.atan2(xi * Math.sin(cc), rho * Math.cos(d0) * Math.cos(cc) - eta * Math.sin(d0) * Math.sin(cc));
      return [((ra / D2R) % 360 + 360) % 360, dec / D2R];
    },
    toPixel(ra, dec) {
      const a = ra * D2R, d = dec * D2R, a0 = ra0 * D2R, d0 = dec0 * D2R;
      const cosc = Math.sin(d) * Math.sin(d0) + Math.cos(d) * Math.cos(d0) * Math.cos(a - a0);
      if (cosc <= 0) return [NaN, NaN];
      const xi = Math.cos(d) * Math.sin(a - a0) / cosc;
      const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
      return [c - xi / D2R / scale, c - eta / D2R / scale];
    },
  };
}

// Great-circle separation in arcseconds.
export function separationArcsec(ra1, dec1, ra2, dec2) {
  const a = Math.sin((dec2 - dec1) * D2R / 2) ** 2 +
    Math.cos(dec1 * D2R) * Math.cos(dec2 * D2R) * Math.sin((ra2 - ra1) * D2R / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / D2R * 3600;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

export function fmtRA(deg) {
  if (!Number.isFinite(deg)) return "—";
  const h = ((deg / 15) % 24 + 24) % 24;
  let H = Math.floor(h), M = Math.floor((h - H) * 60), S = ((h - H) * 60 - M) * 60;
  if (S >= 59.95) { S = 0; M += 1; } if (M >= 60) { M = 0; H = (H + 1) % 24; }
  return `${pad(H)}h${pad(M)}m${S.toFixed(1).padStart(4, "0")}s`;
}

export function fmtDec(deg) {
  if (!Number.isFinite(deg)) return "—";
  const sign = deg < 0 ? "−" : "+", a = Math.abs(deg);
  let D = Math.floor(a), M = Math.floor((a - D) * 60), S = Math.round(((a - D) * 60 - M) * 60);
  if (S === 60) { S = 0; M += 1; } if (M === 60) { M = 0; D += 1; }
  return `${sign}${pad(D)}°${pad(M)}′${pad(S)}″`;
}

export const fmtDeg = (v, digits = 4) => Number.isFinite(v) ? v.toFixed(digits) + "°" : "—";

// Bilinear lookup in the server-provided wavelength grid. Returns [lambda, bandwidth] or null.
export function waveAt(waveGrid, px, py) {
  if (!waveGrid) return null;
  const p = waveGrid.pixels, n = waveGrid.size;
  const find = (v) => Math.max(0, Math.min(n - 2, p.findIndex((x, i) => i < n - 1 && v <= p[i + 1])));
  const ix = find(px), iy = find(py);
  const fx = Math.max(0, Math.min(1, (px - p[ix]) / (p[ix + 1] - p[ix])));
  const fy = Math.max(0, Math.min(1, (py - p[iy]) / (p[iy + 1] - p[iy])));
  const out = [];
  for (const key of ["wavelength_um", "bandwidth_um"]) {
    const t = waveGrid[key];
    const v = [t[iy][ix], t[iy][ix + 1], t[iy + 1][ix], t[iy + 1][ix + 1]];
    if (v.some((x) => x === null || x === undefined)) return null;
    out.push(v[0] * (1 - fx) * (1 - fy) + v[1] * fx * (1 - fy) + v[2] * (1 - fx) * fy + v[3] * fx * fy);
  }
  return out;
}
