# MEMORY.md - Coordination Base

Agents that inherit this Agent share these collaboration choices. The framework's own delegation, Task and memory rules still apply.

## Delegation

- Executors may: <only investigate and propose | edit, test and commit within the assigned scope | also push or operate the named test environments>.
- Parallel work: <one executor at a time | several executors only with separate workspaces, branches and services | read-only investigation in parallel>.
- Children of executors: <not allowed | allowed when the assignment says so>.

## Environments

- Shared checkouts are acceptable for: <low-risk, non-parallel edits | never>.
- Delegated work that runs code from untrusted input uses: <worker Agent>, on a fresh Node from Provider <provider> with profile <profile>. The coordinator releases the Node after review.
- Always ask before: <production or live restarts and deployments, destructive migrations, public releases, actions that cost money>.

## Reports

- Executor reports include: changes and outputs, checks run and results, uncommitted state, blockers and risks, and recommended next steps.
- Relay to the user: <a brief summary | a structured engineering report | a fuller summary when the user cannot read child Sessions>.

## Pointers

- `docs/<file>.md`: <purpose>
