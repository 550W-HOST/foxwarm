#!/usr/bin/env python3
"""Fetch, patch and lock-check the pinned upstream sources of the Rust libraries Foxwarm builds.

prepare SOURCE_JSON OUTPUT_DIR [--patch FILE]
    Download the archive named in SOURCE_JSON (cached beside OUTPUT_DIR), verify its SHA-256,
    unpack it into OUTPUT_DIR and apply the patch (a `git apply` patch relative to the archive root).
    Prints the Rust toolchain the build must use.
prune-lock MANIFEST
    A patch that removes dependencies or features leaves Cargo.lock with unused entries, which
    `cargo build --locked` rejects. Prune them with `cargo update --workspace` and fail unless every
    remaining package keeps the exact name, version, source and checksum of the pinned lock file.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request


def prepare(args):
    source = json.loads(Path(args.source).read_text())
    output = Path(args.output).resolve()
    cache = output.parent / ('source-' + source['sha256'][:16] + '.tar.gz')
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        archive = cache.read_bytes()
    else:
        last = None
        for _ in range(3):
            try:
                with urllib.request.urlopen(source['archive'], timeout=120) as response:
                    archive = response.read()
                break
            except OSError as error:
                last = error
        else:
            raise last
    if hashlib.sha256(archive).hexdigest() != source['sha256']:
        raise SystemExit('pinned source archive integrity does not match: ' + source['archive'])
    cache.write_bytes(archive)
    if output.exists():
        shutil.rmtree(output)
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
        members = package.getmembers()
        roots = {member.name.split('/', 1)[0] for member in members if member.name != 'pax_global_header'}
        if len(roots) != 1:
            raise SystemExit('unexpected archive layout')
        root = roots.pop() + '/'
        for member in members:
            if not member.name.startswith(root) or member.name == root:
                continue
            relative = Path(member.name[len(root):])
            if relative.is_absolute() or '..' in relative.parts:
                raise SystemExit('invalid source path: ' + member.name)
            target = output / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(package.extractfile(member).read())
                if member.mode & 0o111:
                    target.chmod(0o755)
            # Symbolic links and special files are not needed to build.
    if args.patch:
        # Apply outside any enclosing checkout so Git cannot treat these paths as product source.
        environment = dict(os.environ, GIT_CEILING_DIRECTORIES=str(output.parent))
        subprocess.run(['git', 'apply', '--whitespace=nowarn', str(Path(args.patch).resolve())],
                       cwd=output, env=environment, check=True)
    print('prepared ' + source['repository'] + ' ' + source['commit'], file=sys.stderr)
    toolchain = source.get('rust')
    if not toolchain:
        for candidate in output.rglob('rust-toolchain.toml'):
            found = re.search(r'channel\s*=\s*"([^"]+)"', candidate.read_text())
            if found:
                toolchain = found.group(1)
                break
    print(toolchain or '')


def packages(path):
    text = Path(path).read_text()
    return {(m.group(1), m.group(2), m.group(3), m.group(4)) for m in re.finditer(
        r'\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"(?:\nsource = "([^"]+)")?(?:\nchecksum = "([^"]+)")?', text)}


def prune_lock(args):
    manifest = Path(args.manifest).resolve()
    lock = manifest.parent / 'Cargo.lock'
    pinned = lock.read_bytes()
    before = packages(lock)
    subprocess.run(['cargo', 'update', '--workspace', '--manifest-path', str(manifest)], check=True)
    after = packages(lock)
    if not after <= before:
        lock.write_bytes(pinned)
        raise SystemExit('Cargo.lock changed beyond pruning: %s' % sorted(after - before)[:5])
    print('Cargo.lock pruned from %d to %d packages; no version changed' % (len(before), len(after)))


parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
commands = parser.add_subparsers(dest='command', required=True)
p = commands.add_parser('prepare')
p.add_argument('source')
p.add_argument('output')
p.add_argument('--patch')
p.set_defaults(run=prepare)
p = commands.add_parser('prune-lock')
p.add_argument('manifest')
p.set_defaults(run=prune_lock)
arguments = parser.parse_args()
arguments.run(arguments)
