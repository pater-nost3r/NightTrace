"""Describe and cut out one SPHEREx frame on the common field grid."""
from __future__ import annotations

import gzip
import struct

import numpy as np

from .fits_remote import ArchiveError, RemoteFrame, check_deadline
from .ids import FrameId
from .wcs import FieldGrid, TanSip

FIELD_SIZE = 512          # output pixels per side
PIXEL_ARCSEC = 6.15       # close to the native SPHEREx pixel (about 6.2 arcsec)
MIN_COVERAGE = 0.6        # below this a frame is not offered for the field

# FLAGS bit planes, from the MSKNnnnn cards of SPHEREx L2 files.
FLAG_NAMES = {
    0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC", 9: "MISSING_DATA",
    10: "HOT", 11: "COLD", 12: "FULLSAMPLE", 14: "PHANMISS", 15: "NONLINEAR", 17: "PERSIST",
    19: "OUTLIER", 20: "CROSSTALK", 21: "SOURCE", 22: "GHOST", 23: "GHOST_FPA", 24: "GHOST_EXT",
    25: "STREAK", 26: "BLOOM", 28: "HALO",
}
# Compact categories sent to the browser (one byte per pixel).
CAT_BAD = 1        # unusable pixel: NONFUNC, MISSING_DATA, SUR_ERROR, OVERFLOW, HOT, COLD, NONLINEAR
CAT_TRANSIENT = 2  # TRANSIENT, OUTLIER: typically particle hits
CAT_ARTIFACT = 4   # PERSIST, CROSSTALK, GHOST*, STREAK, BLOOM, HALO
CAT_SOURCE = 8     # SOURCE: pixel belongs to a known catalogued source (not a defect)
CAT_NODATA = 16    # outside the detector
CAT_CLIPPED = 32   # value outside float16 range, clipped
_BITS = {
    CAT_BAD: (6, 9, 2, 1, 10, 11, 15),
    CAT_TRANSIENT: (0, 19),
    CAT_ARTIFACT: (17, 20, 22, 23, 24, 25, 26, 28),
    CAT_SOURCE: (21,),
}
FLAG_CATEGORIES = {
    "bad": {"bit": CAT_BAD, "flags": [FLAG_NAMES[b] for b in _BITS[CAT_BAD]]},
    "transient": {"bit": CAT_TRANSIENT, "flags": [FLAG_NAMES[b] for b in _BITS[CAT_TRANSIENT]]},
    "artifact": {"bit": CAT_ARTIFACT, "flags": [FLAG_NAMES[b] for b in _BITS[CAT_ARTIFACT]]},
    "source": {"bit": CAT_SOURCE, "flags": [FLAG_NAMES[b] for b in _BITS[CAT_SOURCE]]},
    "nodata": {"bit": CAT_NODATA, "flags": []},
    "clipped": {"bit": CAT_CLIPPED, "flags": []},
}

FORMAT = {
    "name": "NTF1",
    "layout": "magic 'NTF1', uint16 width, uint16 height, uint32 reserved (little endian); "
              "float16[width*height] surface brightness in MJy/sr, row 0 = north, NaN = no data; "
              "uint8[width*height] flag categories; whole payload gzip-compressed",
}


def processing() -> dict:
    """Machine-readable description of how frames are prepared (stored with every result)."""
    return {
        "grid": {"projection": "TAN", "size": FIELD_SIZE, "pixel_arcsec": PIXEL_ARCSEC, "orientation": "north up, east left",
                 "crval": "field centre"},
        "resampling": "bilinear interpolation of the L2 IMAGE extension onto the common grid using the frame's own "
                      "TAN-SIP WCS (forward A/B and inverse AP/BP polynomials)",
        "flags": "a flag category is set when a source pixel carrying it contributes more than 25 % of the bilinear weight",
        "masking": "pixels with NONFUNC, MISSING_DATA, SUR_ERROR, OVERFLOW, HOT, COLD or NONLINEAR flags are set to no data",
        "display": "per-frame median background subtracted in the browser; one shared asinh stretch for all frames of a field",
        "units": "MJy/sr (L2 calibrated surface brightness, zodiacal light not subtracted)",
        "storage": "float16 (relative precision about 0.05 %), values beyond +/-65000 clipped and flagged",
        "format": FORMAT,
        "flag_categories": FLAG_CATEGORIES,
    }


def grid_for(ra: float, dec: float) -> FieldGrid:
    return FieldGrid(ra, dec, FIELD_SIZE, PIXEL_ARCSEC)


def _bilinear_weights(table_x, table_y, x, y):
    ix = np.clip(np.searchsorted(table_x, x) - 1, 0, len(table_x) - 2)
    iy = np.clip(np.searchsorted(table_y, y) - 1, 0, len(table_y) - 2)
    fx = (x - table_x[ix]) / (table_x[ix + 1] - table_x[ix])
    fy = (y - table_y[iy]) / (table_y[iy + 1] - table_y[iy])
    return ix, iy, np.clip(fx, 0, 1), np.clip(fy, 0, 1)


def wavelength_at(wave, x, y):
    """Bilinear lookup of (wavelength, bandwidth) in um at 0-based detector pixel(s)."""
    xs, ys, values = wave
    x1, y1 = np.asarray(x, float) + 1.0, np.asarray(y, float) + 1.0
    ix, iy, fx, fy = _bilinear_weights(xs, ys, x1, y1)
    v00, v01 = values[iy, ix], values[iy, ix + 1]
    v10, v11 = values[iy + 1, ix], values[iy + 1, ix + 1]
    fx, fy = np.asarray(fx)[..., None], np.asarray(fy)[..., None]
    out = (v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + v10 * (1 - fx) * fy + v11 * fx * fy)
    return out[..., 0], out[..., 1]


WAVE_GRID = 9  # wavelength samples per side of the field, sent to the browser


def wave_grid(wave, wcs, grid, shape):
    """Wavelength and bandwidth (um) on a WAVE_GRID x WAVE_GRID lattice of field pixels.

    Rows run north to south like the image. Points outside the detector are null.
    """
    ny, nx = shape
    step = np.linspace(0, FIELD_SIZE - 1, WAVE_GRID)
    gx, gy = np.meshgrid(step, step)
    sx, sy = wcs.world_to_pixel(*grid.sky(gx, gy))
    inside = np.isfinite(sx) & (sx >= 0) & (sx <= nx - 1) & (sy >= 0) & (sy <= ny - 1)
    lam, bw = wavelength_at(wave, np.where(inside, sx, 0), np.where(inside, sy, 0))
    def rows(values):
        return [[round(float(v), 4) if ok else None for v, ok in zip(r, m)] for r, m in zip(values, inside)]
    return {"size": WAVE_GRID, "pixels": [float(v) for v in step], "wavelength_um": rows(lam), "bandwidth_um": rows(bw)}


def _num(cards, key, default=None):
    value = cards.get(key, default)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def describe(frame_id: FrameId, ra: float, dec: float) -> dict:
    """Header-only description of a frame for a field: time, wavelength, coverage.

    Reads about 60 KB (headers and the WCS-WAVE table), no pixels.
    """
    remote = RemoteFrame(frame_id).read_headers()
    wcs = TanSip(remote.image)
    ny, nx = remote.shape
    grid = grid_for(ra, dec)
    step = np.linspace(0, FIELD_SIZE - 1, 33)
    gx, gy = np.meshgrid(step, step)
    sx, sy = wcs.world_to_pixel(*grid.sky(gx, gy))
    inside = np.isfinite(sx) & (sx >= 0) & (sx <= nx - 1) & (sy >= 0) & (sy <= ny - 1)
    coverage = float(inside.mean())
    cx, cy = wcs.world_to_pixel(ra, dec)
    cx, cy = float(cx), float(cy)
    center_inside = 0 <= cx <= nx - 1 and 0 <= cy <= ny - 1
    wave = remote.read_wave_table()
    check_deadline()
    info = _common(remote, frame_id, ra, dec)
    if center_inside:
        lam, bw = wavelength_at(wave, cx, cy)
        info.update(wavelength_um=round(float(lam), 4), bandwidth_um=round(float(bw), 4))
    if inside.any():
        lams, _ = wavelength_at(wave, np.clip(sx[inside], 0, nx - 1), np.clip(sy[inside], 0, ny - 1))
        info["wavelength_range_um"] = [round(float(lams.min()), 4), round(float(lams.max()), 4)]
    info.update(coverage=round(coverage, 3), center_pixel=[round(cx, 1), round(cy, 1)] if center_inside else None,
                wave_grid=wave_grid(wave, wcs, grid, remote.shape))
    return info


def _common(remote, frame_id, ra, dec):
    image, primary = remote.image, remote.primary
    size_deg = FIELD_SIZE * PIXEL_ARCSEC / 3600
    return {
        "id": frame_id.token,
        "obsid": image.get("OBSID") or primary.get("OBSID") or frame_id.obsid,
        "release": frame_id.release.upper(),
        "processing_version": frame_id.version,
        "detector": frame_id.detector,
        "date_avg": (image.get("DATE-AVG") or primary.get("DATE-AVG")) + "Z",
        "date_beg": (image.get("DATE-BEG") or "") + ("Z" if image.get("DATE-BEG") else ""),
        "mjd_avg": _num(image, "MJD-AVG"),
        "exposure_s": _num(image, "XPOSURE"),
        "psf_fwhm_arcsec": _num(image, "PSF_FWHM"),
        "l2_dqa": image.get("L2DQAFLG"),
        "bunit": image.get("BUNIT"),
        "astrometry_solved": image.get("ASTRONETSOLVED"),
        "astrometry_nstars": _num(image, "MATCH_NSTARS"),
        "links": {
            "irsa_cutout": frame_id.irsa_cutout_url(ra, dec, size_deg),
            "irsa_file": frame_id.irsa_url,
            "aws_file": frame_id.aws_url,
        },
        "fits_key": frame_id.key,
    }


def cutout(frame_id: FrameId, ra: float, dec: float):
    """Resample one frame onto the field grid. Returns (image, flags, info)."""
    remote = RemoteFrame(frame_id).read_headers()
    check_deadline()                      # before mapping 512x512 grid points through the WCS
    wcs = TanSip(remote.image)
    ny, nx = remote.shape
    grid = grid_for(ra, dec)
    py, px = np.mgrid[0:FIELD_SIZE, 0:FIELD_SIZE]
    sx, sy = wcs.world_to_pixel(*grid.sky(px, py))
    inside = np.isfinite(sx) & (sx >= 0) & (sx <= nx - 1) & (sy >= 0) & (sy <= ny - 1)
    coverage = float(inside.mean())
    if coverage < MIN_COVERAGE:
        raise ArchiveError("no_coverage", f"frame covers {coverage:.2f} of the field")
    first = int(np.floor(sy[inside].min()))
    last = min(ny - 1, int(np.ceil(sy[inside].max())) + 1)
    rows = remote.read_image_rows(first, last)
    flag_rows = remote.read_flag_rows(first, last)
    check_deadline()                      # before the reprojection (CPU)

    x0 = np.clip(np.floor(np.where(inside, sx, 0)).astype(int), 0, nx - 2)
    y0 = np.clip(np.floor(np.where(inside, sy, first)).astype(int) - first, 0, rows.shape[0] - 2)
    fx = np.clip(np.where(inside, sx, 0) - x0, 0, 1)
    fy = np.clip(np.where(inside, sy, first) - first - y0, 0, 1)
    corners = [rows[y0, x0], rows[y0, x0 + 1], rows[y0 + 1, x0], rows[y0 + 1, x0 + 1]]
    weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy]
    image = sum(c * w for c, w in zip(corners, weights)).astype(np.float32)
    image[~inside] = np.nan

    raw = [flag_rows[y0, x0], flag_rows[y0, x0 + 1], flag_rows[y0 + 1, x0], flag_rows[y0 + 1, x0 + 1]]
    flags = np.zeros(image.shape, np.uint8)
    for category, bits in _BITS.items():
        mask = sum(1 << b for b in bits)
        hit = np.zeros(image.shape, bool)
        for plane, weight in zip(raw, weights):
            hit |= ((plane & mask) != 0) & (weight > 0.25)
        flags[hit] |= category
    flags[~inside] = CAT_NODATA
    image[(flags & CAT_BAD) != 0] = np.nan

    wave = remote.read_wave_table()
    check_deadline()                      # before the wavelength grid (CPU)
    info = _common(remote, frame_id, ra, dec)
    cx, cy = wcs.world_to_pixel(ra, dec)
    lam, bw = wavelength_at(wave, float(np.clip(cx, 0, nx - 1)), float(np.clip(cy, 0, ny - 1)))
    lams, _ = wavelength_at(wave, sx[inside][::97], sy[inside][::97])
    valid = inside & np.isfinite(image)
    counts = {name: int(((flags & spec["bit"]) != 0)[inside].sum()) for name, spec in FLAG_CATEGORIES.items()
              if name not in ("nodata", "clipped")}
    info.update(
        coverage=round(coverage, 3), valid_fraction=round(float(valid.mean()), 3),
        wavelength_um=round(float(lam), 4), bandwidth_um=round(float(bw), 4),
        wavelength_range_um=[round(float(lams.min()), 4), round(float(lams.max()), 4)],
        flag_pixels=counts, rows_read=[first, last], wave_grid=wave_grid(wave, wcs, grid, remote.shape),
    )
    return image, flags, info


def encode(image: np.ndarray, flags: np.ndarray) -> bytes:
    """Pack a cutout in the NTF1 format (see FORMAT)."""
    h, w = image.shape
    limit = 65000.0
    clipped = np.isfinite(image) & (np.abs(image) > limit)
    flags = flags.copy()
    flags[clipped] |= CAT_CLIPPED
    data = np.clip(image, -limit, limit).astype("<f2")
    payload = b"NTF1" + struct.pack("<HHI", w, h, 0) + data.tobytes() + flags.astype(np.uint8).tobytes()
    return gzip.compress(payload, compresslevel=6, mtime=0)
