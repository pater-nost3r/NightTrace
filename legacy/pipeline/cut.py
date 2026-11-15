from urllib.request import Request, urlopen

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates

B = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
RA0, DE0 = 269.6392, 66.6331
N, PIX = 520, 6.15 / 3600


def get(key, start, end=None):
    value = f"bytes={start}-{end}" if end is not None else f"bytes=-{start}"
    with urlopen(Request(B + key, headers={"Range": value}), timeout=20) as response:
        data = response.read(17_000_001)
        expected = end - start + 1 if end is not None else start
        if response.status != 206 or len(data) != expected:
            raise ValueError("Unexpected FITS byte range")
        return data


def target_wcs(ra=RA0, dec=DE0):
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(N + 1) / 2] * 2
    wcs.wcs.cdelt = [-PIX, PIX]
    return wcs


def cutout(key, center=(RA0, DE0)):
    raw = get(key, 0, 40319)

    def header(offset):
        for end in range(offset, len(raw), 80):
            if raw[end:end + 8] == b"END     ":
                stop = end + 80
                padded = offset + ((stop - offset + 2879) // 2880) * 2880
                return fits.Header.fromstring(raw[offset:stop].decode("ascii"), sep=""), padded
        raise ValueError("FITS header exceeds downloaded range")

    primary, offset = header(0)
    h, data_start = header(offset)
    if primary["NAXIS"] != 0 or h.get("EXTNAME") != "IMAGE" or h["BITPIX"] != -32:
        raise ValueError("Unexpected FITS image format")
    wcs = WCS(h, relax=True, naxis=2)
    yy, xx = np.mgrid[0:N, 0:N]
    ra, dec = target_wcs(*center).all_pix2world(xx, yy, 0)
    sx, sy = wcs.all_world2pix(ra, dec, 0, quiet=True)
    nx, ny = h["NAXIS1"], h["NAXIS2"]
    valid = (sx >= 0) & (sx <= nx - 1) & (sy >= 0) & (sy <= ny - 1)
    if valid.mean() < 0.98:
        raise ValueError("Frame does not cover the field")
    first = max(0, int(np.floor(sy[valid].min())))
    last = min(ny - 1, int(np.ceil(sy[valid].max())))
    buf = get(key, data_start + first * nx * 4, data_start + (last + 1) * nx * 4 - 1)
    img = np.frombuffer(buf, ">f4").reshape(-1, nx).astype(np.float32)
    out = map_coordinates(img, [sy - first, sx], order=1, cval=np.nan)
    if np.isfinite(out).mean() < 0.95:
        raise ValueError("Insufficient finite pixels")
    tx, ty = wcs.all_world2pix([center], 0)[0]
    return out, primary, h, float(tx), float(ty)

