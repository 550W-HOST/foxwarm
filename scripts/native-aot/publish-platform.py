#!/usr/bin/env python3
"""Publish the CLI-only native graph on its target Windows/macOS host."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SDK = "10.0.403"
RUNTIME = "10.0.14"


def run(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.STDOUT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=["win-x64", "osx-arm64"])
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    expected = ("Windows", "AMD64") if args.target == "win-x64" else ("Darwin", "arm64")
    if (platform.system(), platform.machine()) != expected:
        parser.error(f"Publish {args.target} on its native host: expected {expected}")
    args.output = args.output.resolve()
    # SDK resolution starts at the invocation cwd, not at the supplied project.
    # Keep this pin job-local; installing an SDK alone does not select it when
    # hosted runners already carry a newer one.
    with tempfile.TemporaryDirectory(prefix="fw-native-sdk-") as temporary:
        sdk_directory = Path(temporary)
        (sdk_directory / "global.json").write_text(json.dumps({
            "sdk": {"version": SDK, "rollForward": "disable", "allowPrerelease": False}
        }), encoding="utf-8")
        if run("dotnet", "--version", cwd=sdk_directory).strip() != SDK:
            parser.error(f"Use SDK {SDK}")
        publish(args, sdk_directory)


def publish(args, sdk_directory):
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    # Keep all trim/AOT diagnostics visible; do not trim features to obtain an artifact.
    subprocess.run([
        "dotnet", "publish", str(ROOT / "dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj"),
        "-c", "Release", "-r", args.target, "-p:PublishAot=true",
        f"-p:RuntimeFrameworkVersion={RUNTIME}", "-o", str(output),
    ], cwd=sdk_directory, check=True)
    nuget = Path(os.environ.get("NUGET_PACKAGES", str(Path.home() / ".nuget/packages")))
    notices = output / "notices"
    notices.mkdir(exist_ok=True)
    sources = []
    for package, prefix in [
        (f"microsoft.netcore.app.runtime.nativeaot.{args.target}", "dotnet"),
        (f"microsoft.aspnetcore.app.runtime.{args.target}", "aspnetcore"),
    ]:
        folder = nuget / package / RUNTIME
        files = {p.name.lower(): p for p in folder.iterdir()}
        for source, suffix in [("license.txt", "LICENSE"), ("third-party-notices.txt", "NOTICES")]:
            shutil.copyfile(files[source], notices / f"{prefix}-{suffix}.txt")
            sources.append(f"{prefix}-{suffix}.txt NuGet {package}/{RUNTIME}/{files[source].name}")
    # These pins match the resolved managed dependencies and the Linux collector.
    for name, repository, commit in [
        ("PuppeteerSharp", "hardkoded/puppeteer-sharp", "7ee221b6b9b4286ccc400bbc2537e4ec9a315dcd"),
        ("ReactiveExtensionsSharp", "hardkoded/ReactiveExtensions-Sharp", "787712268f4bedf5945d43082d450042be275bce"),
        ("RecyclableMemoryStream", "microsoft/Microsoft.IO.RecyclableMemoryStream", "e29a28387da9018fa9605a1dcb3f7a0435aa9974"),
    ]:
        url = f"https://raw.githubusercontent.com/{repository}/{commit}/LICENSE"
        data = urllib.request.urlopen(url, timeout=60).read()
        if not data:
            raise ValueError(f"Empty license: {url}")
        (notices / f"{name}-LICENSE.txt").write_bytes(data)
        sources.append(f"{name}-LICENSE.txt {url}")
    (notices / "SOURCES.txt").write_text("\n".join(sources) + "\n", encoding="utf-8")
    inventory = [platform.platform(), run("dotnet", "--info", cwd=sdk_directory), run("dotnet", "list", str(ROOT / "dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj"), "package", "--include-transitive", cwd=sdk_directory)]
    if args.target == "osx-arm64":
        inventory.append(run("clang", "--version"))
        for name in ["Foxwarm.CliNode", "libfoxwarm-pty.dylib", "foxwarm-pty-helper"]:
            file = output / name
            inventory.append(run("file", str(file)))
            libraries = run("otool", "-L", str(file))
            inventory.append(libraries)
            if "/opt/homebrew/" in libraries or "/usr/local/" in libraries:
                raise ValueError(f"Build-machine dependency in {name}: {libraries}")
    else:
        inventory.append(run("powershell.exe", "-NoProfile", "-Command", "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber | ConvertTo-Json"))
    (output / "BUILD-INPUTS.txt").write_text("\n".join(inventory), encoding="utf-8")


if __name__ == "__main__":
    main()
