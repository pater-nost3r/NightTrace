"""Read NTF1 frame files (helper for scripts and tests)."""
import gzip
import struct

import numpy as np


def read_ntf(data: bytes):
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    if data[:4] != b"NTF1":
        raise ValueError("not an NTF1 frame")
    w, h, _ = struct.unpack("<HHI", data[4:12])
    n = w * h
    image = np.frombuffer(data[12:12 + 2 * n], "<f2").astype(np.float32).reshape(h, w)
    flags = np.frombuffer(data[12 + 2 * n:12 + 3 * n], np.uint8).reshape(h, w)
    return image, flags
