#!/usr/bin/env python3
import json, subprocess, sys
from pathlib import Path

root = Path(__file__).parent
corpus = root / 'parity-corpus.json'
ts_cmd = [sys.executable, str(root / 'run-ts-parity.py')]
cs_cmd = [sys.argv[1] if len(sys.argv) > 1 else 'dotnet', 'run', '--project', str(root / 'Foxwarm.ConditionalMemory.Parity'), '--no-restore', '--', str(corpus)]
ts = json.loads(subprocess.check_output(ts_cmd, text=True))
cs = json.loads(subprocess.check_output(cs_cmd, text=True, cwd=root.parent.parent))
if len(ts) != len(cs): raise SystemExit(f'count mismatch: TS={len(ts)} C#={len(cs)}')
for i, (a, b) in enumerate(zip(ts, cs)):
    if a != b:
        raise SystemExit(f'mismatch at corpus index {i}: TS={a!r} C#={b!r}')
print(f'parity ok: {len(ts)} corpus cases; undefined represented explicitly')
