"""Read parts of a remote SPHEREx L2 FITS file with HTTP range requests.

Layout of a SPHEREx L2 file (checked against DR1 and QR3 files):
  0  primary HDU (no data)
  1  IMAGE     float32 2040x2040, MJy/sr
  2  FLAGS     tile-compressed int32 bitmask (RICE_1, one tile per row)
  3  VARIANCE  float32
  4  ZODI      float32
  5  EPSF      table
  6  WCS-WAVE  table with per-pixel wavelength / bandwidth control points
Only the HDUs this tool needs are read, and only the rows it needs.
"""
from __future__ import annotations

import re
import time
import urllib.error
import urllib.request

import numpy as np

from . import budget
from .ids import FrameId

BLOCK = 2880
TIMEOUT = 20
MAX_RANGE = 12_000_000  # bytes; a 512 px field needs at most ~6 MB of image rows
USER_AGENT = "NightTrace/1.0 (SPHEREx comparison viewer)"


class ArchiveError(Exception):
    """The archive did not answer as expected (network, timeout, format)."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}")
        self.code = code


CHUNK = 64 * 1024


def check_deadline():
    """Raise a controlled timeout once the request's time budget is spent (before heavy work)."""
    if budget.expired():
        raise ArchiveError("timeout", "request time budget spent")


def read_bounded(response, limit: int) -> bytes:
    """Read at most ``limit`` bytes in small chunks, never past the request deadline.

    A socket timeout only bounds each single recv(); a server that keeps sending a few bytes
    at a time could otherwise hold the request open indefinitely. Before every chunk the
    socket timeout is lowered to the time that is left, and the deadline is checked again.
    """
    sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
    read = getattr(response, "read1", None) or response.read
    parts, size = [], 0
    while size < limit:
        left = budget.remaining()
        if left is not None:
            if left <= 0:
                raise ArchiveError("timeout", "request time budget spent while reading")
            if sock is not None and not getattr(response, "isclosed", lambda: False)():
                try:
                    sock.settimeout(max(0.05, min(left, TIMEOUT)))
                except OSError:           # the connection was already closed after the last byte
                    pass
        chunk = read(min(CHUNK, limit - size))
        if not chunk:
            break
        parts.append(chunk)
        size += len(chunk)
    check_deadline()
    return b"".join(parts)


def fetch_range(url: str, start: int, end: int | None = None, *, suffix: int | None = None,
                attempts: int = 2) -> bytes:
    """Return bytes [start, end] (inclusive) or the last ``suffix`` bytes.

    Retries once on transient errors with a short pause; never loops.
    """
    if suffix is not None:
        header = f"bytes=-{suffix}"
        expected = suffix
    else:
        if end is None or end < start or end - start + 1 > MAX_RANGE:
            raise ValueError("invalid range")
        header = f"bytes={start}-{end}"
        expected = end - start + 1
    last = None
    for attempt in range(attempts):
        timeout = budget.call_timeout(TIMEOUT)
        if timeout is None:
            raise last or ArchiveError("timeout", "request time budget spent")
        try:
            request = urllib.request.Request(url, headers={"Range": header, "User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = read_bounded(response, expected + 1)
                if response.status != 206 or len(data) != expected:
                    raise ArchiveError("format", "unexpected range response")
                return data
        except urllib.error.HTTPError as error:
            if error.code in (403, 404, 416):
                raise ArchiveError("not_found", f"HTTP {error.code}") from None
            last = ArchiveError("rate_limited" if error.code in (429, 503) else "upstream", f"HTTP {error.code}")
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            last = ArchiveError("timeout" if "timed out" in str(error) else "network", type(error).__name__)
        if attempt + 1 < attempts:
            if not budget.can_wait(0.6):
                break
            time.sleep(0.6)
    raise last


_HIER = re.compile(r"^HIERARCH\s+(.+?)\s*=\s*(.*)$")


def _value(text: str):
    text = text.strip()
    if text.startswith("'"):
        end = text.find("'", 1)
        while end != -1 and text[end + 1:end + 2] == "'":
            end = text.find("'", end + 2)
        return text[1:end].replace("''", "'").rstrip() if end != -1 else text[1:].rstrip()
    text = text.split("/", 1)[0].strip()
    if text == "T":
        return True
    if text == "F":
        return False
    try:
        number = float(text.replace("D", "E"))
    except ValueError:
        return text
    return int(number) if number.is_integer() and re.fullmatch(r"[+-]?\d+", text) else number


def parse_header(raw: bytes, offset: int = 0):
    """Parse one FITS header at ``offset``. Returns (cards, padded_length) or None if END missing."""
    cards = {}
    for pos in range(offset, len(raw) - 79, 80):
        card = raw[pos:pos + 80].decode("ascii", "replace")
        if card.startswith("END") and card[3:].strip() == "":
            length = pos + 80 - offset
            return cards, ((length + BLOCK - 1) // BLOCK) * BLOCK
        if card.startswith("HIERARCH"):
            match = _HIER.match(card)
            if match:
                cards[match.group(1).strip()] = _value(match.group(2))
        elif card[8:10] == "= ":
            cards[card[:8].strip()] = _value(card[10:])
    return None


def _data_bytes(cards) -> int:
    naxis = int(cards.get("NAXIS", 0))
    if naxis == 0:
        return 0
    count = 1
    for axis in range(1, naxis + 1):
        count *= int(cards[f"NAXIS{axis}"])
    size = abs(int(cards["BITPIX"])) // 8 * count + int(cards.get("PCOUNT", 0) or 0)
    return ((size + BLOCK - 1) // BLOCK) * BLOCK


class RemoteFrame:
    """Lazily reads headers and data rows of one SPHEREx L2 frame."""

    def __init__(self, frame: FrameId):
        self.id = frame
        self.url = frame.aws_url
        self.primary = None
        self.image = None
        self.image_data = None
        self.flags = None
        self.flags_offset = None

    def get(self, start, end):
        return fetch_range(self.url, start, end)

    def read_headers(self):
        raw = self.get(0, 43199)
        primary = parse_header(raw, 0)
        if not primary:
            raise ArchiveError("format", "primary header too long")
        self.primary, offset = primary
        image = parse_header(raw, offset)
        if image is None:
            raw += self.get(len(raw), len(raw) + 28799)
            image = parse_header(raw, offset)
        if image is None:
            raise ArchiveError("format", "image header too long")
        self.image, length = image
        if self.image.get("EXTNAME") != "IMAGE" or self.image.get("BITPIX") != -32 or self.image.get("NAXIS") != 2:
            raise ArchiveError("format", "unexpected image HDU")
        self.image_data = offset + length
        self.flags_offset = self.image_data + _data_bytes(self.image)
        return self

    @property
    def shape(self):
        return int(self.image["NAXIS2"]), int(self.image["NAXIS1"])

    def read_image_rows(self, first: int, last: int) -> np.ndarray:
        ny, nx = self.shape
        first, last = max(0, first), min(ny - 1, last)
        start = self.image_data + first * nx * 4
        raw = self.get(start, start + (last - first + 1) * nx * 4 - 1)
        return np.frombuffer(raw, ">f4").reshape(-1, nx).astype(np.float32)

    def read_flag_rows(self, first: int, last: int) -> np.ndarray:
        """Decode the RICE-compressed FLAGS rows ``first..last`` (0-based, inclusive)."""
        from .rice import rice_decompress

        raw = self.get(self.flags_offset, self.flags_offset + 47999)
        parsed = parse_header(raw, 0)
        if parsed is None:
            raise ArchiveError("format", "flags header too long")
        cards, length = parsed
        if cards.get("EXTNAME") != "FLAGS" or cards.get("ZCMPTYPE") != "RICE_1" or int(cards.get("ZTILE2", 0)) != 1:
            raise ArchiveError("format", "unexpected FLAGS HDU")
        if int(cards.get("ZVAL2", 4)) != 4 or int(cards.get("ZVAL1", 32)) != 32:
            raise ArchiveError("format", "unsupported RICE parameters")
        rows, width = int(cards["NAXIS2"]), int(cards["NAXIS1"])
        nx = int(cards["ZNAXIS1"])
        table_end = length + rows * width
        if len(raw) < table_end:
            raw += self.get(self.flags_offset + len(raw), self.flags_offset + table_end - 1)
        table = np.frombuffer(raw[length:table_end], ">i4").reshape(rows, 2)
        first, last = max(0, first), min(rows - 1, last)
        sizes, offsets = table[first:last + 1, 0], table[first:last + 1, 1]
        heap = self.flags_offset + length + int(cards.get("THEAP", rows * width))
        lo, hi = int(offsets.min()), int((offsets + sizes).max())
        blob = self.get(heap + lo, heap + hi - 1)
        out = np.empty((last - first + 1, nx), np.uint32)
        for row, (size, off) in enumerate(zip(sizes, offsets)):
            if row % 64 == 0:
                check_deadline()          # RICE decoding is pure Python and takes ~1 ms per row
            out[row] = rice_decompress(blob[off - lo:off - lo + size], nx)
        return out

    def read_wave_table(self):
        """Return (xs, ys, values[ny, nx, 2]) control points of WCS-WAVE (1-based pixels)."""
        data = fetch_range(self.url, 0, suffix=20160)
        name = data.rfind(b"EXTNAME = 'WCS-WAVE'")
        start = data.rfind(b"XTENSION", 0, name) if name >= 0 else -1
        if start < 0:
            raise ArchiveError("format", "WCS-WAVE missing")
        parsed = parse_header(data, start)
        if parsed is None:
            raise ArchiveError("format", "WCS-WAVE header incomplete")
        cards, length = parsed
        form_x, form_v = str(cards.get("TFORM1", "")), str(cards.get("TFORM3", ""))
        nx_pts = int(re.match(r"(\d+)J", form_x).group(1))
        ny_pts = int(re.match(r"(\d+)J", str(cards.get("TFORM2", ""))).group(1))
        n_vals = int(re.match(r"(\d+)E", form_v).group(1))
        if n_vals != nx_pts * ny_pts * 2:
            raise ArchiveError("format", "WCS-WAVE size mismatch")
        row = data[start + length:start + length + 4 * (nx_pts + ny_pts + n_vals)]
        xs = np.frombuffer(row[:4 * nx_pts], ">i4").astype(float)
        ys = np.frombuffer(row[4 * nx_pts:4 * (nx_pts + ny_pts)], ">i4").astype(float)
        values = np.frombuffer(row[4 * (nx_pts + ny_pts):], ">f4").reshape(ny_pts, nx_pts, 2).astype(float)
        return xs, ys, values
