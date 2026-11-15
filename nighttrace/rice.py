"""Pure-Python RICE_1 decoder for 32-bit tiles (FITS tiled image compression).

Follows the reference algorithm in CFITSIO ``fits_rdecomp`` (Pence, White &
Seaman). Used only for the FLAGS extension, one 2040-pixel row per tile.
Bits are handled as a '0'/'1' string so that unary runs are found with
``str.find``, which keeps a row at a few milliseconds.
"""
import numpy as np

FSBITS = 5
FSMAX = 25
BBITS = 32
BLOCK = 32
MASK = 0xFFFFFFFF


def rice_decompress(buf: bytes, npix: int) -> np.ndarray:
    if len(buf) < 4:
        raise ValueError("RICE tile too short")
    last = int.from_bytes(buf[:4], "big")
    body = buf[4:]
    bits = format(int.from_bytes(body, "big"), f"0{len(body) * 8}b") if body else ""
    total = len(bits)
    pos = 0
    out = np.empty(npix, np.uint32)
    i = 0
    while i < npix:
        if pos + FSBITS > total:
            raise ValueError("RICE stream ended early")
        fs = int(bits[pos:pos + FSBITS], 2) - 1
        pos += FSBITS
        end = min(i + BLOCK, npix)
        if fs < 0:
            out[i:end] = last
            i = end
            continue
        if fs == FSMAX:
            for k in range(i, end):
                diff = int(bits[pos:pos + BBITS], 2)
                pos += BBITS
                diff = (diff >> 1) if not diff & 1 else (~(diff >> 1)) & MASK
                last = (last + diff) & MASK
                out[k] = last
            i = end
            continue
        for k in range(i, end):
            one = bits.find("1", pos)
            if one < 0:
                raise ValueError("RICE stream ended early")
            nzero = one - pos
            pos = one + 1
            low = int(bits[pos:pos + fs], 2) if fs else 0
            pos += fs
            diff = (nzero << fs) | low
            diff = (diff >> 1) if not diff & 1 else (~(diff >> 1)) & MASK
            last = (last + diff) & MASK
            out[k] = last
        i = end
    return out
