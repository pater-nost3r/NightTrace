"""Regenerate the curated set or refresh it with later IRSA observations."""
import argparse
import csv
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
import math
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import urlopen
from urllib.error import URLError
import warnings

from astropy.wcs import FITSFixedWarning
from cut import RA0, DE0, cutout
from render import render
from wave import wave

ROOT = Path(__file__).resolve().parents[1]
KEY = re.compile(r"(?:dr1|qr3)/level2/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/1/[A-Za-z0-9_-]+D1_[A-Za-z0-9_-]+\.fits")
warnings.filterwarnings("ignore", category=FITSFixedWarning)


def discover(after=None, center=(RA0, DE0), collections=None):
    if collections is None:
        collections = ["spherex_dr1", "spherex_dr1_deep", "spherex_qr3", "spherex_qr3_deep"]
    params = [("COLLECTION", c) for c in collections]
    params += [("POS", f"CIRCLE {center[0]} {center[1]} 0.01"), ("BAND", "9e-7"),
               ("MAXREC", "500" if after else "100"), ("RESPONSEFORMAT", "csv")]
    if after:
        mjd = datetime.fromisoformat(after).timestamp() / 86400 + 40587
        params.append(("TIME", f"{mjd:.8f} +Inf"))
    url = "https://irsa.ipac.caltech.edu/SIA?" + urlencode(params, quote_via=quote)
    try:
        with urlopen(url, timeout=20) as response:
            raw = response.read()
    except (URLError, TimeoutError):
        curl = shutil.which("curl.exe") or shutil.which("curl")
        if not curl:
            raise
        response = subprocess.run([curl, "-fsSL", "--max-time", "20", url], capture_output=True)
        if response.returncode:
            raise OSError(response.stderr.decode("utf-8", "replace"))
        raw = response.stdout
    table = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))
    if not {"access_url", "t_min"}.issubset(table.fieldnames or []):
        raise ValueError("IRSA did not return an observation table")
    candidates = {}
    for row in table:
        source = urlsplit(row["access_url"])
        key = source.path.removeprefix("/ibe/data/spherex/")
        if source.hostname == "irsa.ipac.caltech.edu" and KEY.fullmatch(key):
            candidates[key] = float(row["t_min"])
    return sorted(candidates, key=candidates.get, reverse=True)


def prepare(key, center=(RA0, DE0)):
    if not KEY.fullmatch(key):
        raise ValueError("Unsupported FITS key")
    image, primary, header, x, y = cutout(key, center)
    wavelength, bandwidth = wave(key, x, y)
    return image, header.get("DATE-AVG") or primary["DATE-AVG"], (header.get("OBSID") or primary["OBSID"]), x, y, wavelength, bandwidth


def build_field(center, output):
    # Query releases separately so the dense DR1 collection cannot crowd out QR3.
    collections = ["spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep"]
    with ThreadPoolExecutor(8) as pool:
        searches = [pool.submit(discover, center=center, collections=[collection])
                    for collection in collections]
        keys = []
        successful = 0
        error = None
        batches = []
        for search in searches:
            try:
                batches.append(search.result())
                successful += 1
            except (OSError, ValueError) as failure:
                error = failure
                print(f"IRSA collection unavailable: {failure}", flush=True)
        if not successful:
            raise error
        for found in batches:
            if found:
                count = min(8, len(found))
                keys.extend(found[round(i * (len(found) - 1) / max(count - 1, 1))]
                            for i in range(count))

        def try_frame(key):
            try:
                return key, prepare(key, center)
            except (ValueError, OSError, KeyError) as error:
                print(f"Skipped {key}: {error}", flush=True)
                return None

        frames = sorted(filter(None, pool.map(try_frame, dict.fromkeys(keys))), key=lambda item: item[1][1])
    # All displayed bandpasses must overlap at the field center. Keep one frame per day.
    bands = [(frame[-2] - frame[-1] / 2, frame[-2] + frame[-1] / 2) for _, frame in frames]
    candidates = []
    for low, _ in bands:
        sequence = []
        for item, (start, end) in zip(frames, bands):
            when = datetime.fromisoformat(item[1][1])
            if start <= low <= end and (not sequence or when - sequence[-1][0] >= timedelta(days=1)):
                sequence.append((when, item))
        if len(sequence) >= 2:
            candidates.append(sequence)
    if not candidates and error and not frames:
        raise error
    if not candidates:
        print("No comparable pair", flush=True)
        return
    best = max(candidates, key=lambda seq: (seq[-1][0] - seq[0][0], len(seq)))
    if len(best) > 6:
        best = [best[round(i * (len(best) - 1) / 5)] for i in range(6)]
    render([item for _, item in best], {"ra": center[0], "dec": center[1]}, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--current", type=Path)
    parser.add_argument("--field", type=float, nargs=2, metavar=("RA", "DEC"))
    args = parser.parse_args()
    if args.field is not None:
        ra, dec = args.field
        if not (math.isfinite(ra) and math.isfinite(dec) and 0 <= ra < 360 and -90 <= dec <= 90):
            parser.error("Invalid sky coordinates")
        build_field((ra, dec), args.out)
        return
    base = json.loads((ROOT / "dist/data/manifest.json").read_text(encoding="utf-8"))
    current = json.loads(args.current.read_text(encoding="utf-8")) if args.current else base
    keys = [row["fits_key"] for row in current["frames"]]
    with ThreadPoolExecutor(4) as pool:
        if args.refresh:
            latest = max(row["date_obs"] for row in current["frames"])
            cutoff = datetime.fromisoformat(latest)
            selected = []
            for key in discover(latest)[:24]:
                if key in keys:
                    continue
                try:
                    frame = prepare(key)
                except (ValueError, OSError, KeyError) as error:
                    print(f"Skipped {key}: {error}", flush=True)
                    continue
                date = datetime.fromisoformat(frame[1] + "Z")
                if date <= cutoff or not 0.88 <= frame[-2] <= 0.94:
                    continue
                if any(abs(date - existing) < timedelta(days=14) for existing, _, _ in selected):
                    continue
                selected.append((date, key, frame))
                if len(selected) == 3:
                    break
            if not selected:
                print("No additional comparable observations", flush=True)
                return
        else:
            selected = []
        prepared = list(zip(keys, pool.map(prepare, keys)))
    prepared.extend((key, frame) for _, key, frame in selected)
    render(sorted(prepared, key=lambda item: item[1][1]), base, args.out)
    print(f"Prepared {len(prepared)} observations", flush=True)


if __name__ == "__main__":
    main()

