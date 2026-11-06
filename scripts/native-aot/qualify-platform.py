#!/usr/bin/env python3
"""Qualify an extracted native package using temporary certificates on a hosted runner."""
import argparse
import os
from pathlib import Path
import platform
import signal
import sys
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def run(*args, capture=True, timeout=15, **kwargs):
    # Bound setup and teardown too: a failed probe must not wait on OS trust UI.
    process = subprocess.Popen(args, stdout=subprocess.PIPE if capture else None,
                               text=True, start_new_session=os.name != "nt", **kwargs)
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], timeout=10, check=False)
        else:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)
        raise
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, args, output)
    return (output or "").strip()


def powershell(command):
    return run("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command)


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    args = parser.parse_args()
    windows = platform.system() == "Windows"
    if not windows and platform.system() != "Darwin":
        parser.error("Run this qualification on Windows or macOS")
    executable = args.package.resolve() / ("Foxwarm.CliNode.exe" if windows else "Foxwarm.CliNode")
    if not executable.is_file():
        parser.error(f"Missing packaged executable: {executable}")
    with tempfile.TemporaryDirectory(prefix="fw-native-tls-") as temporary:
        directory = Path(temporary)
        config = directory / "openssl.cnf"
        # A localhost URL must fail hostname validation; only the IP is in SAN.
        config.write_text("[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=Foxwarm native qualification\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\n", encoding="utf-8")
        for name in ("trusted", "untrusted"):
            run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", str(config), "-keyout", str(directory / (name + ".key")), "-out", str(directory / (name + ".pem")), capture=False)
        certificate = directory / "trusted.pem"
        thumbprint = run("openssl", "x509", "-in", str(certificate), "-noout", "-fingerprint", "-sha1").split("=")[-1].replace(":", "")
        try:
            if windows:
                # CurrentUser root import requires interactive consent. Hosted Windows
                # runners are elevated; use their disposable machine trust store.
                powershell(f"$ErrorActionPreference='Stop'; Import-Certificate -FilePath {quote(certificate)} -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null")
            else:
                run("sudo", "-n", "security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", str(certificate), capture=False)
            env = dict(os.environ, FOXWARM_CLI_EXECUTABLE=str(executable), FOXWARM_TEST_TLS_CERT=str(certificate), FOXWARM_TEST_TLS_KEY=str(directory / "trusted.key"), FOXWARM_TEST_UNTRUSTED_CERT=str(directory / "untrusted.pem"), FOXWARM_TEST_UNTRUSTED_KEY=str(directory / "untrusted.key"))
            # The native process must not depend on a runner-selected browser or CLR.
            for key in ("PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH", "DOTNET_ROOT", "DOTNET_HOST_PATH"):
                env.pop(key, None)
            run("node", "packages/webui/test/dotnetCliNodeAot.e2e.mjs", cwd=ROOT, env=env, capture=False, timeout=180)
        finally:
            if windows:
                powershell(f"$ErrorActionPreference='Stop'; $path='Cert:\\LocalMachine\\Root\\{thumbprint}'; if (Test-Path -LiteralPath $path) {{ Remove-Item -LiteralPath $path }}; exit 0")
            else:
                # remove-trusted-cert can block on hosted macOS. Delete only this
                # run's certificate by identity; the disposable runner owns any
                # residual trust-settings metadata and is discarded after the job.
                print("Removing temporary certificate from the system keychain", file=sys.stderr, flush=True)
                run("sudo", "-n", "security", "delete-certificate", "-Z", thumbprint,
                    "/Library/Keychains/System.keychain", capture=False, timeout=10)


if __name__ == "__main__":
    main()
