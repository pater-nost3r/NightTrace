import numpy as np
from scipy.interpolate import RegularGridInterpolator

from cut import get


def wave(key, x, y):
    data = get(key, 20000)
    name = data.rfind(b"EXTNAME = 'WCS-WAVE'")
    start = data.rfind(b"XTENSION", 0, name) if name >= 0 else -1
    if start < 0:
        raise ValueError("WCS-WAVE extension missing")
    end = next((i for i in range(start, len(data), 80)
                if data[i:i + 8] == b"END     "), None)
    if end is None:
        raise ValueError("Incomplete WCS-WAVE header")
    offset = start + ((end - start + 80 + 2879) // 2880) * 2880
    row = data[offset:offset + 720]
    xs = np.frombuffer(row[:36], ">i4")
    ys = np.frombuffer(row[36:72], ">i4")
    values = np.frombuffer(row[72:], ">f4").reshape(9, 9, 2)
    return tuple(float(v) for v in RegularGridInterpolator((ys, xs), values)([[y + 1, x + 1]])[0])

