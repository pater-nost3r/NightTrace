import sys,re,urllib.request,urllib.parse,json
B="https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
def ls(prefix,delim=None):
    keys=[];pre=[];tok=None
    while True:
        q={"list-type":"2","prefix":prefix}
        if delim:q["delimiter"]=delim
        if tok:q["continuation-token"]=tok
        t=urllib.request.urlopen(B+"?"+urllib.parse.urlencode(q),timeout=60).read().decode()
        keys+=re.findall(r"<Key>([^<]*)</Key>",t); pre+=re.findall(r"<Prefix>([^<]*)</Prefix>",t)[1:]
        m=re.search(r"<NextContinuationToken>([^<]*)<",t)
        if not m:break
        tok=m.group(1)
    return keys,pre
if __name__=="__main__":
    _,weeks=ls("dr1/level2/","/")
    print(len(weeks),weeks[0],weeks[-1])
    json.dump(weeks,open("weeks.json","w"))
