"""NightTrace web application (Flask, WSGI).

Vercel imports the module-level ``app`` (see vercel.json); nothing here starts
a server on import. Locally run ``python server.py`` and open
http://127.0.0.1:8000 . Static files come from ``public/``: on Vercel the CDN
serves them, locally (or as a fallback) this app does.

All routes are stateless: no background threads, no in-memory queues, no files
written. Frame pixels are produced per request and cached by the CDN through
Cache-Control headers.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
import time

from flask import Flask, Response, jsonify, request, send_from_directory

from nighttrace import VERSION, archive, budget, field
from nighttrace.fits_remote import ArchiveError
from nighttrace.ids import parse_token

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
log = logging.getLogger("nighttrace")

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024  # the API takes no request bodies

STATUS = {"timeout": 504, "rate_limited": 429, "not_found": 404, "no_coverage": 422,
          "network": 502, "upstream": 502, "format": 502}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": ("default-src 'self'; script-src 'self' 'unsafe-inline'; "
                                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
                                "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"),
}


@app.after_request
def _headers(response):
    for key, value in SECURITY_HEADERS.items():
        response.headers.setdefault(key, value)
    return response


def _error(status, state, code=None, retry_after=None):
    body = {"state": state}
    if code:
        body["code"] = code
    response = jsonify(body)
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    if retry_after:
        response.headers["Retry-After"] = str(retry_after)
    return response


def _archive_error(error: ArchiveError):
    log.warning("archive error: %s", error)
    status = STATUS.get(error.code, 502)
    state = "source_unavailable" if error.code == "not_found" else ("no_coverage" if error.code == "no_coverage" else "archive_error")
    return _error(status, state, error.code, retry_after=20 if status == 429 else None)


def _cached_json(payload, seconds):
    response = jsonify(payload)
    response.headers["Cache-Control"] = f"public, max-age=60, s-maxage={seconds}"
    return response


def _no_store_json(payload):
    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store"
    return response


def _query_keys(allowed):
    extra = set(request.args) - set(allowed)
    if extra or any(len(request.args.getlist(k)) > 1 for k in request.args):
        raise ValueError("unexpected parameters")


def _processing():
    return field.processing()


@app.get("/api/health")
def health():
    response = jsonify({"ok": True, "version": VERSION, "time": int(time.time())})
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/search")
def search():
    try:
        _query_keys({"ra", "dec", "band"})
        ra, dec = archive.check_coordinates(request.args.get("ra"), request.args.get("dec"))
        band = request.args.get("band", "0.9")
        if band not in archive.BANDS:
            raise ValueError("band")
    except ValueError:
        return _error(400, "invalid")
    try:
        with budget.limit():
            result = archive.search(ra, dec, band)
    except ArchiveError as error:
        return _archive_error(error)
    result.update(field={"ra": ra, "dec": dec}, band=band, processing=_processing(),
                  grid=field.grid_for(ra, dec).describe(), source="IRSA SIA v2 + IRSA AWS Open Data copy",
                  generated_at=int(time.time()))
    # A result with archive failures is still shown, but never cached as the final answer.
    return _cached_json(result, 3600) if result.get("complete") else _no_store_json(result)


@app.get("/api/observations")
def observations():
    try:
        _query_keys({"ra", "dec", "ids"})
        ra, dec = archive.check_coordinates(request.args.get("ra"), request.args.get("dec"))
        tokens = (request.args.get("ids") or "").split(",")
        with budget.limit():
            frames, failures = archive.observations(ra, dec, tokens)
    except ValueError:
        return _error(400, "invalid")
    if failures:
        codes = set(failures.values())
        status = 404 if codes == {"not_found"} else 502
        response = jsonify({"state": "source_unavailable" if status == 404 else "archive_error",
                            "failed": sorted(failures), "codes": sorted(codes)})
        response.status_code = status
        response.headers["Cache-Control"] = "no-store"
        return response
    return _cached_json({"state": "ready", "field": {"ra": ra, "dec": dec}, "frames": frames,
                         "processing": _processing(), "grid": field.grid_for(ra, dec).describe()}, 86400)


@app.get("/api/frame")
def frame():
    try:
        _query_keys({"ra", "dec", "id"})
        ra, dec = archive.check_coordinates(request.args.get("ra"), request.args.get("dec"))
        frame_id = parse_token(request.args.get("id", ""))
    except ValueError:
        return _error(400, "invalid")
    try:
        with budget.limit():
            image, flags, _ = field.cutout(frame_id, ra, dec)
    except ArchiveError as error:
        return _archive_error(error)
    body = field.encode(image, flags)
    response = Response(body, mimetype="application/octet-stream")
    response.headers["Content-Encoding"] = "gzip"
    response.headers["Cache-Control"] = "public, max-age=86400, s-maxage=2592000, immutable"
    return response


@app.get("/")
@app.get("/<path:path>")
def static_files(path="index.html"):
    """Local / fallback static hosting of public/. On Vercel the CDN serves these first."""
    if path.startswith("api/"):
        return _error(404, "not_found")
    target = (PUBLIC / path).resolve()
    if PUBLIC not in target.parents and target != PUBLIC:
        return _error(404, "not_found")
    if target.is_dir():
        path = path.rstrip("/") + "/index.html"
    if not (PUBLIC / path).is_file():
        return _error(404, "not_found")
    response = send_from_directory(PUBLIC, path)
    if path.endswith((".html", ".json")):
        response.headers["Cache-Control"] = "no-cache"
    return response


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8000")), debug=False)
