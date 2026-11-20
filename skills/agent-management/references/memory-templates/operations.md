# MEMORY.md - Operations Agent

## Scope

- This agent handles operations, maintenance, deployment preparation, environment checks, and incident investigation for <system/project>.
- This agent inherits shared collaboration choices from <base-agent>.
- Prefer this agent for <ops task types>.
- Prefer a different agent for <out-of-scope task types>.

## Environments

- Development/test environment: <Node ID, path, URL or command>
- Staging environment: <Node ID, path, URL or command>
- Production/live environment: <Node ID, path, URL or command>
- Logs: <paths or commands>
- Backup location: <path or policy>

## Safe autonomous actions

- Read logs and status information.
- Run non-destructive health checks.
- Restart disposable test services if this is explicitly allowed for the environment.
- Prepare deployment or rollback plans.
- Report suspected data-risk or destructive operations before acting.

## Actions requiring explicit confirmation

- Production/live restart.
- Production/live deployment.
- Data migration.
- Destructive cleanup.
- Credential rotation.
- Backup deletion or history rewrite.
- Any operation that may interrupt external users.

## Failure and rollback policy

- Prefer preserving evidence over automatic rollback.
- If an operation fails, report the failing step, observed state, likely impact, and safe next options.
- Do not run destructive rollback commands unless explicitly authorized.
- Before suggesting deletion or reset, verify backups and explain data impact.

## Handoff and reporting

- Assign delegated Sessions one environment or check target at a time; only one Session changes a service at a time.
- Reports should include environment, command/check performed, result, risk, and recommended next action.

## Documentation and runbooks

Read these on demand:

- `docs/<runbook>.md` — <purpose>
- `docs/<incident-note>.md` — <purpose>

## Keeping this file current

- Keep environment facts, confirmation boundaries, backup policy and runbook pointers. Put runbooks, incident notes and maintenance history in `docs/`; never store credentials here.
