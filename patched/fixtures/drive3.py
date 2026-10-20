import json, os, subprocess, sys
dec = json.JSONDecoder()
S = os.path.dirname(os.path.abspath(__file__))  # write-stage.ts sits next to this driver
def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    for raw in (r.stdout, r.stderr):
        i = raw.find('{')
        if i >= 0:
            try: return dec.raw_decode(raw[i:])[0]
            except Exception: pass
    return {'raw': (r.stdout + r.stderr).strip()[:300], 'code': r.returncode}
def tool(t, *a): return run((['aidlc','engine','state',*a] if t=='aidlc-state.ts' else ['aidlc','engine',*a[1:]] if t=='aidlc.ts' else ['bun', f'.claude/tools/{t}', *a]))
def orch(*a):
    d = tool('aidlc.ts', 'engine', 'orchestrate', *a)
    for _ in range(40):
        if d.get('kind') != 'load-steering': break
        d = tool('aidlc.ts', 'engine', 'orchestrate', 'continue', d['receipt'])
    return d
def human(text):  # the person's reply, recorded by the engine's own hook into the shard this checkout writes
    cwd = os.getcwd(); t = os.path.join(__import__('tempfile').gettempdir(), 'drive3-transcript.jsonl')
    open(t, 'w').write(json.dumps({'type': 'user', 'cwd': cwd, 'sessionId': 'sim'}) + '\n')
    hook = {'session_id': 'sim', 'transcript_path': t, 'cwd': cwd, 'hook_event_name': 'UserPromptSubmit', 'prompt': text}
    subprocess.run(['aidlc', 'engine', 'hook', 'record-human-turn'], input=json.dumps(hook), capture_output=True, text=True,
                   env={**os.environ, 'CLAUDE_PROJECT_DIR': cwd})
def brief(d): return {k: str(d.get(k))[:220] for k in ('kind','stage','unit','gate','error','message','narration','ask_type','reason_codes','raw','code','question') if d.get(k) is not None}
checkout, unit = sys.argv[1], sys.argv[2]
for stage in sys.argv[3:] or ['functional-design','nfr-requirements','nfr-design','infrastructure-design','code-generation']:
    print(f'--- {stage}')
    print(' start   ', brief(tool('aidlc-state.ts', 'unit', 'start', '--stage', stage, '--unit', unit)))
    print(' write   ', brief(run(['bun', f'{S}/write-stage.ts', checkout, unit, stage])))
    if stage == 'code-generation':
        d = orch('next'); print(' plan    ', brief(d))
        if d.get('ask_type') == 'plan-approval':
            # The person's reply to the engine's plan question: the human-turn hook records the approval
            # and writes the answer into the questions file, as in a real session.
            human('Approve Plan')
            print(' next    ', brief(orch('next')))
    print(' complete', brief(tool('aidlc-state.ts', 'unit', 'complete', '--stage', stage, '--unit', unit)))
    d = orch('next'); print(' next    ', brief(d))
    if d.get('kind') == 'ask' or (d.get('kind') == 'run-stage' and d.get('gate') is True):
        print(' approve ', brief(orch('report', '--stage', stage, '--unit', unit, '--result', 'approved', '--user-input', 'Approve')))
        d = orch('next'); print(' next    ', brief(d))
    if d.get('kind') not in ('run-stage', 'ask') or d.get('stage') == stage: break
