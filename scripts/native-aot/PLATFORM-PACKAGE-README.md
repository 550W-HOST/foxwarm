# Foxwarm standalone native CLI Node — Windows x64 / macOS arm64

Extract the package for your operating system into a stable owned directory.
`Foxwarm.CliNode.exe` (Windows) or `Foxwarm.CliNode` (macOS) includes the reachable
.NET application code. No .NET runtime or Node.js is needed. This package is the
CLI Node, not Main or a service installer.

Windows uses the system Windows PowerShell and ConPTY. macOS uses Bash, ordinary
shell utilities and the adjacent `libfoxwarm-pty.dylib` and `foxwarm-pty-helper`;
keep these files together. TLS uses the operating system's trusted certificates.
Writable owned state and temporary directories are required. Git and Chromium
are optional external installations, not bundled dependencies. Set
`PUPPETEER_EXECUTABLE_PATH` or `CHROME_PATH` for browser tools; the CLI never
downloads a browser.

Run from the desired working directory:

```powershell
& 'C:\path\native-cli-node-win-x64\Foxwarm.CliNode.exe' --host https://example.invalid/foxwarm --id my-node --token '<pairing-token>' --credentials-file 'C:\path\state\node-credentials.json'
```

```sh
/path/to/native-cli-node-osx-arm64/Foxwarm.CliNode \
  --host https://example.invalid/foxwarm --id my-node --token '<pairing-token>' \
  --credentials-file /path/to/state/node-credentials.json
```

After approval, starts can use saved credentials. `--auth-token` with `--id`
selects direct authentication; `--interactive` enables operator approval.
Keep the executable at the same path while detached commands or Code/trigger
helpers can re-enter it. Agent roots can be selected with `FOXWARM_AGENTS_DIR`.

`BUILD-INFO.json` identifies the source, target and protocol channel;
`BUILD-INPUTS.txt` identifies actual build inputs. The `latest-v3` archive name
selects a Node protocol channel, not a product version. Keep `LICENSE` and the
complete `notices/` directory when redistributing. Embedded dependency updates
require rebuilding the executable. Qualification applies to the measured runner
OS, not every historical Windows or macOS release. These packages are not signed
or notarized by this build lane; apply your organization's normal trust policy.
