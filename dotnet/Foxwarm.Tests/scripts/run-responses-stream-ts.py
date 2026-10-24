#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parent
env = os.environ.copy()
env['FOXWARM_NO_CONSOLE_LOG'] = '1'
env['FOXWARM_SYNC_FILE_LOG'] = '1'
with tempfile.TemporaryDirectory(prefix='foxwarm-responses-oracle-') as data_dir:
    env['FOXWARM_DATA_DIR'] = data_dir
    tsx = env.get('FOXWARM_TSX')
    cmd = [tsx, str(root.parent / 'Fixtures' / 'responses-stream-parity-ts.ts')] if tsx else ['npx', '--yes', 'tsx@4.19.2', str(root.parent / 'Fixtures' / 'responses-stream-parity-ts.ts')]
    proc = subprocess.Popen(cmd, cwd=root.parents[2], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = proc.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=5)
        raise SystemExit('TypeScript Responses oracle timed out and was killed')
    if proc.returncode != 0:
        sys.stderr.write(stderr)
        sys.stderr.write(stdout)
        raise SystemExit(f'TypeScript Responses oracle exited with {proc.returncode}')
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError as error:
        sys.stderr.write(stderr)
        raise SystemExit(f'TypeScript Responses oracle emitted non-JSON stdout: {error}')
print(json.dumps(result, separators=(',', ':')))
