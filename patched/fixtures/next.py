import json, subprocess, sys
dec = json.JSONDecoder()
def run(args):
    r = subprocess.run(["aidlc","engine","orchestrate",*args], capture_output=True, text=True)
    objs = []
    for raw in (r.stdout, r.stderr):
        pos = 0
        while True:
            i = raw.find('{', pos)
            if i < 0: break
            try:
                obj, end = dec.raw_decode(raw[i:]); objs.append(obj); pos = i + end
            except Exception:
                pos = i + 1
    with_kind = [o for o in objs if isinstance(o, dict) and "kind" in o]
    if with_kind: return with_kind[-1]
    if objs: return objs[-1]
    return {"raw": (r.stdout + r.stderr).strip()[:1200], "rc": r.returncode}
d = run(sys.argv[1:] or ["next"])
for _ in range(40):
    if d.get("kind") != "load-steering": break
    d = run(["continue", d["receipt"]])
d.pop("conductor_persona", None)
print(json.dumps(d))
