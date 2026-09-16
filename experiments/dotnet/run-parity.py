#!/usr/bin/env python3
import json, subprocess, sys
from pathlib import Path

root = Path(__file__).parent
corpus_path = root / 'parity-corpus.json'
corpus = json.loads(corpus_path.read_text())
ts = json.loads(subprocess.check_output([sys.executable, str(root / 'run-ts-parity.py')], text=True))
cs = json.loads(subprocess.check_output([sys.argv[1] if len(sys.argv) > 1 else 'dotnet', 'run', '--project', str(root / 'Foxwarm.ConditionalMemory.Parity'), '--no-restore', '--', str(corpus_path)], text=True, cwd=root.parent.parent))

def strict_equal(a, b):
    if isinstance(a, (int, float)) and not isinstance(a, bool) and isinstance(b, (int, float)) and not isinstance(b, bool): return a == b
    if type(a) is not type(b): return False
    if isinstance(a, dict): return a.keys() == b.keys() and all(strict_equal(a[k], b[k]) for k in a)
    if isinstance(a, list): return len(a) == len(b) and all(strict_equal(x, y) for x, y in zip(a, b))
    return a == b

def check(i, case, left, right):
    op = case['op']
    if right.get('kind') == 'unsupported':
        if op == 'argsParse' and not isinstance(case.get('rawInput'), (str, dict)):
            return 'unsupported-input'
        raise SystemExit(f'unexpected unsupported at {i}: {case["name"]}: {right}')
    if left.get('kind') != right.get('kind'):
        raise SystemExit(f'kind mismatch at {i}: {case["name"]}: TS={left!r} C#={right!r}')
    if op == 'argsStringify':
        raw = case.get('rawArgsText')
        if raw is not None:
            if left['value'] != raw or right['value'] != raw: raise SystemExit(f'raw args mismatch at {i}: {case["name"]}')
        else:
            if not strict_equal(json.loads(left['value']), json.loads(right['value'])): raise SystemExit(f'generated args semantic mismatch at {i}: {case["name"]}: TS={left!r} C#={right!r}')
        return 'matched'
    if op == 'argsParse' and isinstance(left.get('value'), dict) and 'argsParseError' in left['value']:
        a, b = left['value'], right['value']
        if not strict_equal(a.get('args'), b.get('args')) or a.get('rawArgsText') != b.get('rawArgsText'):
            raise SystemExit(f'parse payload mismatch at {i}: {case["name"]}: TS={a!r} C#={b!r}')
        if not isinstance(b.get('argsParseError'), str) or not b['argsParseError'].startswith('Invalid tool arguments JSON:') or not b['argsParseError']:
            raise SystemExit(f'native diagnostic invalid at {i}: {case["name"]}: {b!r}')
        return 'diagnostic-compatible'
    if not strict_equal(left, right): raise SystemExit(f'value mismatch at {i}: {case["name"]}: TS={left!r} C#={right!r}')
    return 'matched'

counts = {'matched': 0, 'diagnostic-compatible': 0, 'unsupported-input': 0}
for i, (case, left, right) in enumerate(zip(corpus, ts, cs)):
    counts[check(i, case, left, right)] += 1
print(f'comparison ok: {len(corpus)} cases; exact={counts["matched"]}, diagnostic-compatible={counts["diagnostic-compatible"]}, explicit-unsupported={counts["unsupported-input"]}')
