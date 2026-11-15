from s3list import ls; from hdr import many; import json
from concurrent.futures import ThreadPoolExecutor
weeks=json.load(open("weeks.json"))
def keys(w):
    _,p=ls(w,"/")
    k,_=ls(p[-1]+"1/")
    return [x for x in k if "_1D1_" in x]
with ThreadPoolExecutor(16) as ex: K=sum(ex.map(keys,weeks),[])
print("files",len(K),flush=True)
H=many(K,64)
json.dump(H,open("all_d1.json","w"))
print("done",len(H))
