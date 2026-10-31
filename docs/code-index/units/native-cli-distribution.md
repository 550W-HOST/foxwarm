# Unit: native CLI distribution

Files: `scripts/native-aot/collect-notices.sh`, `scripts/native-aot/package-cli.py`, `scripts/native-aot/downloads.wrangler.json`, `scripts/native-aot/tests/test_package.py`, `scripts/native-aot/PACKAGE-README.md`, `scripts/native-aot/NOTICE.md`, `.github/workflows/native-cli-node.yml`
Secondary/integration references: `scripts/native-aot/cli-linux-musl-x64.Dockerfile`, `scripts/native-aot/README.md`, `packages/webui/test/dotnetCliNodeAotLinux.e2e.mjs`

## Distribution contract

The full Linux x64 static-musl CLI is distributed at `https://foxwarm.net/downloads/native-cli-node-latest-v3.tar.gz`. The suffix denotes the Node protocol compatibility channel, not the application version. This initial package offers protocols 1–3 and creates only the v3 alias. No Windows, ARM or Main AOT package is implied. A compatible build can replace its channel; older channels must remain available when new protocols are introduced. Before native-default rollout, the replacement package must also qualify current supported client behavior, including logical POSIX cwd and external exec result guidance. A shared protocol number alone does not establish that an older binary contains later client fixes.

The [native build unit](./dotnet-cli-linux-aot.md) owns compiler inputs, execution qualification and remaining OS dependencies. The Dockerfile's separate `distribution` target collects the complete executable, builder inventory and required dependency notices without changing the qualified compiler invocation. `package-cli.py` selects named release files rather than raw publish output, adds source/build provenance and license/prerequisite documentation, and rejects the complete archive above 26,214,400 bytes. Debug output, state, SDK/Main, Node, Git and browsers are excluded. Missing notices fail packaging; collected files alone do not establish licensing clearance for a new build.

## Website and publication boundaries

An independent assets-only `foxwarm-native-downloads` Worker owns `foxwarm.net/downloads/*`; GitHub Pages remains the documentation origin. Missing downloads return 404 without HTML fallback. Its asset directory is outside website output, so documentation deployment cannot replace the downloads manifest. There is no Worker script, R2, download proxy, runtime compiler, cache or upgrade service. Domain, DNS, Pages and redirect administration are external prerequisites; committing these files does not perform a cutover.

The workflow builds on public `main` or manual dispatch, packages once, extracts that archive and runs the existing isolated no-CLR TLS/files/exec/recovery/PTY/Code/browser probe against its executable. The build requires no publication credentials. Deployment is restricted to `main` and the opt-in `NATIVE_CLI_PUBLISH` repository variable, with externally configured protected-environment approval, account/token and exact Wrangler version. No GitHub Release is created.

A deployment replaces the complete assets manifest. Before publishing a new protocol channel, include retained channels as explicit approved release inputs; the present initial-channel workflow must not be used to discard them. It does not scrape earlier live downloads to reconstruct release inputs. CI artifact retention is not permanent release storage.

## Validation

`python3 scripts/native-aot/tests/test_package.py` checks an owned synthetic package's paths, modes, provenance, complete-archive size gate, required notices and independent route. It does not qualify a real executable. The workflow and native README map actual final-archive qualification. The supplied initial release was separately qualified; subsequent builds require their own complete-package and execution evidence.
