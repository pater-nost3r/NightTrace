"""Add Pluto's predicted positions to the "pluto" example and check them against the frames.

    pip install jplephem de421          # local only, not needed on Vercel
    python scripts/build_examples.py pluto
    python scripts/pluto_ephemeris.py

Ephemeris: JPL DE421 (the `de421` package, Pluto system barycentre), GEOCENTRIC astrometric
ICRS position with light-time iteration; UTC -> TDB as UTC + 69.184 s. SPHEREx is not at the
geocentre: it orbits ~650 km above the surface, i.e. ~7000 km from the Earth's centre, which
at Pluto's ~5e9 km shifts the apparent position by up to ~0.29". That is small against the
6.15" pixel, so the geocentric position is fine for a visual example, but it is comparable to
the 0.1-0.5" residuals below: sub-arcsecond absolute accuracy is NOT established (that would
need the SPHEREx position, the WCS accuracy and a full astrometric error budget).
For every frame the script measures the brightest pixel within 3 px of the prediction and its
3x3 centroid offset. "Contrast" is peak / (1.4826 * MAD of the whole frame): an estimate of how
far the peak stands above the background scatter, not a full signal-to-noise ratio (no noise
model, no source variance, reprojection correlates pixels). It also reports the largest
contrast at the predicted positions of the other epochs that are at least 3 px away (closer
epochs are skipped). The numbers are written to the manifest so the interface can show them.
"""
import gzip
import json
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from nighttrace import field  # noqa: E402

import de421  # noqa: E402
from jplephem.ephem import Ephemeris  # noqa: E402

E = Ephemeris(de421)
C_KM_S = 299792.458


def jd_tdb(iso):
    from datetime import datetime
    return 2440587.5 + datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() / 86400 + 69.184 / 86400


def earth(jd):
    return (E.position("earthmoon", jd) - E.position("moon", jd) / (1.0 + E.EMRAT)).ravel()


def pluto(jd):
    o, lt = earth(jd), 0.0
    for _ in range(3):
        p = E.position("pluto", jd - lt / 86400).ravel()
        lt = np.linalg.norm(p - o) / C_KM_S
    v = p - o
    return float(np.degrees(np.arctan2(v[1], v[0])) % 360), float(np.degrees(np.arcsin(v[2] / np.linalg.norm(v))))


def load(path):
    raw = gzip.decompress(path.read_bytes())
    w, h = (int(x) for x in np.frombuffer(raw[4:8], "<u2"))
    n = w * h
    return np.frombuffer(raw[12:12 + 2 * n], "<f2").astype(float).reshape(h, w)


def main():
    path = ROOT / "public" / "data" / "examples" / "pluto" / "manifest.json"
    m = json.loads(path.read_text(encoding="utf-8"))
    grid = field.grid_for(m["field"]["ra"], m["field"]["dec"])
    pred = {}
    for f in m["frames"]:
        ra, dec = pluto(jd_tdb(f["date_avg"]))
        px, py = grid.pixel(ra, dec)
        pred[f["id"]] = (ra, dec, float(px), float(py))
    positions = {}
    for f in m["frames"]:
        d = load(ROOT / "public" / f["file"])
        ra, dec, px, py = pred[f["id"]]
        bg = np.nanmedian(d)
        sig = 1.4826 * np.nanmedian(np.abs(d - bg))
        x, y = round(px), round(py)
        box = d[y - 3:y + 4, x - 3:x + 4] - bg
        by, bx = divmod(int(np.nanargmax(box)), 7)
        yy, xx = y - 3 + by, x - 3 + bx
        b = np.clip(d[yy - 1:yy + 2, xx - 1:xx + 2] - bg, 0, None)
        cy = yy + (b.sum(1) @ np.arange(-1, 2)) / b.sum()
        cx = xx + (b.sum(0) @ np.arange(-1, 2)) / b.sum()
        elsewhere = [float(np.nanmax(d[round(q[3]) - 1:round(q[3]) + 2, round(q[2]) - 1:round(q[2]) + 2]) - bg) / sig
                     for i, q in pred.items() if i != f["id"] and np.hypot(q[2] - px, q[3] - py) >= 3]
        positions[f["id"]] = {
            "ra": round(ra, 6), "dec": round(dec, 6),
            "peak_contrast": round(float(box[by, bx] / sig), 1),
            "centroid_offset_arcsec": round(float(np.hypot(cx - px, cy - py) * grid.pixel_arcsec), 1),
            "max_contrast_at_other_epochs": round(max(elsewhere), 1) if elsewhere else None,
        }
        print(f["obsid"], positions[f["id"]])
    m["ephemeris"] = {
        "object": {"ru": "Плутон", "en": "Pluto"},
        "source": "JPL DE421 (Pluto system barycentre), geocentric astrometric ICRS, light-time corrected; observer offset of SPHEREx (up to ~0.3\") not applied",
        "contrast_definition": "peak / (1.4826 * MAD of the frame); an estimate, not a full S/N",
        "computed_with": "scripts/pluto_ephemeris.py (jplephem + de421)",
        "positions": positions,
    }
    path.write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
