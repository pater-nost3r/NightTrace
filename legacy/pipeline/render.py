"""Render registered frames with a shared brightness scale."""
from datetime import datetime
import json

import numpy as np
from PIL import Image

from cut import B, RA0, DE0, N, PIX

IRSA = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
MONTHS = "янв фев мар апр мая июн июл авг сен окт ноя дек".split()


def render(prepared, base, output):
    ra, dec = base.get("ra", RA0), base.get("dec", DE0)
    output.mkdir(parents=True, exist_ok=True)
    images = [frame[0] - np.nanmedian(frame[0]) for _, frame in prepared]
    samples = [image[np.isfinite(image)] for image in images]
    sigma = float(np.median([1.4826 * np.median(np.abs(values)) for values in samples]))
    low, high, soft = -2 * sigma, float(np.percentile(np.concatenate(samples), 99.85)), 3 * sigma
    if not soft > 0 or not high > low:
        raise ValueError("Invalid shared image stretch")
    frames = []
    for index, ((key, (_, stamp, obsid, x, y, wavelength, bandwidth)), image) in enumerate(zip(prepared, images), 1):
        name = f"frame{index:02}.png"
        scaled = np.arcsinh(np.maximum(image - low, 0) / soft) / np.arcsinh((high - low) / soft)
        pixels = np.rint(np.nan_to_num(np.clip(scaled, 0, 1)) * 255).astype(np.uint8)
        Image.fromarray(pixels[::-1]).save(output / name, optimize=True)
        date = datetime.fromisoformat(stamp)
        frames.append({
            "file": name, "label": f"{date.day} {MONTHS[date.month - 1]} {date.year}",
            "date_obs": stamp + "Z", "obs_id": obsid, "detector": 1,
            "band": f"{wavelength:.3f} мкм", "wavelength_um": round(wavelength, 4),
            "bandwidth_um": round(bandwidth, 4), "target_pixel": [round(x, 1), round(y, 1)],
            "link": f"{IRSA}{key}?center={ra},{dec}&size={N * PIX:.5f}",
            "link_full": IRSA + key, "link_aws": B + key, "fits_key": key,
        })
    releases = " + ".join(sorted({key.split("/")[0].upper() for key, _ in prepared}))
    manifest = dict(base, frames=frames, data_release=f"SPHEREx {releases}, Level 2 (NASA/IPAC IRSA)",
                    description="Снимки SPHEREx одной области совмещены по небесным координатам.")
    manifest.update(fov_arcmin=round(N * PIX * 60, 1), pixel_arcsec=PIX * 3600,
                    grid={"crval": [ra, dec], "crpix": [(N + 1) / 2] * 2,
                          "height": N, "cdelt_arcsec": PIX * 3600})
    manifest["processing"] = ("Поле 520×520 пикселей, общая сетка TAN (север сверху), "
                              "вычет медианного фона и общая шкала asinh. Маски качества не применялись.")
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

