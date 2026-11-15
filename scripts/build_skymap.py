"""Build the all-sky background of the region map from the real SPHEREx DR1 HiPS cube.

    python scripts/build_skymap.py     # ~4 min, ~200 MB of range reads from AWS S3; run locally

Source: s3://nasa-irsa-spherex/dr1/hips5_cube/hips_20261026 (HEALPix order 5, 12288 tiles,
512x512 pixels, 102 spectral planes). Plane 46 is the 2.189 um channel (SPECTRAL_CHANNELS table).
Eight rows of each tile are read (every 64th row) and splatted onto a 1440x720 equirectangular
ICRS grid (RA 360 on the left, as on the map); gaps are filled from neighbours. Tile pixel
(column c, row r) is HEALPix nested sub-pixel (x = 511 - r, y = c) of the tile at order 14;
this was checked against the tile WCS (RA---HPX) with astropy. Needs: numpy, pillow,
astropy-healpix, urllib3. The image is for navigation only.
"""
import numpy as np, time, sys, threading
from concurrent.futures import ThreadPoolExecutor
import urllib3
from astropy_healpix import HEALPix
HOST="nasa-irsa-spherex.s3.us-east-1.amazonaws.com"
PRE="/dr1/hips5_cube/hips_20261026/Norder5/"
PLANE=46; ROWS=list(range(32,512,64))
import os
_retry = urllib3.Retry(4, backoff_factor=0.5)
_proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
pool = (urllib3.ProxyManager(_proxy, maxsize=64, retries=_retry, timeout=30, ca_certs=os.environ.get("SSL_CERT_FILE"))
        if _proxy else urllib3.PoolManager(maxsize=64, retries=_retry, timeout=30))
W,H=1440,720
acc=np.zeros((H,W)); cnt=np.zeros((H,W))
lock=threading.Lock()
hp=HEALPix(nside=2**14, order="nested")
def interleave(x,y):
    s=np.zeros_like(x)
    for i in range(9): s|=((x>>i)&1)<<(2*i) | ((y>>i)&1)<<(2*i+1)
    return s
cols=np.arange(512)
def tile(n):
    path=PRE+f"Dir{(n//10000)*10000}/Npix{n}_cube.fits"
    vals=[];idx=[]
    for r in ROWS:
        a=8640+PLANE*512*512*4+r*2048
        resp=pool.request("GET","https://"+HOST+path,headers={"Range":f"bytes={a}-{a+2047}"})
        if resp.status!=206: raise RuntimeError(f"{n} {resp.status}")
        v=np.frombuffer(resp.data,">f4").astype(float)
        xs=np.full(512,511-r); ys=cols
        idx.append(n*(1<<18)+interleave(xs,ys)); vals.append(v)
    idx=np.concatenate(idx); vals=np.concatenate(vals)
    lon,lat=hp.healpix_to_lonlat(idx)
    ra=lon.deg; dec=lat.deg
    x=np.clip(((360-ra)/360*W).astype(int),0,W-1); y=np.clip(((90-dec)/180*H).astype(int),0,H-1)
    ok=np.isfinite(vals)
    with lock:
        np.add.at(acc,(y[ok],x[ok]),vals[ok]); np.add.at(cnt,(y[ok],x[ok]),1)
t=time.time(); done=0; fails=[]
with ThreadPoolExecutor(48) as ex:
    futs={ex.submit(tile,n):n for n in range(12288)}
    for f in futs:
        try: f.result()
        except Exception as e: fails.append(str(e))
        done+=1
        if done%1000==0: print(done, round(time.time()-t), len(fails), flush=True)
print("done", time.time()-t, "fails", len(fails), fails[:5])

from pathlib import Path
from PIL import Image
img = np.where(cnt > 0, acc / np.maximum(cnt, 1), np.nan)
for _ in range(6):
    m = np.isfinite(img)
    if m.all():
        break
    pad = np.pad(np.where(m, img, 0), 1, mode="wrap"); pm = np.pad(m.astype(float), 1, mode="wrap")
    s = sum(pad[1 + dy:pad.shape[0] - 1 + dy, 1 + dx:pad.shape[1] - 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
    c = sum(pm[1 + dy:pm.shape[0] - 1 + dy, 1 + dx:pm.shape[1] - 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
    img = np.where(m, img, np.where(c > 0, s / np.maximum(c, 1), np.nan))
img = np.nan_to_num(img, nan=np.nanmedian(img))
x = np.clip(img - np.percentile(img, 2), 0, None)
y = np.clip(np.arcsinh(x / 0.05) / np.arcsinh(np.percentile(x, 99.7) / 0.05), 0, 1) ** 0.9
out = Path(__file__).resolve().parents[1] / "public" / "img" / "sky-spherex-2um.jpg"
Image.fromarray((y * 255).astype(np.uint8)).save(out, quality=74, optimize=True, progressive=True)
print("wrote", out)
