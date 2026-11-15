"""HTTP behaviour of the Flask app with the archive replaced by stubs (no network)."""
import gzip
from pathlib import Path
import sys

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from nighttrace import archive, field  # noqa: E402
from nighttrace.fits_remote import ArchiveError  # noqa: E402

TOKEN = "dr1:l2b-v27-2026-234:2026W11_2A_0519_1:1"


@pytest.fixture()
def client():
    return server.app.test_client()


def test_module_exports_wsgi_app_without_starting_a_server():
    assert callable(server.app.wsgi_app)
    assert server.app.name == "server"


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json["ok"] is True
    assert "Content-Security-Policy" in r.headers


@pytest.mark.parametrize("query", [
    "ra=400&dec=0", "ra=1&dec=1&band=7", "ra=1&dec=1&url=https://evil.example", "ra=1&ra=2&dec=1", "dec=1",
])
def test_search_rejects_bad_input(client, query):
    r = client.get("/api/search?" + query)
    assert r.status_code == 400 and r.json == {"state": "invalid"}


def test_search_archive_failure_is_explained_without_traces(client, monkeypatch):
    def boom(*a, **k):
        raise ArchiveError("timeout", "secret internal detail")
    monkeypatch.setattr(archive, "search", boom)
    r = client.get("/api/search?ra=10&dec=10")
    assert r.status_code == 504
    assert r.json == {"state": "archive_error", "code": "timeout"}
    assert b"secret" not in r.data and b"Traceback" not in r.data
    assert r.headers["Cache-Control"] == "no-store"


def test_search_rate_limit_sets_retry_after(client, monkeypatch):
    monkeypatch.setattr(archive, "search", lambda *a, **k: (_ for _ in ()).throw(ArchiveError("rate_limited")))
    r = client.get("/api/search?ra=10&dec=10")
    assert r.status_code == 429 and r.headers["Retry-After"]


def test_search_no_results_is_a_normal_answer(client, monkeypatch):
    monkeypatch.setattr(archive, "search", lambda *a, **k: {"state": "no_results", "comparison": None, "frames": [], "stats": {"found": 0}, "complete": True})
    r = client.get("/api/search?ra=10&dec=10&band=2.0")
    assert r.status_code == 200 and r.json["state"] == "no_results"
    assert r.json["field"] == {"ra": 10.0, "dec": 10.0} and r.json["band"] == "2.0"
    assert "s-maxage" in r.headers["Cache-Control"]


def test_frame_returns_gzip_ntf_and_is_cacheable(client, monkeypatch):
    img = np.ones((field.FIELD_SIZE, field.FIELD_SIZE), np.float32)
    flags = np.zeros(img.shape, np.uint8)
    monkeypatch.setattr(field, "cutout", lambda *a: (img, flags, {}))
    r = client.get(f"/api/frame?ra=83.822&dec=-5.391&id={TOKEN}")
    assert r.status_code == 200
    assert r.headers["Content-Encoding"] == "gzip" and "immutable" in r.headers["Cache-Control"]
    payload = gzip.decompress(r.data)
    assert payload[:4] == b"NTF1" and len(payload) == 12 + 3 * field.FIELD_SIZE ** 2
    assert len(r.data) < 4_500_000  # Vercel response limit


def test_frame_rejects_arbitrary_targets(client):
    for bad in ["https://evil.example/a.fits", "../../server.py", "dr1:x:y:1"]:
        assert client.get(f"/api/frame?ra=1&dec=1&id={bad}").status_code == 400


def test_missing_source_is_reported_not_substituted(client, monkeypatch):
    monkeypatch.setattr(archive, "observations", lambda ra, dec, ids: ([], {TOKEN: "not_found"}))
    r = client.get(f"/api/observations?ra=1&dec=1&ids={TOKEN}")
    assert r.status_code == 404 and r.json["state"] == "source_unavailable" and r.json["failed"] == [TOKEN]


def test_static_files_and_traversal(client):
    assert client.get("/").status_code == 200
    assert client.get("/js/app.js").status_code == 200
    assert client.get("/../server.py").status_code == 404
    assert client.get("/%2e%2e/server.py").status_code == 404
    assert client.get("/api/unknown").status_code == 404


def test_incomplete_search_result_is_not_cached(client, monkeypatch):
    monkeypatch.setattr(archive, "search", lambda *a, **k: {"state": "ready", "comparison": "time", "frames": [], "stats": {}, "complete": False})
    r = client.get("/api/search?ra=10&dec=10")
    assert r.status_code == 200 and r.headers["Cache-Control"] == "no-store"


def test_search_timeout_is_an_error_not_no_coverage(client, monkeypatch):
    monkeypatch.setattr(archive, "search", lambda *a, **k: (_ for _ in ()).throw(archive.IncompleteSearch("timeout", "x")))
    r = client.get("/api/search?ra=10&dec=10")
    assert r.status_code == 504 and r.json["state"] == "archive_error" and r.headers["Cache-Control"] == "no-store"


def test_slow_archive_gives_controlled_json_before_the_platform_limit(client, monkeypatch):
    import time
    from nighttrace import budget, fits_remote

    def slow(request, timeout):
        time.sleep(min(timeout, 0.3))
        raise TimeoutError("timed out")
    monkeypatch.setattr(fits_remote.urllib.request, "urlopen", slow)
    monkeypatch.setattr(budget, "REQUEST_SECONDS", 1.0)
    monkeypatch.setattr(budget, "MIN_CALL_SECONDS", 0.2)
    monkeypatch.setattr(budget.limit, "__defaults__", (1.0,))
    started = time.monotonic()
    r = client.get(f"/api/frame?id={TOKEN}&ra=83.822&dec=-5.391")
    assert time.monotonic() - started < 2.0
    assert r.status_code == 504 and r.json == {"state": "archive_error", "code": "timeout"}
