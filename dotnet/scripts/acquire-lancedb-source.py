#!/usr/bin/env python3
"""Acquire the pinned LanceDB managed source and apply Foxwarm's JSON metadata patch."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('prefix', type=Path)
args = parser.parse_args()
prefix = args.prefix.resolve()
project = Path(__file__).resolve().parent.parent / 'Foxwarm.LanceDb'
source = json.loads((project / 'source.json').read_text())
cache = prefix.parent / ('lancedb-' + source['commit'] + '.tar.gz')
cache.parent.mkdir(parents=True, exist_ok=True)
if cache.exists():
    archive = cache.read_bytes()
else:
    with urllib.request.urlopen(source['archive'], timeout=60) as response:
        archive = response.read()
if hashlib.sha256(archive).hexdigest() != source['sha256']:
    raise RuntimeError('pinned LanceDB source archive integrity does not match')
if not cache.exists():
    cache.write_bytes(archive)
with tempfile.TemporaryDirectory(prefix='foxwarm-lancedb-') as temporary:
    stage = Path(temporary)
    archive_root = 'lancedb-csharp-' + source['commit'] + '/'
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
        for member in package.getmembers():
            if not member.name.startswith(archive_root):
                continue
            relative = Path(member.name[len(archive_root):])
            if relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('invalid LanceDB source path')
            if relative != Path('LICENSE') and not (
                relative.parts and relative.parts[0] == 'src' and relative.suffix == '.cs'
            ):
                continue
            if not member.isfile():
                raise RuntimeError('unexpected LanceDB source member type')
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(package.extractfile(member).read())
    # Apply outside the checkout so Git cannot treat these paths as product source.
    environment = dict(os.environ, GIT_CEILING_DIRECTORIES=str(stage.parent))
    subprocess.run(['git', 'apply', str(project / 'serialization.patch')], cwd=stage,
                   env=environment, check=True)
    if prefix.exists():
        shutil.rmtree(prefix)
    shutil.copytree(stage, prefix)
    (prefix / 'prepared').write_text(source['commit'] + '\n')
print('Prepared LanceDB ' + source['version'] + ' managed source with explicit JSON metadata.')
