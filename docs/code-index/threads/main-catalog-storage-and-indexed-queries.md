# Thread: Main Catalog Storage and Indexed Queries

## Purpose

Defines the cross-module boundary for Foxwarm's always-on Main-owned identity,
topology, lifecycle, counter, and presentation catalog. It covers storage
admission, ownership, indexed access, migration, and the query boundary used by
Session runtime/list consumers and future bounded WebUI navigation.

## Current path

```text
state/catalog.sqlite
```

The first schema version contains only Session catalog rows, ambiguity-preserving
aliases, canonical parent projections, and maintained counts. Session semantic
state remains in one authoritative JSON file per Session.

## Current flow

```text
state/sessions.json (+ numbered and legacy backup candidates)
        |
        | strict one-time verification
        v
temporary catalog SQLite database
        |
        | integrity check + fsync + atomic publish
        v
state/catalog.sqlite
        |
        +--> lightweight startup stubs (transitional list-all load)
        +--> exact/alias/agent/parent/node/recovery indexed lookups
        `--> indexed SessionRuntime list pages and maintained counts
```

Normal session persistence writes the authoritative per-session JSON before
committing that Session's bounded catalog projection. Main-owned presentation
changes can update catalog rows without rewriting semantic JSON. Session
workers never open or write the catalog; they publish bounded committed
projections to Main, and Main commits handback state while the worker fence is
still held.

## Storage admission rule

A table or column belongs in `catalog.sqlite` only when all of the following are
true:

1. Main owns the value or its catalog projection.
2. The value describes indexed identity, topology, lifecycle, a maintained
   counter, or list/presentation state.
3. Coordinating it in the same Main transaction as related catalog changes is
   useful.

The boundary explicitly excludes:

- per-session semantic history, queue, prompt/frontier, and worker-owned hot
  state, whose authority is `state/sessions/<id>.json`;
- worker ownership, mailbox, generation, and process runtime state in
  `session-runtime.sqlite`;
- archive, LLM journal, and vector contents;
- timers;
- sandbox process, stdio, and runtime state;
- node credentials and pairing secrets.

Future agent identity and sandbox definition/owner-binding tables may enter the
catalog through explicit schema migrations. They are not part of the current
Session-only schema. Channel attachments require a separate later decision;
timers remain outside this catalog.

## Query and migration properties

- Exact IDs use the Session primary key.
- Aliases use a composite `(alias, session_id)` key. Duplicate aliases remain
  representable; lookup reads at most two owners and leaves ambiguous input
  unresolved.
- Canonical parent projection is indexed separately from the preserved raw
  parent reference. Missing, self, or ambiguous parents project as roots; no
  parent foreign key rejects tolerated legacy topology.
- Recent, agent, parent/root, current-node, and restart-recovery queries use
  concrete indexes. Global, per-agent, and per-parent counts are maintained by
  catalog transactions.
- Ordered pages use an indexed recent-rank key and keyset cursors where the
  caller supports them. Compatibility offset callers still execute against the
  same ordered index and never force a table sort.
- One-time `sessions.json` migration verifies the selected row set and every
  cataloged authority file through the same version-aware shape validator used
  by hydration, ignores orphan authority files, preserves one exact evidence
  copy, and publishes through a temporary database. A cataloged row with
  missing, unreadable, unsupported-version, or malformed current authority
  fails closed without falling through to a stale catalog backup.
- Before retiring the legacy catalog, each unversioned authority is durably
  upgraded to v1. Proven legacy hydration seeds and any legacy-catalog-only
  semantic fields are transferred into that authority only when authority does
  not already own them. Current v1 authority always wins. Catalog JSON is then
  rebuilt from the narrow projection and never retains semantic bodies.
- Migration builds one reconciled row per Session from the exact validated v1
  authority (or the exact staged legacy-upgrade payload). Semantic settings,
  runtime/recovery counters, stats, vector position, and meta activity/wait
  projection come from that authority. Only catalog-owned identity/topology and
  presentation fields overlay it: Session ID/agent/aliases, parent relation,
  display/archive/pin/sidebar order, and narrow `lastChannel`. A retry after
  authority upgrade but before database publication therefore produces the
  same row and never revives stale legacy-catalog semantics.
- Runtime never dual-writes `sessions.json`; after successful publication the
  primary, numbered, and legacy catalog candidates are removed.

## Bounded WebUI boundary

The current Stage A WebUI compatibility endpoint may still materialize all
lightweight rows. The intended navigation boundary is mode-aware and bounded:
root pages, batched child previews/pages, exact-by-ID context, and flat pages
must query catalog indexes rather than requiring the browser to receive the
complete Session tree. Search and descendant aggregation must either be
honestly output-sensitive or use maintained projections; they must not become
hidden repeated full scans.

## Design decisions

### D-main-catalog-indexed-boundary

[2026-08-10] `state/catalog.sqlite` is the single always-Main-owned catalog for
indexed identity, topology, lifecycle, counters, and presentation projections.
High-frequency exact lookup, mutation, counting, recovery selection, and page
queries must be indexed and output-sensitive—normally \(O(\log n)\) or
\(O(\log n + k)\)—rather than repeated full scans, full sorts, or whole-catalog
rewrites. The catalog never becomes a second authority for per-session semantic
state and never absorbs worker runtime/mailbox, archive/journal/vector, timer,
sandbox runtime/stdio, or credential data. Session workers access it only
through Main-owned projection and handback boundaries. The current schema
contains only Session catalog data; future admitted domains require explicit
schema migrations and the same narrow admission test.

The Session `metadata_json` projection is an explicit allowlist, not a filtered
copy of a legacy row. Queue/managed-inbox/history/frontier/prompt/cache/mailbox,
goal, prompt-file, indexing, deferred-wait, and message bodies are prohibited.
A bounded wait presentation may contain only wait ID/start/reason/timeout,
requested/satisfied wait-all Session IDs, and advisory exec IDs. Legacy-only
semantic values must move durably into unversioned per-session authority before
legacy catalog retirement or make migration fail; they may not survive as a
generic catalog compatibility bag.
