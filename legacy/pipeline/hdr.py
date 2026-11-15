import urllib.request,re,json,sys
from concurrent.futures import ThreadPoolExecutor
B="https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
WANT=("CRVAL1","CRVAL2","DATE-OBS","DATE-AVG","MJD-AVG","OBSID","SPS_FLAGS","PSF_FWHM","L2DQAFLG","DETECTOR")
def hdr(key,nbytes=31680):
    for a in range(3):
        try:
            r=urllib.request.Request(B+key,headers={"Range":f"bytes=0-{nbytes-1}"})
            t=urllib.request.urlopen(r,timeout=60).read().decode("ascii","replace");break
        except Exception as e: t=""
    d={"key":key}
    for i in range(0,len(t),80):
        c=t[i:i+80]
        k=c[:8].strip()
        if c.startswith("HIERARCH"):
            m=re.match(r"HIERARCH (\S+) =\s*(.*)",c); 
            if m: k=m.group(1); v=m.group(2)
            else: continue
        elif c[8:10]=="= ": v=c[10:]
        else: continue
        if k in WANT:
            v=v.split(" /")[0].strip().strip("'").strip()
            try: v=float(v)
            except: pass
            d[k]=v
    return d
def many(keys,n=48):
    with ThreadPoolExecutor(n) as ex: return list(ex.map(hdr,keys))
