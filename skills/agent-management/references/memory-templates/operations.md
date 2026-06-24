# MEMORY.md - Operations Agent

## Scope

- This agent handles operations, maintenance, deployment preparation, environment checks, and incident investigation for <system/project>.
- This agent inherits shared collaboration rules from <base-agent>.
- Prefer this agent for <ops task types>.
- Prefer a different agent for <out-of-scope task types>.

## Environments

- Development/test environment: <path, node, URL, or command>
- Staging environment: <path, node, URL, or command>
- Production/live environment: <path, node, URL, or command>
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

- For child sessions, assign one environment or check target at a time.
- Do not let multiple sessions mutate the same service concurrently.
- Reports should include environment, command/check performed, result, risk, and recommended next action.

## Documentation and runbooks

Read these on demand:

- `docs/<runbook>.md` — <purpose>
- `docs/<incident-note>.md` — <purpose>

## Keep/drop policy

- Keep durable environment facts, confirmation boundaries, backup policy, and runbook pointers here.
- Do not keep incident timelines, large logs, credentials, or completed maintenance history in memory.
- Move incident notes and long runbooks into `docs/` and keep short pointers here.
- If this file grows past about 500 lines, split it.
