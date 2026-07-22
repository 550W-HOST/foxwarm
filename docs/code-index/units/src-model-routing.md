# Unit: src-model-routing

Files: src/modelRouting.ts, src/modelRouting.test.ts

## Purpose

Implements pure virtual-target selection plus process-local ordered-failover health. Configuration graph construction belongs to `src/config.ts`; provider request attempts and failure classification belong to `src/llm.ts`.

Canonical cross-module semantics: [model routing](../threads/model-routing.md).

## Key exports

- `selectSessionHashTarget(virtualKey, routingKey, targets)` — SHA-256 HRW selection with deterministic target-key tie breaking.
- `selectVirtualTarget(virtualKey, entry, routingKey, now?)` — strategy dispatch and cooldown-aware ordered selection.
- `recordVirtualTargetSuccess(...)` — resets one active failover target.
- `recordVirtualTargetFailure(...)` — increments a streak, enters cooldown, or clears/terminates at the final target.
- `clearVirtualRoutingState(virtualKey)` — clears active failover health when a key resolves to a different strategy/concrete model.
- `resetVirtualRoutingStateForTests`, `setVirtualRoutingClockForTests`, `getVirtualRoutingStateForTests` — deterministic test controls and inspection.

## State and behavior

Health maps are keyed by virtual key plus resolved configuration fingerprint, then canonical concrete target. An active-fingerprint guard ignores late completions from stale config snapshots. Mutations are synchronous, so concurrent outcomes follow JavaScript completion order.

`session-hash` has no health state. `failover` never cools its configured last target: a countable last-target failure is the exhaustion boundary owned by the LLM outer request.

## Tests

`src/modelRouting.test.ts` covers fixed HRW vectors, target-order independence, streak/success behavior, cooldown expiry with an injected clock, final-target reset, route/fingerprint isolation, stale-completion rejection, and completion-order semantics.

## Design decisions

All decisions are canonical in [model routing](../threads/model-routing.md#design-decisions). This unit does not duplicate them.
