#!/usr/bin/env python3
import copy
import json
import subprocess
import sys
from pathlib import Path

root = Path(__file__).parent
corpus = json.loads((root / 'responses-stream-corpus.json').read_text())
ts = json.loads(subprocess.check_output([sys.executable, str(root / 'run-responses-stream-ts.py')], text=True))
dotnet = sys.argv[1] if len(sys.argv) > 1 else 'dotnet'
cs = json.loads(subprocess.check_output([dotnet, 'run', '--project', str(root / 'Foxwarm.OpenAIResponses.Streaming.Parity'), '--no-restore', '--', str(root / 'responses-stream-corpus.json')], text=True, cwd=root.parent.parent))
if not (len(corpus) == len(ts) == len(cs)):
    raise SystemExit(f'count mismatch: corpus={len(corpus)} TS={len(ts)} C#={len(cs)}')

def expected(case):
    types = [event.get('type') for event in case.get('events', [])]
    if any(t in {'response.failed','response.incomplete','response.error','error'} for t in types): return 'error'
    if any(t == 'response.completed' for t in types): return 'success'
    return 'error'

def compare(case, left, right):
    if case['name'] != left['name'] or case['name'] != right['name']:
        raise AssertionError(f"name mismatch: {case['name']}")
    a, b = left['observation'], right['observation']
    if a.get('status') != b.get('status'):
        raise AssertionError(f"{case['name']}: status mismatch {a.get('status')} != {b.get('status')}")
    if a.get('status') != expected(case):
        raise AssertionError(f"{case['name']}: unexpected status {a.get('status')}")
    for field in ('meaningfulCount','safety','decodedRaw','blocks','progress'):
        if a.get(field) != b.get(field):
            raise AssertionError(f"{case['name']}: {field} mismatch\nTS={a.get(field)!r}\nC#={b.get(field)!r}")
    if a.get('status') == 'success':
        if a.get('final') != b.get('final'):
            raise AssertionError(f"{case['name']}: final semantic JSON mismatch\nTS={json.dumps(a.get('final'),indent=2)}\nC#={json.dumps(b.get('final'),indent=2)}")
        if 'final' not in a or 'final' not in b:
            raise AssertionError(f"{case['name']}: completion was not observed")
    else:
        ae, be = a.get('error',{}), b.get('error',{})
        for field in ('category','kind','message','status','code'):
            if ae.get(field) != be.get(field):
                raise AssertionError(f"{case['name']}: error {field} mismatch: {ae.get(field)!r} != {be.get(field)!r}")
    if len(a.get('progress', [])) != len(b.get('progress', [])):
        raise AssertionError(f"{case['name']}: progress event count mismatch")
    if len(a.get('blocks', [])) != len(b.get('blocks', [])):
        raise AssertionError(f"{case['name']}: SSE block count mismatch")

for case, left, right in zip(corpus, ts, cs):
    compare(case, left, right)
print(f'comparison ok: {len(corpus)} cases; semantic final/progress/raw/block/error parity exact')

if '--self-test-negative' in sys.argv:
    def must_reject(mutator, case_index=0):
        left = copy.deepcopy(ts[case_index]); right = copy.deepcopy(cs[case_index]); mutator(left, right)
        try:
            compare(corpus[case_index], left, right)
        except AssertionError:
            return
        raise AssertionError('negative comparator case was accepted')
    must_reject(lambda left, right: right['observation']['final']['output'].append({'type': 'wrong'}))
    must_reject(lambda left, right: right['observation']['progress'].pop())
    must_reject(lambda left, right: right['observation']['blocks'].pop())
    must_reject(lambda left, right: right['observation'].__setitem__('status', 'error'))
    late_index = next(i for i, case in enumerate(corpus) if case['name'] == 'completed-then-late-error')
    must_reject(lambda left, right: right['observation'].__setitem__('status', 'success'), late_index)
    print('negative comparator checks ok: wrong final/progress/block counts, unobserved completion, and late error rejected')
