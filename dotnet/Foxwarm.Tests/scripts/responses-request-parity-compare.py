#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

from parity_compare import strict_equal

root = Path(__file__).resolve().parent
corpus = root.parent / 'Fixtures' / 'responses-request-corpus.json'
dotnet = sys.argv[1] if len(sys.argv) > 1 else 'dotnet'

def run_json(cmd, *, cwd=None, env=None):
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=5)
        raise SystemExit(f'subprocess timed out and was killed: {cmd[0]}')
    if proc.returncode != 0:
        sys.stderr.write(stderr)
        sys.stderr.write(stdout)
        raise SystemExit(f'subprocess exited with {proc.returncode}: {cmd[0]}')
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as error:
        sys.stderr.write(stderr)
        raise SystemExit(f'subprocess emitted non-JSON stdout: {cmd[0]}: {error}')

env = os.environ.copy()
env['FOXWARM_NO_CONSOLE_LOG'] = '1'
env['FOXWARM_SYNC_FILE_LOG'] = '1'
with tempfile.TemporaryDirectory(prefix='foxwarm-responses-request-oracle-') as data_dir:
    env['FOXWARM_DATA_DIR'] = data_dir
    ts = run_json(
        ['node', str(root.parent / 'Fixtures' / 'responses-request-parity-ts.mjs'), str(corpus)],
        env=env,
    )
cs = run_json(
    [dotnet, 'run', '--project', str(root.parents[1] / 'Foxwarm.DevTools'), '--no-build', '--no-restore', '--', 'responses-request', str(corpus)],
    cwd=root.parents[2],
)
if len(ts) != len(cs):
    raise SystemExit(f'count mismatch: TS={len(ts)} C#={len(cs)}')
for left, right in zip(ts, cs):
    if set(left) != {'name', 'input'} or set(right) != {'name', 'input'}:
        raise SystemExit(f'observation key mismatch: TS={set(left)} C#={set(right)}')
    if left['name'] != right['name']:
        raise SystemExit(f'name mismatch: {left["name"]!r} != {right["name"]!r}')
    if not strict_equal(left['input'], right['input']):
        raise SystemExit(f'{left["name"]}: request input mismatch\nTS={left["input"]!r}\nC#={right["input"]!r}')
print(f'comparison ok: {len(ts)} actual TypeScript/C# Responses request-input cases')
