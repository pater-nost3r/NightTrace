"""Find SPHEREx observations of a field and choose a comparable set.

Discovery uses the IRSA Simple Image Access v2 service
(https://irsa.ipac.caltech.edu/SIA), the same service behind the IRSA
SPHEREx tools. Frames are then read from the IRSA cloud copy on AWS.
"""
from __future__ import annotations

import csv
import io
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import math
import urllib.error
import urllib.parse
import urllib.request

from . import budget, field
from .fits_remote import ArchiveError, USER_AGENT, read_bounded
from .ids import FrameId, from_key, parse_token

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
COLLECTIONS = ("spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep")
# Requested wavelength (um) -> SPHEREx detector that covers it.
BANDS = {"0.9": 1, "1.3": 2, "2.0": 3, "3.0": 4, "4.1": 5, "4.7": 6}
SIA_TIMEOUT = 25
MAX_EXAMINED = 16
MAX_FRAMES = 6
MAX_IDS = 8


def check_coordinates(ra, dec):
    try:
        ra, dec = float(ra), float(dec)
    except (TypeError, ValueError):
        raise ValueError("coordinates must be numbers") from None
    if not (math.isfinite(ra) and math.isfinite(dec) and 0 <= ra < 360 and -90 <= dec <= 90):
        raise ValueError("coordinates out of range")
    return round(ra, 4) % 360.0, round(dec, 4) + 0.0


def query_sia(ra, dec, band, collection):
    params = [("COLLECTION", collection), ("POS", f"CIRCLE {ra} {dec} 0.01"),
              ("BAND", f"{float(band) * 1e-6:.3e}"), ("MAXREC", "400"), ("RESPONSEFORMAT", "csv")]
    url = SIA_URL + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    timeout = budget.call_timeout(SIA_TIMEOUT)
    if timeout is None:
        raise ArchiveError("timeout", "request time budget spent")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = read_bounded(response, 8_000_001)
    except urllib.error.HTTPError as error:
        raise ArchiveError("rate_limited" if error.code in (429, 503) else "upstream", f"SIA HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ArchiveError("timeout" if "timed out" in str(error) else "network", "SIA") from None
    if len(raw) > 8_000_000:
        raise ArchiveError("format", "SIA response too large")
    return parse_sia_csv(raw.decode("utf-8-sig", "replace"))


def parse_sia_csv(text):
    """Return {FrameId: t_min_mjd} from an SIA2 CSV table; unknown rows are ignored."""
    table = csv.DictReader(io.StringIO(text))
    if not {"access_url", "t_min"}.issubset(table.fieldnames or []):
        raise ArchiveError("format", "SIA did not return an observation table")
    found = {}
    for row in table:
        url = urllib.parse.urlsplit(row.get("access_url") or "")
        if url.hostname != "irsa.ipac.caltech.edu" or not url.path.startswith("/ibe/data/spherex/"):
            continue
        try:
            frame = from_key(url.path.removeprefix("/ibe/data/spherex/"))
            found[frame] = float(row["t_min"])
        except (ValueError, TypeError):
            continue
    return found


def bandpass_overlap(a, b):
    """Overlap of two bandpasses as a fraction of the narrower one (0..1)."""
    if None in (a.get("wavelength_um"), b.get("wavelength_um"), a.get("bandwidth_um"), b.get("bandwidth_um")):
        return None
    lo = max(a["wavelength_um"] - a["bandwidth_um"] / 2, b["wavelength_um"] - b["bandwidth_um"] / 2)
    hi = min(a["wavelength_um"] + a["bandwidth_um"] / 2, b["wavelength_um"] + b["bandwidth_um"] / 2)
    return max(0.0, hi - lo) / min(a["bandwidth_um"], b["bandwidth_um"])


def _spread(items, count):
    if len(items) <= count:
        return list(items)
    return [items[round(i * (len(items) - 1) / (count - 1))] for i in range(count)]


def choose_comparable(frames, limit=MAX_FRAMES, threshold=0.5):
    """Pick a time series in which EVERY pair of frames overlaps by >= threshold.

    Bandpass overlap is not transitive (0.90, 0.91 and 0.92 um with 0.02 um bands: each
    neighbour overlaps, the ends do not), so frames are never compared to one anchor only.
    First the compatible pair with the longest time span is found; frames between them
    are added only if they are compatible with every frame already chosen. Returns
    (series, (first, last)) or ([], None).
    """
    usable = sorted((f for f in frames if f.get("wavelength_um") is not None), key=lambda f: f["date_avg"])
    ok = lambda a, b: (bandpass_overlap(a, b) or 0) >= threshold
    pair = None
    for i, a in enumerate(usable):
        for b in usable[i + 1:]:
            if ok(a, b):
                key = (_days(b) - _days(a), -i)
                if pair is None or key > pair[0]:
                    pair = (key, a, b)
    if pair is None:
        return [], None
    _, first, last = pair
    series = [first, last]
    # Prefer frames that overlap the pair best, then keep date order.
    middle = [f for f in usable if f is not first and f is not last and first["date_avg"] <= f["date_avg"] <= last["date_avg"]]
    middle.sort(key=lambda f: -min(bandpass_overlap(f, first) or 0, bandpass_overlap(f, last) or 0))
    for f in middle:
        if all(ok(f, g) for g in series):
            series.append(f)
    series.sort(key=lambda f: f["date_avg"])
    series = _spread(series, limit)          # keeps the first and last frame
    return series, (first, last)


def _days(frame):
    return datetime.fromisoformat(frame["date_avg"].rstrip("Z")).timestamp() / 86400


def describe_many(ids, ra, dec, workers=8):
    """Describe frames in parallel. Returns (described, failures{token: code})."""
    described, failures = [], {}

    def one(frame_id):
        try:
            return frame_id, field.describe(frame_id, ra, dec), None
        except ArchiveError as error:
            return frame_id, None, error.code
        except (ValueError, KeyError, TypeError):
            return frame_id, None, "format"

    with ThreadPoolExecutor(max(1, min(workers, len(ids)))) as pool:
        jobs = [budget.submit(pool, one, frame_id) for frame_id in ids]
        for frame_id, info, code in (job.result() for job in jobs):
            if info is None:
                failures[frame_id.token] = code
            else:
                described.append(info)
    return described, failures


class IncompleteSearch(ArchiveError):
    """The archive failed often enough that the absence of results cannot be trusted."""


def _dominant(codes):
    codes = list(codes)
    for code in ("rate_limited", "timeout", "network", "upstream", "format", "not_found"):
        if code in codes:
            return code
    return "upstream"


def search(ra, dec, band="0.9"):
    if band not in BANDS:
        raise ValueError("unsupported band")
    detector = BANDS[band]
    found, failed_collections, errors = {}, [], []
    with ThreadPoolExecutor(len(COLLECTIONS)) as pool:
        jobs = {collection: budget.submit(pool, query_sia, ra, dec, band, collection) for collection in COLLECTIONS}
        for collection, job in jobs.items():
            try:
                found.update(job.result())
            except ArchiveError as error:
                failed_collections.append(collection)
                errors.append(error)
    if len(failed_collections) == len(COLLECTIONS):
        raise errors[0]
    candidates = sorted((f for f in found if f.detector == detector), key=found.get)
    if not candidates and failed_collections:
        # Some collections did not answer: "nothing found" is not established.
        raise IncompleteSearch(_dominant(e.code for e in errors), "SIA collections failed: " + ",".join(failed_collections))
    examined = _spread(candidates, MAX_EXAMINED)
    described, failures = describe_many(examined, ra, dec) if examined else ([], {})
    covering = [f for f in described if f["coverage"] >= field.MIN_COVERAGE and f.get("wavelength_um") is not None]
    if examined and not covering and failures:
        # Coverage could not be checked for some frames: report an archive problem, not "no coverage".
        raise IncompleteSearch(_dominant(failures.values()), f"{len(failures)} of {len(examined)} frames could not be read")
    chosen, pair = choose_comparable(covering)
    comparison = "time"
    if not chosen and len(covering) >= 2:
        chosen, comparison = _spread(sorted(covering, key=lambda f: f["date_avg"]), 4), "spectral"
        pair = (chosen[0], chosen[-1])
    stats = {
        "found": len(candidates), "examined": len(examined), "described": len(described),
        "failed": len(failures), "no_coverage": len(described) - len(covering),
        "not_comparable": len(covering) - len(chosen) if comparison == "time" else None,
        "collections_failed": failed_collections,
    }
    if not candidates:
        state = "no_results"
    elif not covering:
        state = "no_coverage"
    elif len(chosen) < 2:
        state = "single"
    else:
        state = "ready" if comparison == "time" else "spectral_only"
    ok = len(chosen) >= 2
    return {"state": state, "comparison": comparison if ok else None,
            "pair": {"a": pair[0]["id"], "b": pair[1]["id"]} if ok else None,
            "complete": not failures and not failed_collections,
            "frames": chosen if ok else covering[:1], "stats": stats}


def observations(ra, dec, tokens):
    ids = [parse_token(t) for t in tokens]
    if not 1 <= len(ids) <= MAX_IDS or len(set(ids)) != len(ids):
        raise ValueError("bad frame list")
    described, failures = describe_many(ids, ra, dec)
    order = {frame.token: i for i, frame in enumerate(ids)}
    described.sort(key=lambda f: order[f["id"]])
    return described, failures
