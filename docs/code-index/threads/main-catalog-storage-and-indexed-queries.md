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

The second schema version contains only Session catalog rows, ambiguity-preserving
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

- per-session semantic history, queue, prompt/cache state, structured history provenance, and worker-owned hot
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

The Stage B backend exposes fixed version-1 `/api/session-list/*` projections
for sidebar bootstrap, batched child continuation, exact-by-ID context and
ancestor paths, Architecture summaries/tree pages, descendant confirmation
previews, and explicit search. Default/time/flat-time ordering is server-side;
pinned children are Sidebar presentation roots without changing their
canonical real parent. Architecture instead uses a real per-agent forest: an
agent Session is a forest root when its canonical parent is absent or belongs
to another agent, while same-agent children (including pinned children) retain
their real relation. Opaque cursors bind mode/scope/parent/agent plus a
process-instance catalog revision and volatile sequence; a matching mutation
returns a first-page reset instead of applying a stale key.

Root, child, agent, exact, alias, and by-ID queries use concrete indexes and
bounded batches. Initial child previews and multi-parent continuation each use
one bounded compound `UNION ALL` request composed of per-parent indexed
`LIMIT k+1` seeks, so they do not rank or scan every descendant of high-fanout
parents. Active local and current Worker projections are unioned in memory
before scope filtering, sorting, paging, and summary adjustment; one batched
ownership read validates Worker projections. Worker registry callbacks compare
one effective list-visible overlay signature: only fallback↔live transitions or
changed visible fields advance the volatile presentation revision. Establish
without projection, list-identical publication, and stale→clear are stable;
live→stale invalidates synchronously once. Stale entries never overlay or enter
the candidate union. Search is the sole explicit bounded projection scan and uses
the current ECMAScript lowercase/includes verifier. Recursive descendant
aggregation is an on-demand indexed CTE used only as a preview; lifecycle
mutations still recompute their authoritative graph.

Focus uses repeatable `focusSessionId` parameters with a small explicit cap;
comma is ordinary Session-ID content. Complete ancestor paths are fetched in
bounded exact-ID chunks so every accepted path row has a renderable DTO. New
request/query DTOs reject unknown keys and wrong types instead of coercing,
truncating, or ignoring them.

All new server pages use SQLite `BINARY` Session-ID tie order. In-memory
volatile merges compare UTF-8 bytes, yielding the same ordering for ASCII, BMP,
and supplementary IDs as SQLite and cursor tuples.

The current WebUI consumes these fixed queries through a normalized bounded
cache. Ordinary App, embedded Sidebar, collapsed rail, and Architecture mounts
never bootstrap through legacy `GET /api/sessions`. Sidebar keeps at most the
current root window, loaded child windows, forced focus paths, explicit
open/watch rows, and current search results; pages retain server order without
client tie sorting. Architecture owns its global summary plus paged real forest
and agent-filtered windows. Lifecycle dialogs fetch recursive count/busy
summaries from the descendant preview route rather than traversing a partial
client tree.

The global Session SSE remains a catalog invalidation stream and additionally
accepts a capped repeated exact-ID watch set. It sends immediate bounded list
projections and later state/deletion deltas only for those IDs; no all-row SSE
payload or browser-resident complete mirror is introduced. Catalog invalidation
refetches the current root/expanded windows through the existing fixed
1-second-visible/10-second-hidden non-overlap scheduler. Independent request
generations prevent stale root, child, exact, or search responses from replacing
newer windows. Legacy `GET /api/sessions` remains an external compatibility API.

Root and expanded-branch windows are replayed atomically through backend page
caps (100 roots; 20 children and 20 parents per child request). A cursor reset
or any presentation-revision mismatch across root pages, child batches, or the
root-to-branch boundary restarts the whole bounded replay from page one, including requested depths
beyond one page, before any structural publish. Per-row in-memory SSE epochs and
tombstones prevent older HTTP responses from overwriting or reviving newer
deltas. Exact current/open/watch sets are chunked rather than truncated, for
both by-ID HTTP and global SSE subscriptions. Ordinary busy-descendant badges
use a bounded batch active-ancestor projection; destructive dialogs retain exact
recursive summaries.

Every bounded Sidebar/search/exact item carries its numeric direct Sidebar
presentation-child count from one maintained-count batch over the returned IDs.
Default/Time counts exclude pinned children elevated to presentation roots; an
item's own unpinned children still count normally. Loaded child-page totals take
precedence in the browser. Architecture keeps its separate real-agent-forest
branch totals and does not reinterpret Sidebar counts.

Bounded Sidebar/search/exact rows also carry a list-only append sequence count
from one batched archive-store query per bounded ID chunk. An ordinary Session
uses its local maximum archived message `seq`; an actual archive fork uses
`max(0, local max seq - archive_branches.fork_message_seq)`. Session-tree parent
metadata is not fork evidence. This field is separate from runtime
`messageCount`, which continues to describe live active history for Chat,
history/state reconciliation, commands, and Architecture. State-only list
deltas may omit the archive-derived field; the bounded browser cache retains a
known value until catalog invalidation refetches the affected windows.

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
copy of a legacy row. Queue/managed-inbox/history/prompt/cache/mailbox,
goal, prompt-file, indexing, deferred-wait, and message bodies are prohibited.
Optional raw `effort` and `childEffortDefault` values are admitted only as
bounded semantic presentation projections alongside `model` and
`childModelDefault`; they add no SQL columns or schema-version change and never
become a second settings authority.
A bounded wait presentation may contain only wait ID/start/reason/timeout,
requested/satisfied wait-all Session IDs, and advisory exec IDs. Legacy-only
semantic values must move durably into unversioned per-session authority before
legacy catalog retirement or make migration fail; they may not survive as a
generic catalog compatibility bag.

[2026-08-10] Bounded WebUI navigation uses fixed product-neutral APIs rather
than a generic catalog query DSL. Sidebar pages preserve Default/Time/Flat
presentation, pinned elevation, forced focus paths, and stateless cursor reset;
Architecture and destructive-confirmation previews remain read-only catalog
projections. Explicit search preserves the current JavaScript field matching
semantics instead of introducing FTS authority. Volatile local/Worker state is
an in-memory presentation overlay only and never adds a persisted semantic
revision.

The canonical tie-break for these new bounded APIs is SQLite `BINARY` ordering
of exact Session IDs, mirrored byte-for-byte by Main's UTF-8 comparator.
Sidebar pinned elevation and Architecture's real per-agent forest are distinct
presentation contracts; neither mutates canonical parent ownership.

[2026-08-10] Normal WebUI list presentation is bounded and mode-aware. It must
not materialize the complete Session catalog merely to render Sidebar,
collapsed rail, Architecture, focus/open/watch state, search, or lifecycle
confirmation. Server order is authoritative; client caches retain only loaded
windows and exact context, distinguish explicit deletion from off-page absence,
and refresh invalidated windows without resetting selection or scroll. SSE may
push bounded deltas for explicitly subscribed rows plus catalog invalidation,
but must not recreate an all-Session broadcast mirror.

[2026-08-25] The Sidebar Session-row `n msgs` counter is an archive-derived
append-sequence presentation, not the runtime active-history count. It is
computed in bounded batches from the archive SQLite authority without adding a
catalog column, hydrating Sessions, scanning history payloads, or duplicating
fork metadata. Only `archive_branches.parent_session_id` establishes a fork;
ordinary parent relations never subtract. Fork counts are branch-local and
include every post-fork sequence, including system and tool scaffolding.
Runtime `messageCount` semantics and Architecture rendering remain unchanged.
