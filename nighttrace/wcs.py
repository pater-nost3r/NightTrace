"""Minimal TAN and TAN-SIP world coordinate transforms (FITS Papers I/II, SIP 2005).

SPHEREx L2 frames use RA---TAN-SIP / DEC--TAN-SIP with forward (A, B) and
inverse (AP, BP) polynomials, PCi_j + CDELTi, LONPOLE = 180. Results are
checked against astropy in tests/test_wcs.py.
"""
from __future__ import annotations

import numpy as np

D2R = np.pi / 180.0


def _poly(coeffs, order, u, v):
    total = np.zeros_like(u, dtype=float)
    for i in range(order + 1):
        for j in range(order + 1 - i):
            c = coeffs.get((i, j))
            if c:
                total = total + c * u ** i * v ** j
    return total


def _sip(cards, prefix):
    order = int(cards.get(f"{prefix}_ORDER", 0) or 0)
    coeffs = {}
    for i in range(order + 1):
        for j in range(order + 1 - i):
            value = cards.get(f"{prefix}_{i}_{j}")
            if value is not None:
                coeffs[(i, j)] = float(value)
    return order, coeffs


def gnomonic(ra, dec, ra0, dec0):
    """Sky (deg) -> intermediate world coordinates (deg) for a TAN projection."""
    a, d = np.asarray(ra, float) * D2R, np.asarray(dec, float) * D2R
    a0, d0 = ra0 * D2R, dec0 * D2R
    cos_c = np.sin(d) * np.sin(d0) + np.cos(d) * np.cos(d0) * np.cos(a - a0)
    with np.errstate(divide="ignore", invalid="ignore"):
        xi = np.cos(d) * np.sin(a - a0) / cos_c
        eta = (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / cos_c
    behind = cos_c <= 0
    xi = np.where(behind, np.nan, xi)
    eta = np.where(behind, np.nan, eta)
    return xi / D2R, eta / D2R


def inverse_gnomonic(xi, eta, ra0, dec0):
    """Intermediate world coordinates (deg) -> sky (deg)."""
    x, y = np.asarray(xi, float) * D2R, np.asarray(eta, float) * D2R
    d0 = dec0 * D2R
    rho = np.hypot(x, y)
    c = np.arctan(rho)
    with np.errstate(divide="ignore", invalid="ignore"):
        dec = np.arcsin(np.cos(c) * np.sin(d0) + np.where(rho > 0, y * np.sin(c) * np.cos(d0) / rho, 0))
        ra = ra0 * D2R + np.arctan2(x * np.sin(c), rho * np.cos(d0) * np.cos(c) - y * np.sin(d0) * np.sin(c))
    return (ra / D2R) % 360.0, dec / D2R


class TanSip:
    def __init__(self, cards):
        ctype1, ctype2 = str(cards.get("CTYPE1", "")), str(cards.get("CTYPE2", ""))
        if not (ctype1.startswith("RA---TAN") and ctype2.startswith("DEC--TAN")):
            raise ValueError("only TAN / TAN-SIP projections are supported")
        if float(cards.get("LONPOLE", 180.0)) != 180.0:
            raise ValueError("unsupported LONPOLE")
        self.crpix = np.array([float(cards["CRPIX1"]), float(cards["CRPIX2"])])
        self.crval = (float(cards["CRVAL1"]), float(cards["CRVAL2"]))
        if "CD1_1" in cards:
            cd = [[cards.get("CD1_1", 0.0), cards.get("CD1_2", 0.0)], [cards.get("CD2_1", 0.0), cards.get("CD2_2", 0.0)]]
        else:
            pc = [[cards.get("PC1_1", 1.0), cards.get("PC1_2", 0.0)], [cards.get("PC2_1", 0.0), cards.get("PC2_2", 1.0)]]
            cdelt = [float(cards.get("CDELT1", 1.0)), float(cards.get("CDELT2", 1.0))]
            cd = [[pc[0][0] * cdelt[0], pc[0][1] * cdelt[0]], [pc[1][0] * cdelt[1], pc[1][1] * cdelt[1]]]
        self.cd = np.array(cd, float)
        self.cd_inv = np.linalg.inv(self.cd)
        sip = ctype1.endswith("-SIP")
        self.a = _sip(cards, "A") if sip else (0, {})
        self.b = _sip(cards, "B") if sip else (0, {})
        self.ap = _sip(cards, "AP") if sip else (0, {})
        self.bp = _sip(cards, "BP") if sip else (0, {})
        if sip and not (self.ap[0] and self.bp[0]):
            raise ValueError("SIP inverse coefficients (AP/BP) missing")
        # The SIP polynomials are only valid near the detector. Far-away sky positions can
        # fold back onto detector pixels, so world_to_pixel rejects points outside this
        # radius (pre-SIP, in pixels from CRPIX) and verifies every result by a round trip.
        size = max(float(cards.get("NAXIS1", 0) or 0), float(cards.get("NAXIS2", 0) or 0)) or 4096.0
        self.max_radius = 1.5 * size

    def world_to_pixel(self, ra, dec):
        """Sky (deg) -> 0-based pixel coordinates (x along NAXIS1, y along NAXIS2)."""
        xi, eta = gnomonic(ra, dec, *self.crval)
        u = self.cd_inv[0, 0] * xi + self.cd_inv[0, 1] * eta
        v = self.cd_inv[1, 0] * xi + self.cd_inv[1, 1] * eta
        far = ~(np.hypot(u, v) <= self.max_radius)
        u, v = np.where(far, np.nan, u), np.where(far, np.nan, v)
        if self.ap[0]:
            du = _poly(self.ap[1], self.ap[0], u, v)
            dv = _poly(self.bp[1], self.bp[0], u, v)
            u, v = u + du, v + dv
        x, y = u + self.crpix[0] - 1.0, v + self.crpix[1] - 1.0
        if self.ap[0]:
            # Round trip: the inverse SIP is an approximation; accept it only within 0.5 px.
            xi2, eta2 = self._intermediate(x, y)
            err = np.hypot(xi2 - xi, eta2 - eta) / np.sqrt(abs(np.linalg.det(self.cd)))
            bad = ~(err <= 0.5)
            x, y = np.where(bad, np.nan, x), np.where(bad, np.nan, y)
        return x, y

    def _intermediate(self, x, y):
        u = np.asarray(x, float) + 1.0 - self.crpix[0]
        v = np.asarray(y, float) + 1.0 - self.crpix[1]
        if self.a[0]:
            u, v = u + _poly(self.a[1], self.a[0], u, v), v + _poly(self.b[1], self.b[0], u, v)
        return self.cd[0, 0] * u + self.cd[0, 1] * v, self.cd[1, 0] * u + self.cd[1, 1] * v

    def pixel_to_world(self, x, y):
        """0-based pixel -> sky (deg)."""
        xi, eta = self._intermediate(x, y)
        return inverse_gnomonic(xi, eta, *self.crval)


class FieldGrid:
    """Common output grid: TAN centred on the field, north up, east left.

    Pixel (px, py) is 0-based with py = 0 at the top (north) row, matching
    how the browser draws the image. The same formulas live in
    public/js/sky.js so marks can be stored as RA/Dec.
    """

    def __init__(self, ra: float, dec: float, size: int, pixel_arcsec: float):
        self.ra, self.dec, self.size, self.pixel_arcsec = ra, dec, size, pixel_arcsec
        self.scale = pixel_arcsec / 3600.0
        self.center = (size - 1) / 2.0

    def sky(self, px, py):
        xi = -(np.asarray(px, float) - self.center) * self.scale
        eta = (self.center - np.asarray(py, float)) * self.scale
        return inverse_gnomonic(xi, eta, self.ra, self.dec)

    def pixel(self, ra, dec):
        xi, eta = gnomonic(ra, dec, self.ra, self.dec)
        return self.center - xi / self.scale, self.center - eta / self.scale

    def describe(self):
        return {"projection": "TAN", "crval": [self.ra, self.dec], "size": self.size,
                "pixel_arcsec": self.pixel_arcsec, "center_pixel": self.center,
                "orientation": "north up, east left", "row0": "north"}
