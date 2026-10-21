# Foxwarm standalone native CLI Node — Linux x64

This package is for Linux x86-64 only. `Foxwarm.CliNode` includes the .NET code,
static musl, ICU/full culture data, OpenSSL and the Linux PTY implementation.
It does not need Node.js, the .NET SDK/runtime or adjacent PTY shared libraries.
It is not Main, a service installer or an automatic updater.

## Prerequisites

- Bash, `/bin/sh` and normal shell utilities for exec and trigger helpers.
- Appropriate CA trust data for HTTPS/WSS, and OS timezone data when needed.
- Writable owned state and temporary directories. Linux procfs is used for
  process/cwd inspection; descriptor closure needs usable `close_range` or its
  procfs fallback. PTY requires `pidfd_open` and `pidfd_send_signal` support
  (upstream Linux 5.3 or suitable vendor backports).
- Optional Git for Code Git operations; optional installed Chromium and its
  own OS dependencies for browser tools. Use `PUPPETEER_EXECUTABLE_PATH` or
  `CHROME_PATH` to select Chromium. No browser is bundled or downloaded.

Static linkage is not a minimum-kernel or CPU-floor qualification. The bounded
source qualification used Alpine 3.23, UBI 8 and Debian 13 userspaces on a modern
shared Linux kernel. It does not establish Windows, macOS, ARM or arbitrary
browser-action support. Optional programs keep their own system dependencies.

## Run

Extract to a stable owned installation directory. From your desired working
directory, use the executable's absolute path:

```sh
/path/to/native-cli-node-linux-x64/Foxwarm.CliNode \
  --host https://example.invalid/foxwarm --id my-node --token '<pairing-token>' \
  --credentials-file /path/to/owned-state/node-credentials.json
```

After approval, starts can use the saved credentials. `--auth-token` plus `--id`
selects direct authentication. `--interactive` enables the operator interface;
`--help` describes its approval options. The default is headless.

Keep the executable at that stable path while detached commands or Code/trigger
helpers can still re-enter it. Select writable state and Agent roots explicitly
when needed (`FOXWARM_AGENT_DIR` or `FOXWARM_AGENTS_DIR`); the process working
directory also controls default command behavior. Existing generated installers
and onboarding commands still select the TypeScript client, not this package.

## Identity and maintenance

`BUILD-INFO.json` records source/build identity and protocol range;
`BUILD-INPUTS.txt` records actual builder/toolchain/package inputs. The initial
`native-cli-node-latest-v3.tar.gz` filename is a mutable **Node protocol v3**
channel for this Linux x64 package, not a product version or cross-platform
installer. The client currently negotiates protocols 1–3, but no v1/v2 download
aliases are published by this lane.

Keep `LICENSE` and the complete `notices/` directory with redistributed copies.
Embedded-library security fixes require a rebuilt executable; updating runtime
shared libraries does not update it. Source: `https://github.com/550W-HOST/foxwarm`.
