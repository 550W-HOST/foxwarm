#!/usr/bin/env python3
"""Acquire the fixed official Monty 0.0.19 standalone executable for a supported target RID."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import tarfile
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('prefix', type=Path)
parser.add_argument('--rid', choices=('linux-x64', 'win-x64'), default='win-x64' if platform.system() == 'Windows' else 'linux-x64')
args = parser.parse_args()
package_name, executable = ('monty-win32-x64-msvc', 'monty.exe') if args.rid == 'win-x64' else ('monty-linux-x64-gnu', 'monty')
prefix = args.prefix.resolve()
url = f'https://registry.npmjs.org/@pydantic/{package_name}/0.0.19'
with urllib.request.urlopen(url, timeout=40) as response:
    metadata = json.load(response)
if metadata.get('version') != '0.0.19':
    raise RuntimeError('unexpected package version')
with urllib.request.urlopen(metadata['dist']['tarball'], timeout=60) as response:
    archive = response.read()
algorithm, expected = metadata['dist']['integrity'].split('-', 1)
if algorithm != 'sha512' or base64.b64encode(hashlib.sha512(archive).digest()).decode() != expected:
    raise RuntimeError('official registry package integrity does not match')
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
    for name, target in [(f'package/{executable}', prefix / 'bin' / executable), ('package/package.json', prefix / 'share/package.json')]:
        member = package.getmember(name)
        if not member.isfile():
            raise RuntimeError('unexpected package member type')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(package.extractfile(member).read())
manifest = json.loads((prefix / 'share/package.json').read_text())
if manifest['version'] != '0.0.19' or manifest['license'] != 'MIT':
    raise RuntimeError('unexpected package metadata')
os.chmod(prefix / 'bin' / executable, 0o755)
license_file = Path(__file__).resolve().parent.parent / 'Foxwarm/ToolScript/MONTY-LICENSE'
(prefix / 'share/MONTY-LICENSE').write_bytes(license_file.read_bytes())
print(json.dumps({'version': '0.0.19', 'binary': str(prefix / 'bin' / executable), 'integrityVerified': True}))
