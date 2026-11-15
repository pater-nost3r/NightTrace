"""Validated SPHEREx observation identifiers.

A frame is addressed by four short parts instead of a URL, so the server
never fetches an address chosen by the client:

    release : "dr1" | "qr3" | "qr2"
    version : processing version, e.g. "l2b-v27-2026-234"
    obsid   : observation id, e.g. "2026W11_2A_0519_1"
    detector: 1..6

The S3 key is rebuilt from these parts with a fixed template.
"""
from dataclasses import dataclass
import re

BUCKET_URL = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
IRSA_IBE = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"

RELEASES = ("dr1", "qr3", "qr2")
_VERSION = re.compile(r"l2b(?:_[a-z]+)?-v\d{1,3}-\d{4}-\d{3}")
_OBSID = re.compile(r"(\d{4}W\d{2}_\d[A-Z])_\d{4}_\d")
_KEY = re.compile(
    r"(dr1|qr3|qr2)/level2/(\d{4}W\d{2}_\d[A-Z])/(l2b(?:_[a-z]+)?-v\d{1,3}-\d{4}-\d{3})/([1-6])/"
    r"level2_((\d{4}W\d{2}_\d[A-Z])_\d{4}_\d)D([1-6])_spx_(l2b(?:_[a-z]+)?-v\d{1,3}-\d{4}-\d{3})\.fits"
)


@dataclass(frozen=True)
class FrameId:
    release: str
    version: str
    obsid: str
    detector: int

    @property
    def week(self) -> str:
        return _OBSID.fullmatch(self.obsid).group(1)

    @property
    def key(self) -> str:
        return (f"{self.release}/level2/{self.week}/{self.version}/{self.detector}/"
                f"level2_{self.obsid}D{self.detector}_spx_{self.version}.fits")

    @property
    def token(self) -> str:
        return f"{self.release}:{self.version}:{self.obsid}:{self.detector}"

    @property
    def aws_url(self) -> str:
        return BUCKET_URL + self.key

    @property
    def irsa_url(self) -> str:
        return IRSA_IBE + self.key

    def irsa_cutout_url(self, ra: float, dec: float, size_deg: float) -> str:
        return f"{self.irsa_url}?center={ra:.5f},{dec:.5f}&size={size_deg:.4f}"


def parse_token(token: str) -> FrameId:
    """Parse ``release:version:obsid:detector``; raise ValueError if invalid."""
    if not isinstance(token, str) or len(token) > 80:
        raise ValueError("bad frame id")
    parts = token.split(":")
    if len(parts) != 4:
        raise ValueError("bad frame id")
    release, version, obsid, detector = parts
    if release not in RELEASES or not _VERSION.fullmatch(version) or not _OBSID.fullmatch(obsid):
        raise ValueError("bad frame id")
    if detector not in {"1", "2", "3", "4", "5", "6"}:
        raise ValueError("bad frame id")
    return FrameId(release, version, obsid, int(detector))


def from_key(key: str) -> FrameId:
    """Parse an S3 key or IRSA path tail; raise ValueError if it is not a L2 frame."""
    match = _KEY.fullmatch(key)
    if not match:
        raise ValueError("not a SPHEREx level 2 frame key")
    release, week, version, det_dir, obsid, week2, det, version2 = match.groups()
    if week != week2 or version != version2 or det_dir != det:
        raise ValueError("inconsistent key")
    return FrameId(release, version, obsid, int(det))
