#!/usr/bin/env python3
"""hunksplit.py <diff> list                → number every hunk: index, file, @@ header
   hunksplit.py <diff> pick <out> i,j,k... → write a diff containing only those hunks (file headers kept)"""
import sys,re
text=open(sys.argv[1]).read()
files=re.split(r'(?m)^(?=diff --git )', text)
hunks=[]  # (file_header, hunk_text, path, hdr)
for f in files:
    if not f.startswith('diff --git'): continue
    parts=re.split(r'(?m)^(?=@@ )', f)
    header=parts[0]; path=re.search(r'^\+\+\+ b/(.*)$', header, re.M)
    path=path.group(1) if path else re.search(r'diff --git a/(\S+)', header).group(1)
    for h in parts[1:]:
        hunks.append((header, h, path, h.splitlines()[0]))
cmd=sys.argv[2]
if cmd=='list':
    for i,(hdr,h,path,first) in enumerate(hunks): print(i, path, first[:60])
elif cmd=='pick':
    out=sys.argv[3]; sel=[int(x) for x in sys.argv[4].split(',')]
    by={}
    for i in sel:
        hdr,h,path,_=hunks[i]; by.setdefault(path,[hdr,[]])[1].append(h)
    with open(out,'w') as w:
        for path,(hdr,hs) in by.items():
            w.write(hdr); [w.write(h) for h in hs]
    print("wrote", out, "hunks", sel)
