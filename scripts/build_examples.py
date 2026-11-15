"""Prepare the built-in examples from real SPHEREx frames (run locally, not on Vercel).

    python scripts/build_examples.py            # all examples
    python scripts/build_examples.py cats-eye   # one example

Writes public/data/examples/<id>/manifest.json and one NTF1 file per frame.
The same code path as /api/frame is used, so examples and live search match.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from nighttrace import field  # noqa: E402
from nighttrace.ids import from_key  # noqa: E402

OUT = ROOT / "public" / "data" / "examples"
CATS = [
    "dr1/level2/2025W18_1B/l2b-v27-2026-196/1/level2_2025W18_1B_0065_1D1_spx_l2b-v27-2026-196.fits",
    "dr1/level2/2025W18_1B/l2b-v27-2026-196/1/level2_2025W18_1B_0065_2D1_spx_l2b-v27-2026-196.fits",
    "dr1/level2/2025W22_1B/l2b-v27-2026-199/1/level2_2025W22_1B_0430_1D1_spx_l2b-v27-2026-199.fits",
    "dr1/level2/2025W27_1A/l2b-v27-2026-214/1/level2_2025W27_1A_0067_1D1_spx_l2b-v27-2026-214.fits",
    "dr1/level2/2025W27_1A/l2b-v27-2026-214/1/level2_2025W27_1A_0363_1D1_spx_l2b-v27-2026-214.fits",
    "dr1/level2/2025W35_1A/l2b_retry-v27-2026-230/1/level2_2025W35_1A_0107_1D1_spx_l2b_retry-v27-2026-230.fits",
    "dr1/level2/2025W40_1A/l2b-v27-2026-239/1/level2_2025W40_1A_0036_1D1_spx_l2b-v27-2026-239.fits",
    "dr1/level2/2025W42_2A/l2b-v27-2026-243/1/level2_2025W42_2A_0042_1D1_spx_l2b-v27-2026-243.fits",
    "dr1/level2/2025W48_1A/l2b-v27-2026-208/1/level2_2025W48_1A_0193_1D1_spx_l2b-v27-2026-208.fits",
    "dr1/level2/2026W01_1A/l2b-v27-2026-211/1/level2_2026W01_1A_0076_1D1_spx_l2b-v27-2026-211.fits",
    "dr1/level2/2026W01_1A/l2b-v27-2026-211/1/level2_2026W01_1A_0631_1D1_spx_l2b-v27-2026-211.fits",
    "dr1/level2/2026W08_2A/l2b-v27-2026-227/1/level2_2026W08_2A_0474_1D1_spx_l2b-v27-2026-227.fits",
    "dr1/level2/2026W10_1A/l2b-v27-2026-229/1/level2_2026W10_1A_0309_1D1_spx_l2b-v27-2026-229.fits",
    "dr1/level2/2026W17_1B/l2b-v27-2026-242/1/level2_2026W17_1B_0343_1D1_spx_l2b-v27-2026-242.fits",
    "qr3/level2/2026W39_1A/l2b-v27-2026-268/1/level2_2026W39_1A_0456_1D1_spx_l2b-v27-2026-268.fits",
]
EXAMPLES = json.loads((ROOT / "scripts" / "examples.json").read_text(encoding="utf-8"))


def build(example):
    ra, dec = example["ra"], example["dec"]
    target = OUT / example["id"]
    (target / "frames").mkdir(parents=True, exist_ok=True)
    frames = []
    for key in example["keys"]:
        frame_id = from_key(key)
        started = time.time()
        image, flags, info = field.cutout(frame_id, ra, dec)
        name = frame_id.obsid + f"_D{frame_id.detector}.ntf"
        (target / "frames" / name).write_bytes(field.encode(image, flags))
        info["file"] = f"data/examples/{example['id']}/frames/{name}"
        frames.append(info)
        print(f"  {frame_id.obsid}: {info['wavelength_um']} um, {time.time() - started:.1f} s", flush=True)
    frames.sort(key=lambda f: f["date_avg"])
    manifest = {
        "state": "ready", "example": example["id"], "field": {"ra": ra, "dec": dec},
        "comparison": example.get("comparison", "time"),
        "title": example["title"], "summary": example["summary"], "frames": frames,
        "grid": field.grid_for(ra, dec).describe(), "processing": field.processing(),
        "source": "SPHEREx Level 2 frames from the IRSA AWS Open Data copy (s3://nasa-irsa-spherex)",
        "prepared_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "prepared_with": "scripts/build_examples.py (same code as /api/frame)",
    }
    (target / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")


def main(selected):
    for example in EXAMPLES:
        if example["id"] == "cats-eye" and not example.get("keys"):
            example["keys"] = CATS
        if selected and example["id"] not in selected:
            continue
        print(example["id"], flush=True)
        build(example)


if __name__ == "__main__":
    main(set(sys.argv[1:]))
