"""Server core tests. No network: real SPHEREx headers and astropy reference values are in tests/fixtures."""
import gzip
import json
from pathlib import Path
import sys

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from nighttrace import archive, field  # noqa: E402
from nighttrace.fits_remote import parse_header  # noqa: E402
from nighttrace.ids import FrameId, from_key, parse_token  # noqa: E402
from nighttrace.rice import rice_decompress  # noqa: E402
from nighttrace.wcs import FieldGrid, TanSip  # noqa: E402
from ntf import read_ntf  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
REF = json.loads((FIX / "orion_reference.json").read_text())
KEY = "dr1/level2/2026W11_2A/l2b-v27-2026-234/1/level2_2026W11_2A_0519_1D1_spx_l2b-v27-2026-234.fits"


def image_cards():
    raw = (FIX / "orion_headers.fits.part").read_bytes()
    _, length = parse_header(raw, 0)
    cards, _ = parse_header(raw, length)
    return cards


def test_ids_round_trip_and_rejects_foreign_input():
    frame = from_key(KEY)
    assert frame.key == KEY
    assert parse_token(frame.token) == frame
    assert frame.aws_url.startswith("https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/")
    for bad in ["http://evil.example/x.fits", "dr1:l2b-v27-2026-234:../../etc:1", "dr1:l2b-v27-2026-234:2026W11_2A_0519_1:7",
                "dr9:l2b-v27-2026-234:2026W11_2A_0519_1:1", "a" * 200, ""]:
        with pytest.raises(ValueError):
            parse_token(bad)
    with pytest.raises(ValueError):
        from_key("dr1/level2/2026W11_2A/l2b-v27-2026-234/2/level2_2026W11_2A_0519_1D1_spx_l2b-v27-2026-234.fits")


def test_header_parsing_reads_real_spherex_cards():
    cards = image_cards()
    assert cards["EXTNAME"] == "IMAGE" and cards["BITPIX"] == -32
    assert cards["OBSID"] == "2026W11_2A_0519_1"
    assert cards["DATE-AVG"] == "2026-03-15T03:09:27.392"
    assert cards["L2 N_SOURCE"] == 2476208  # HIERARCH card
    assert cards["ASTRONETSOLVED"] is True


def test_tan_sip_matches_astropy():
    wcs = TanSip(image_cards())
    pix = np.array(REF["pixels"]); sky = np.array(REF["sky"])
    ra, dec = wcs.pixel_to_world(pix[:, 0], pix[:, 1])
    assert np.max(np.abs((ra - sky[:, 0]) * np.cos(np.radians(sky[:, 1])))) * 3600 < 1e-6
    assert np.max(np.abs(dec - sky[:, 1])) * 3600 < 1e-6
    x, y = wcs.world_to_pixel(sky[:, 0], sky[:, 1])
    # the archive's own inverse polynomial (AP/BP) is accurate to ~0.02 px
    assert np.max(np.hypot(x - pix[:, 0], y - pix[:, 1])) < 0.05


def test_far_sky_positions_never_fold_onto_the_detector():
    # Found while preparing the Pluto example: positions tens of degrees from the frame
    # centre came back as "inside" pixels through the SIP polynomials (false coverage).
    cards = image_cards()
    wcs = TanSip(cards)
    ra0, dec0 = wcs.crval
    for dra, ddec in [(0, 46), (30, 10), (-50, -20), (120, 0), (0, -60)]:
        x, y = wcs.world_to_pixel((ra0 + dra) % 360, max(-89.9, min(89.9, dec0 + ddec)))
        assert not (np.isfinite(x) and 0 <= x <= 2039 and 0 <= y <= 2039), (dra, ddec, x, y)
    x, y = wcs.world_to_pixel(ra0, dec0)          # the centre still works
    assert abs(x - (wcs.crpix[0] - 1)) < 2 and abs(y - (wcs.crpix[1] - 1)) < 2
    # The real case: this frame points at Dec -69; Pluto's position (Dec -23) was reported inside it.
    far = json.loads((FIX / "far_frame_wcs.json").read_text())
    x, y = TanSip(far["cards"]).world_to_pixel(308.4484, -22.8774)
    assert not np.isfinite(x) and not np.isfinite(y)


def test_rice_decoder_matches_astropy():
    for row, blob in REF["rice_rows"].items():
        decoded = rice_decompress(bytes.fromhex(blob), 2040)
        assert decoded.astype(np.int64).tolist() == REF["rice_expected"][row]


def test_field_grid_round_trip_and_orientation():
    grid = FieldGrid(269.6392, 66.6331, 512, 6.15)
    ra, dec = grid.sky(255.5, 255.5)
    assert abs(ra - 269.6392) < 1e-9 and abs(dec - 66.6331) < 1e-9
    _, dec_top = grid.sky(255.5, 0)
    assert dec_top > 66.6331  # row 0 is north
    ra_left, _ = grid.sky(0, 255.5)
    assert (ra_left - 269.6392) % 360 < 180  # east (larger RA) is left
    px, py = grid.pixel(*grid.sky(np.array([10.0, 400.0]), np.array([20.0, 300.0])))
    assert np.allclose(px, [10, 400]) and np.allclose(py, [20, 300])


def test_ntf_encoding_round_trip_flags_clipping():
    image = np.full((32, 32), 1.5, np.float32)
    image[0, 0] = np.nan
    image[1, 1] = 1e6
    flags = np.zeros((32, 32), np.uint8)
    flags[2, 2] = field.CAT_TRANSIENT
    out, f = read_ntf(field.encode(image, flags))
    assert np.isnan(out[0, 0]) and out[5, 5] == pytest.approx(1.5)
    assert f[1, 1] & field.CAT_CLIPPED and out[1, 1] == pytest.approx(65000, rel=1e-3)
    assert f[2, 2] == field.CAT_TRANSIENT


def test_bandpass_overlap_and_choice_prefers_comparable_long_series():
    def f(day, lam, bw=0.024):
        return {"date_avg": f"2025-{day}T00:00:00Z", "wavelength_um": lam, "bandwidth_um": bw, "coverage": 1}
    assert archive.bandpass_overlap(f("01-01", 0.90), f("01-02", 0.90)) == pytest.approx(1)
    assert archive.bandpass_overlap(f("01-01", 0.90), f("01-02", 0.95)) == 0
    frames = [f("01-01", 0.90), f("02-01", 0.95), f("06-01", 0.905), f("09-01", 0.96), f("12-01", 0.898)]
    chosen, pair = archive.choose_comparable(frames)
    assert [c["wavelength_um"] for c in chosen] == [0.90, 0.905, 0.898]
    assert (pair[0]["wavelength_um"], pair[1]["wavelength_um"]) == (0.90, 0.898)
    assert archive.choose_comparable([f("01-01", 0.90), f("02-01", 0.95)]) == ([], None)


def test_choice_is_pairwise_not_anchor_based():
    # Neighbours overlap, the ends do not (overlap is not transitive): never return 0.90 with 0.92.
    def f(day, lam):
        return {"date_avg": f"2025-01-{day:02d}T00:00:00Z", "wavelength_um": lam, "bandwidth_um": 0.02, "coverage": 1}
    chosen, pair = archive.choose_comparable([f(1, 0.90), f(2, 0.91), f(3, 0.92)])
    assert len(chosen) == 2
    for i, a in enumerate(chosen):
        for b in chosen[i + 1:]:
            assert archive.bandpass_overlap(a, b) >= 0.5
    assert archive.bandpass_overlap(*pair) >= 0.5 and pair == (chosen[0], chosen[-1])


def test_every_pair_in_a_long_series_is_comparable():
    import random
    rng = random.Random(4)
    frames = [{"date_avg": f"2025-{m:02d}-{d:02d}T00:00:00Z", "wavelength_um": 0.9 + rng.uniform(-0.02, 0.02), "bandwidth_um": 0.024, "coverage": 1}
              for m in range(1, 13) for d in (3, 17)]
    chosen, pair = archive.choose_comparable(frames)
    assert len(chosen) >= 2
    assert all(archive.bandpass_overlap(a, b) >= 0.5 for a in chosen for b in chosen)


def _search_stubs(monkeypatch, describe):
    monkeypatch.setattr(archive, "query_sia", lambda ra, dec, band, c: {from_key(KEY): 61114.0} if c == "spherex_dr1" else {})
    monkeypatch.setattr(archive.field, "describe", describe)


def test_search_timeout_is_not_reported_as_no_coverage(monkeypatch):
    def describe(*a):
        raise archive.ArchiveError("timeout", "slow")
    _search_stubs(monkeypatch, describe)
    with pytest.raises(archive.ArchiveError) as info:
        archive.search(269.6, 66.6, "0.9")
    assert info.value.code == "timeout"


def test_search_failed_collections_with_no_results_is_not_no_results(monkeypatch):
    def sia(ra, dec, band, c):
        if c == "spherex_dr1":
            raise archive.ArchiveError("timeout", "SIA")
        return {}
    monkeypatch.setattr(archive, "query_sia", sia)
    with pytest.raises(archive.ArchiveError) as info:
        archive.search(10, 10, "0.9")
    assert info.value.code == "timeout"


def test_real_no_coverage_is_still_reported(monkeypatch):
    _search_stubs(monkeypatch, lambda *a: {"id": "x", "coverage": 0.0, "wavelength_um": 0.9, "bandwidth_um": 0.02, "date_avg": "2025-01-01T00:00:00Z"})
    assert archive.search(269.6, 66.6, "0.9")["state"] == "no_coverage"


def test_time_budget_stops_network_calls(monkeypatch):
    import time as _time
    from nighttrace import budget, fits_remote
    calls = []

    def slow_urlopen(request, timeout):
        calls.append(timeout)
        _time.sleep(min(timeout, 0.4))
        raise TimeoutError("timed out")
    monkeypatch.setattr(fits_remote.urllib.request, "urlopen", slow_urlopen)
    monkeypatch.setattr(budget, "MIN_CALL_SECONDS", 0.3)
    started = _time.monotonic()
    with budget.limit(1.0):
        with pytest.raises(archive.ArchiveError) as info:
            for _ in range(20):          # many sequential reads, as in one frame cutout
                fits_remote.fetch_range("https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/x", 0, 10)
    assert info.value.code == "timeout"
    assert _time.monotonic() - started < 1.5
    assert all(t <= 1.0 for t in calls)


def test_budget_reaches_worker_threads(monkeypatch):
    from nighttrace import budget
    seen = []
    monkeypatch.setattr(archive.field, "describe", lambda *a: seen.append(budget.remaining()) or (_ for _ in ()).throw(archive.ArchiveError("timeout")))
    with budget.limit(5):
        archive.describe_many([from_key(KEY)], 1, 1)
    assert seen and seen[0] is not None and 0 < seen[0] <= 5


def test_sia_parser_keeps_only_irsa_spherex_frames():
    csv_text = "access_url,t_min\n" \
        f"https://irsa.ipac.caltech.edu/ibe/data/spherex/{KEY},61114.13\n" \
        "https://evil.example/ibe/data/spherex/x.fits,1\n" \
        "https://irsa.ipac.caltech.edu/ibe/data/other/thing.fits,2\n"
    found = archive.parse_sia_csv(csv_text)
    assert list(found) == [from_key(KEY)]
    with pytest.raises(Exception):
        archive.parse_sia_csv("<html>error</html>")


def test_coordinates_are_validated_and_rounded():
    assert archive.check_coordinates("269.63921234", "66.6331") == (269.6392, 66.6331)
    for ra, dec in [("360", "0"), ("-1", "0"), ("1", "91"), ("nan", "0"), ("1e400", "0"), (None, "0")]:
        with pytest.raises(ValueError):
            archive.check_coordinates(ra, dec)


class _DripResponse:
    """A 206 response whose body arrives a few bytes at a time (a slow or stalled stream)."""
    status = 206

    def __init__(self, delay, total=10_000_000):
        self.delay, self.left = delay, total

    reads = 0

    def read(self, n=-1):
        import time as _time
        _DripResponse.reads += 1
        _time.sleep(self.delay)
        k = min(16, self.left, n if n and n > 0 else 16)
        self.left -= k
        return b"x" * k

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_slow_body_stream_cannot_outlive_the_deadline(monkeypatch):
    import time as _time
    from nighttrace import budget, fits_remote
    monkeypatch.setattr(fits_remote.urllib.request, "urlopen", lambda request, timeout: _DripResponse(0.05))
    monkeypatch.setattr(budget, "MIN_CALL_SECONDS", 0.1)
    _DripResponse.reads = 0
    started = _time.monotonic()
    with budget.limit(1.0):
        with pytest.raises(archive.ArchiveError) as info:
            fits_remote.fetch_range("https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/x", 0, 1_000_000)
    elapsed = _time.monotonic() - started
    assert info.value.code == "timeout"
    assert _DripResponse.reads > 5, "the body was actually being read"
    assert 0.8 < elapsed < 1.2, elapsed    # stopped at the deadline (+ at most one small chunk)


def test_slow_sia_body_cannot_outlive_the_deadline(monkeypatch):
    import time as _time
    from nighttrace import budget
    monkeypatch.setattr(archive.urllib.request, "urlopen", lambda request, timeout: _DripResponse(0.05))
    monkeypatch.setattr(budget, "MIN_CALL_SECONDS", 0.1)
    _DripResponse.reads = 0
    started = _time.monotonic()
    with budget.limit(0.8):
        with pytest.raises(archive.ArchiveError) as info:
            archive.query_sia(10, 10, "0.9", "spherex_dr1")
    elapsed = _time.monotonic() - started
    assert info.value.code == "timeout" and _DripResponse.reads > 5 and 0.6 < elapsed < 1.0, elapsed


def test_heavy_stages_check_the_deadline(monkeypatch):
    from nighttrace import budget, fits_remote
    calls = []
    monkeypatch.setattr(fits_remote.RemoteFrame, "read_headers", lambda self: calls.append("headers") or self)
    with budget.limit(-1):                 # already spent: no reprojection may start
        with pytest.raises(archive.ArchiveError) as info:
            field.cutout(from_key(KEY), 83.822, -5.391)
    assert info.value.code == "timeout" and calls == ["headers"]
