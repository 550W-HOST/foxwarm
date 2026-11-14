#!/usr/bin/env python3
"""Install the pinned protoc release for the build host (Windows x64 or macOS arm64) and print its path.

The Linux build image installs the same version itself (rust-native-linux.Dockerfile). Lance's
build scripts need protoc to compile their protocol buffer definitions.
Usage: install-protoc.py DIRECTORY
"""
import hashlib
from pathlib import Path
import platform
import sys
import urllib.request
import zipfile

VERSION = '36.2'
RELEASES = {
    ('Windows', 'win64'): 'f0c128dc0d8492eceece83bb459a4c0e316764b929ffbf1aa416357fd644edd3',
    ('Darwin', 'osx-aarch_64'): '9cd98a532c5c5e0c4161314de0225de27e4c8a323917b6ea7b1b714d3ae23466',
}
system = platform.system()
name = {'Windows': 'win64', 'Darwin': 'osx-aarch_64'}.get(system)
if (system, name) not in RELEASES:
    sys.exit('No pinned protoc for ' + system)
url = f'https://github.com/protocolbuffers/protobuf/releases/download/v{VERSION}/protoc-{VERSION}-{name}.zip'
for attempt in range(3):
    try:
        with urllib.request.urlopen(url, timeout=120) as response:
            data = response.read()
        break
    except OSError:
        if attempt == 2:
            raise
if hashlib.sha256(data).hexdigest() != RELEASES[(system, name)]:
    sys.exit('protoc archive integrity does not match')
target = Path(sys.argv[1]).resolve()
target.mkdir(parents=True, exist_ok=True)
archive = target / 'protoc.zip'
archive.write_bytes(data)
with zipfile.ZipFile(archive) as package:
    package.extractall(target)
archive.unlink()
executable = target / 'bin' / ('protoc.exe' if system == 'Windows' else 'protoc')
executable.chmod(0o755)
print(executable)
