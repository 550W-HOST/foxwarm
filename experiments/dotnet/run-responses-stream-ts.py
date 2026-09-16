#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).parent
env = os.environ.copy()
env['FOXWARM_NO_CONSOLE_LOG'] = '1'
cmd = [env.get('FOXWARM_TSX', 'npx'), str(root / 'responses-stream-parity-ts.ts')]
if env.get('FOXWARM_TSX') is None:
    cmd = ['npx', '--yes', 'tsx@4.19.2', str(root / 'responses-stream-parity-ts.ts')]
with tempfile.TemporaryDirectory() as directory:
    stdout_path, stderr_path = Path(directory) / 'stdout', Path(directory) / 'stderr'
    with stdout_path.open('w+') as stdout, stderr_path.open('w+') as stderr:
        proc = subprocess.Popen(cmd, cwd=root.parent.parent, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
        stdout.flush(); stderr.flush()
    raw = stdout_path.read_text()
    errors = stderr_path.read_text()
try:
    value, _ = json.JSONDecoder().raw_decode(raw.lstrip())
except json.JSONDecodeError:
    sys.stderr.write(errors)
    sys.stderr.write(raw)
    raise
print(json.dumps(value, separators=(',', ':')))
if proc.returncode not in (0, -9):
    sys.stderr.write(errors)
    raise SystemExit(proc.returncode)
