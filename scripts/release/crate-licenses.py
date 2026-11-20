#!/usr/bin/env python3
"""Write the third-party licence file for a Rust binary Foxwarm builds.

Usage: crate-licenses.py MANIFEST PACKAGE TARGET_TRIPLE OUTPUT TITLE
Lists the crates that are linked into PACKAGE on TARGET_TRIPLE (the transitive closure of its
normal, non-build, non-dev dependencies under the build's feature selection) with version, SPDX
licence expression and repository, followed by every distinct licence or notice file found in
those crates, each printed once with the crates that carry it. Run after the sources are fetched
(`cargo fetch` or a build), so every crate directory exists.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

manifest, package, triple, output, title = sys.argv[1:6]
metadata = json.loads(subprocess.run(
    ['cargo', 'metadata', '--format-version', '1', '--filter-platform', triple, '--manifest-path', manifest],
    check=True, capture_output=True, encoding='utf-8').stdout)
packages = {p['id']: p for p in metadata['packages']}
nodes = {n['id']: n for n in metadata['resolve']['nodes']}
roots = [p['id'] for p in metadata['packages'] if p['name'] == package and p['id'] in metadata['workspace_members']]
if len(roots) != 1:
    raise SystemExit('expected one workspace package named ' + package)
seen, stack = set(), [roots[0]]
while stack:
    current = stack.pop()
    if current in seen:
        continue
    seen.add(current)
    for dep in nodes[current]['deps']:
        if any(kind['kind'] is None for kind in dep['dep_kinds']):
            stack.append(dep['pkg'])
crates = sorted((packages[i] for i in seen if i != roots[0]), key=lambda p: (p['name'], p['version']))
names = ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'UNLICENSE', 'PATENTS')
texts = {}
rows = []
for crate in crates:
    directory = Path(crate['manifest_path']).parent
    files = sorted(f for f in directory.iterdir() if f.is_file() and f.name.upper().startswith(names)) \
        if directory.is_dir() else []
    if not files and crate.get('source') is None:
        # A workspace member keeps its licence at the workspace root.
        root = Path(metadata['workspace_root'])
        files = sorted(f for f in root.iterdir() if f.is_file() and f.name.upper().startswith(names))
    for f in files:
        data = f.read_bytes().decode('utf-8', 'replace').replace('\r\n', '\n').strip()
        digest = hashlib.sha256(data.encode()).hexdigest()
        texts.setdefault(digest, [data, set()])[1].add(f"{crate['name']} {crate['version']}")
    rows.append((crate, [f.name for f in files]))
lines = [title, '=' * len(title), '',
         'This file lists the Rust crates linked into the shipped binary, with their declared licences,',
         'followed by the licence and notice texts those crates distribute. A crate may be offered',
         'under several licences (OR); the declared expression is shown as published by the crate.', '',
         '%d crates' % len(crates), '']
for crate, files in rows:
    lines.append(f"{crate['name']} {crate['version']}  [{crate.get('license') or 'see licence files'}]"
                 + (f"  {crate['repository']}" if crate.get('repository') else '')
                 + ('' if files else '  (no licence file in the crate)'))
lines += ['', '']
for digest, (data, owners) in sorted(texts.items(), key=lambda item: sorted(item[1][1])[0]):
    lines += ['-' * 78, 'Licence or notice text used by:', *('  ' + o for o in sorted(owners)), '', data, '']
Path(output).write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('%s: %d crates, %d distinct texts, %d bytes' % (output, len(crates), len(texts), Path(output).stat().st_size))
