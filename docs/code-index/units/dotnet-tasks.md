# Unit: .NET Main task authority

Files: `dotnet/Foxwarm/Sessions/TaskStore.cs`, `dotnet/Foxwarm/Sessions/TaskService.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Tasks.cs`, `dotnet/Foxwarm/Tools/AgentToolDefinitions.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Tasks.cs`, `dotnet/Foxwarm.Tests/Sessions/TaskStoreTests.cs`

## Purpose

Owns the bounded Main-local task authority for the .NET host. Tasks use the independent lazy `state/tasks.sqlite` store, the existing Session catalog for canonical IDs, the authenticated Tasks API, and the normal direct/unified/ToolScript tool dispatch path.

## Behavior

- `TaskStore` preserves the Source task schema, legacy columns and indexes, opens the database lazily, and uses a synchronous gate only for a connection. Read transactions keep list/detail projections consistent; `BEGIN IMMEDIATE` protects writes across independent connections.
- Supported actions are `create`, `list`, `get`, `claim`, `assign`, `update`, `complete`, and `cancel`. Validation is action-specific: titles are limited to 200 characters, descriptions/results to 4000, notes/reasons to 1000, task IDs to 128, and Session IDs to 256. Lists default to open/active and return at most 50 summaries; details bound children to 20 and notes to 10 with omission counts.
- Creator and owner IDs are derived from the live caller or the explicit WebUI management target. Known catalog aliases are canonicalized at reads, permission checks, writes and notification boundaries; unknown historical IDs remain readable. Assignment changes advance the persisted revision, reset notification eligibility, record an authored note and never reopen terminal tasks.
- Assignment and completion are committed before ordinary inter-Session delivery. New-owner delivery is normal, previous-owner delivery is passive, self-recipient delivery is skipped, and a delivery failure leaves the committed task intact with a truthful warning. Revision-guarded notification marking prevents a delayed result from changing a newer assignment.
- The task builtin uses the approved model-facing schema and description. Direct, unified and ToolScript calls converge on the same `TaskService` and deliver completion notifications through the ordinary actor-correct Session path. Child attachment/report receipts, Goal migration/removal and task reminder consumers remain outside this phase.

## HTTP

`WebUIChannel.Tasks` serves authenticated deployment-relative `/api/tasks` list/detail routes and explicit create/claim/assign/update/complete/cancel writes. Query keys, positive integer limits, route-selected action/task IDs and JSON object bodies are strict. Ordinary WebUI management requires an existing target for create and otherwise uses the task owner/creator fallback. Expected task errors retain stable codes and statuses; unexpected reads/writes use safe generic 500 responses.

## Tests

`TaskStoreTests` covers durable lifecycle behavior and two independent SQLite connections racing to claim one task. The retained API driver exercises real Session creation, self-completion, unknown WebUI targets, bounded list behavior and the no-provider path.
