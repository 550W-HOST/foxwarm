# Unit: Session upgrade inspection

Files: `dotnet/Foxwarm/Sessions/Storage/SessionUpgradeInspection.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Inspection.cs`

Integration: [source output selection](./source-main-entry.md), [authority readers and diagnostics](./session-authority-json.md), [catalog migration](./session-catalog-schema.md), [Archive identity](./archive-identity-and-moves.md).

## Goal and supported path

The approved upgrade goal is to inspect all catalog-bound Session authorities before selecting a replacement runtime, while ordinary startup remains demand-loaded. `scripts/build-source.js` runs the staged Core's internal `--inspect-upgrade` entry immediately before moving/selecting that output. Ordinary complete/backend-only builds and explicit `--promote` share this boundary; stage-only builds defer it until promotion. Source installers and restart controls reach it through those existing build commands. A blocking result leaves the previously selected payload and candidate staging in place. It does not restart the previous process after a restart control has already stopped it.

This is a one-shot read path, not Main startup or a general migration service. Direct `dotnet build` and published-payload deployment do not select source `runtime/current` and are not implicitly routed through this source-promotion command.

## Selection policy

The following implementation policy applies the approved local-failure isolation and data-retention goals:

- A Session-local unreadable/missing/malformed authority is a warning. Report each failure and the total inspected membership; selection may continue, and normal admission keeps that Session unavailable.
- Catalog, supported Archive-schema/startup-evidence and committed-identity inconsistencies block selection. A conflicting authority `id` is an identity failure, not a skippable field error.
- Retained Worker ownership in `candidate`, `ready` or `draining` blocks selection. This uses the Source lifecycle fence, not inferred process liveness or a new lease system.
- A valid nonzero historical cursor is counted and preserved. Inactive legacy mailbox records beyond the authority cursor, missing acknowledgement, or unavailable cursor evidence are reported with Session, mailbox ID, creation time and recognized kind. They are warnings; records are neither cleared nor replayed. Unknown kind values and payload bodies are not printed.

Inspection does not certify an arbitrary deployment or replace normal startup's authoritative checks. It examines every supported catalog member and retained Worker/mailbox metadata, plus the shared global evidence/schema/identity readers; it does not replay all historical Archive records or run pending migrations.

## Read-only contract

`HostPaths` and normal configuration capture select the installation/data/Agent roots. `SessionCatalog.ReadForInspection` reads existing schema versions 1–3 or the normal ordered legacy catalog candidates without initializing a database. Projection/candidate parsing is shared with migration. Missing membership is never reconstructed from orphan authority files.

`SessionAuthorityReader` is the same normalization, context overlay and validation boundary used by normal admission; later read-compatibility changes therefore also reach inspection. It does not construct a persistent store, externalize images, recover busy state, admit queues, start timers/tools or publish owners. Agent metadata is read without creating directories. Archive schema checks and committed mapping validation are shared with normal startup, with publication/migration left to their existing owners.

Existing SQLite databases use ordinary read-only connections with live WAL visibility. SQLite may maintain its normal locks and WAL-index/sidecar files. Read-only here forbids application SQL writes, schema migration, initialization of missing databases and semantic Catalog/Archive/Session/image publication; it does not promise zero filesystem writes. Inspection never removes those sidecars and does not use immutable reads, database copies or custom VFS behavior.

## Evidence

`SessionUpgradeInspectionTests` uses Source-produced catalog/Worker state, actual `performSessionWorkerHandback`, complete cold/required member inspection, fresh roots, legacy candidates, identity conflicts and inline images. It verifies retained authority bytes and durable mailbox/catalog rows rather than pinning SQLite sidecar bytes. `scripts/source-upgrade.test.js` executes the actual staged Core through source promotion, proving warning selection, active-Worker/global-Catalog rejection, unchanged prior selection on rejection, and preserved mailbox input. Ordinary startup and native-exec recipient recovery are covered by the [bootstrap tests](./session-manager-bootstrap.md).

`LegacyHistoryAuthorityTests` verifies that Source-readable history lacking message metadata and stale null-parent copies pass this same inspection without rewriting authority; ordinary admission/save and first Catalog migration share the result.
