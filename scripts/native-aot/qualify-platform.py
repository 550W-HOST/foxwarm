#!/usr/bin/env python3
"""Qualify an extracted native package using temporary certificates on a hosted runner."""
import argparse
import os
from pathlib import Path
import platform
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


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
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", str(config), "-keyout", str(directory / (name + ".key")), "-out", str(directory / (name + ".pem"))], check=True)
        certificate = directory / "trusted.pem"
        thumbprint = run("openssl", "x509", "-in", str(certificate), "-noout", "-fingerprint", "-sha1").split("=")[-1].replace(":", "")
        try:
            if windows:
                powershell(f"$ErrorActionPreference='Stop'; Import-Certificate -FilePath {quote(certificate)} -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null")
            else:
                subprocess.run(["sudo", "security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", str(certificate)], check=True)
            env = dict(os.environ, FOXWARM_CLI_EXECUTABLE=str(executable), FOXWARM_TEST_TLS_CERT=str(certificate), FOXWARM_TEST_TLS_KEY=str(directory / "trusted.key"), FOXWARM_TEST_UNTRUSTED_CERT=str(directory / "untrusted.pem"), FOXWARM_TEST_UNTRUSTED_KEY=str(directory / "untrusted.key"))
            # The native process must not depend on a runner-selected browser or CLR.
            for key in ("PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH", "DOTNET_ROOT", "DOTNET_HOST_PATH"):
                env.pop(key, None)
            subprocess.run(["node", "packages/webui/test/dotnetCliNodeAot.e2e.mjs"], cwd=ROOT, env=env, check=True)
        finally:
            if windows:
                powershell(f"Remove-Item -LiteralPath 'Cert:\\CurrentUser\\Root\\{thumbprint}' -ErrorAction SilentlyContinue")
            else:
                subprocess.run(["sudo", "security", "remove-trusted-cert", "-d", str(certificate)], check=False)
                subprocess.run(["sudo", "security", "delete-certificate", "-Z", thumbprint, "/Library/Keychains/System.keychain"], check=False)


if __name__ == "__main__":
    main()
