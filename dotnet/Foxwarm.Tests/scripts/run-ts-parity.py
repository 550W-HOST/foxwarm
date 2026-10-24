#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path

root = Path(__file__).resolve().parent
tsx = os.environ.get('FOXWARM_TSX', 'npx')
if tsx == 'npx':
    command = ['npx', '--yes', 'tsx@4.19.2', str(root.parent / 'Fixtures' / 'parity-ts.ts')]
else:
    command = [tsx, str(root.parent / 'Fixtures' / 'parity-ts.ts')]
print(subprocess.check_output(command, text=True), end='')
