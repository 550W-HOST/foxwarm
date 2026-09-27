# Unit: src-model-routing

Files: src/modelRouting.ts, src/modelRouting.test.ts

## Purpose

Implements pure virtual-target selection plus process-local ordered-failover health. Configuration graph construction belongs to `src/config.ts`; provider request attempts and failure classification belong to `src/llm.ts`.

Canonical cross-module semantics: [model routing](../threads/model-routing.md).

## Key exports

- `selectSessionHashTarget(virtualKey, routingKey, targets)` — SHA-256 HRW selection with deterministic target-key tie breaking.
- `beginVirtualRoutingRequest(virtualKey, entry)` — activates or captures one independent-request route generation.
- `selectVirtualTarget(request, routingKey, now?)` — strategy dispatch and cooldown-aware selection against the captured request snapshot.
- `recordVirtualTargetSuccess(...)` — resets one active failover target.
- `recordVirtualTargetFailure(...)` — increments a streak, enters cooldown, or clears/terminates at the final target.
- `clearVirtualRoutingState(virtualKey)` — clears active failover health when a key resolves to a different strategy/concrete model.
- `resetVirtualRoutingStateForTests`, `setVirtualRoutingClockForTests`, `getVirtualRoutingStateForTests` — deterministic test controls and inspection.

## State and behavior

Active health is keyed by virtual key, resolved configuration fingerprint/generation, and canonical concrete target. Request contexts retain and mutate their selection snapshot after detachment; the generation guard prevents those local outcomes from replacing/resetting newer active state. Mutations are synchronous, so concurrent outcomes follow JavaScript completion order.

`session-hash` has no health state. `failover` never cools its configured last target: a countable last-target failure is the exhaustion boundary owned by the LLM outer request.

## Tests

`src/modelRouting.test.ts` covers fixed HRW vectors, target-order independence, streak/success behavior, cooldown expiry with an injected clock, final-target reset, route/fingerprint isolation, stale retry/outcome interleaving, rollback activation, and completion-order semantics.

## Design decisions

All decisions are canonical in [model routing](../threads/model-routing.md#design-decisions). This unit does not duplicate them.
