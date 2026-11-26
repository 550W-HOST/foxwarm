# Foxwarm hosted mode

Hosted mode runs Foxwarm as stateless replicas over PostgreSQL and S3-compatible object storage. In this release a deployment serves one tenant: one replica owns it and serves it, and the others stand by, forwarding connections to the owner and taking over when it stops or fails. File mode remains the default way to run Foxwarm and is unaffected.

This directory has the container image instructions, a Docker Compose stack, a Helm chart and the failover drills.

## Image

Build the `hosted` target of the repository `Dockerfile` from the repository root:

```sh
docker build --target hosted -t foxwarm-hosted:local .
```

It is the same native build as the default image, on `debian:trixie-slim` with CA certificates, time zones, the ICU and OpenSSL libraries Foxwarm loads, and tini as the init process. It contains no tools for Agents (no Chromium, git or Python): Agents run commands on Nodes, not in the replica.

| | |
| --- | --- |
| User | uid and gid 1000 |
| Root filesystem | can be read-only |
| `/scratch` | the replica's ephemeral directory (logs, uploads in progress, temporary files); mount an empty tmpfs or emptyDir |
| `/agents` | the Agent folders, one volume shared by every replica of the tenant |
| `/etc/foxwarm/deployment.yaml` | the deployment configuration, mounted read-only |
| Health check | `/app/Foxwarm hosted health`, which probes `/livez` on `health.port` |

The container's arguments are Foxwarm's: no arguments run a replica, and the operator commands run in the same image.

### Environment

| Variable | Meaning |
| --- | --- |
| `FOXWARM_DATABASE_URL_FILE` | file with the runtime role's URL, `postgres://foxwarm_app:…@host:5432/foxwarm` |
| `FOXWARM_MIGRATE_DATABASE_URL_FILE` | file with the schema owner's URL, for `db migrate` only |
| `FOXWARM_KEK_FILE` | the key-encryption key file (`{"version":1,"keyId":"…","key":"…"}`) |
| `FOXWARM_KEK_PREVIOUS_FILE` | the previous key-encryption key, during a rotation |
| `FOXWARM_REPLICA_ID` | this replica's name |
| `FOXWARM_ADVERTISE_ADDRESS` | `host:port` where other replicas reach this one's public listener |
| `FOXWARM_TENANT` | the tenant name (default `default`) |

`FOXWARM_MODE`, `FOXWARM_SCRATCH_DIR`, `FOXWARM_AGENTS_DIR` and `FOXWARM_DEPLOYMENT_CONFIG` are set by the image. Each `…_FILE` variable also has a plain form holding the value itself.

Keep the key-encryption key safe and backed up. The tenant's secrets are encrypted under a data key that only it unwraps; without it the tenant can't start, and nothing is regenerated.

### Commands

| Command | Use |
| --- | --- |
| `db migrate [--app-role <role>] [--operator-role <role>] [--tenant <name>]` | applies schema migrations and creates the tenant; needs the migration URL |
| `db status` | lists applied and pending migrations and which key-encryption key wraps each tenant's data key |
| `hosted token [--tenant <name>]` | prints the tenant's sign-in token; needs the database URL and the key-encryption key |
| `hosted import --data-root <dir> …` | copies a stopped file-mode installation into a new tenant |
| `hosted health [--ready]` | the container health check |

Create three database roles before the first migration: the schema owner, which `db migrate` connects as; the runtime role the replicas use (`foxwarm_app` by default, `NOSUPERUSER NOBYPASSRLS`); and the operator role that owns tenant administration (`foxwarm_operator` by default, also `NOBYPASSRLS`, without a login until the operator surface connects as it). `FOXWARM_APP_ROLE` and `FOXWARM_OPERATOR_ROLE` name other roles. A database keeps the roles it was first migrated with.

A replica exits with 0 when stopped, 75 when it lost the tenant (restart it; it comes back as a standby), 78 for a configuration, key or schema refusal that a restart won't fix, and 1 for other failures such as an unreachable database.

## Deployment configuration

The mounted YAML holds only deployment settings: `url`, `bot.httpHost`, `bot.httpPort`, `bot.enableWebUI`, `health.port` (required), `blobs` (required: `backend: s3` with its connection, or `backend: postgres`), `asrService`, `nodeProviders` and `journal.retentionDays`. Everything else is a tenant setting, stored in the database and edited through Setup in the WebUI. A replica refuses a tenant setting in this file, naming it. The file is read at start, so a change takes effect through a rolling restart. The keys and the split are described in [hosted configuration](../../docs/code-index/units/hosted-config.md).

## Docker Compose

`compose.yaml` runs PostgreSQL 18, VersityGW as the object store, a one-shot `migrate` service, two replicas sharing the `agents` volume, and an HAProxy that spreads connections over the replicas.

```sh
docker build --target hosted -t foxwarm-hosted:local .
deploy/hosted/generate-secrets.sh deploy/hosted/secrets
docker compose -f deploy/hosted/compose.yaml up -d
docker compose -f deploy/hosted/compose.yaml exec foxwarm-1 /app/Foxwarm hosted token
```

Open `http://localhost:3001` and sign in with the token. On first sign-in, Setup asks for a model provider as in file mode.

- `generate-secrets.sh` writes the database passwords, the URLs that carry them, a new key-encryption key and the S3 credentials into a new 0700 directory. Back up `kek.json`.
- `deployment.yaml` is the mounted deployment configuration. To use another S3 service or PostgreSQL, change the `blobs` block and the URL secrets.
- `FOXWARM_PUBLISH` sets the published address (default `127.0.0.1:3001`). Put a TLS-terminating proxy in front for anything beyond local use, and set `url` accordingly.

## Helm

`helm/foxwarm` deploys the replicas of one tenant; PostgreSQL and the object store are external.

```sh
helm install foxwarm deploy/hosted/helm/foxwarm \
  --set image.repository=registry.example.com/foxwarm --set image.tag=<tag> \
  -f my-values.yaml
kubectl exec deploy/foxwarm -- /app/Foxwarm hosted token
```

- **Values.** `deployment` holds the deployment configuration keys; the chart adds the listener, `health.port` and the S3 credential paths from `ports` and the mounted Secret. `secrets` supplies the runtime URL, the key-encryption key and the S3 credentials, or `secrets.existingSecret` names a Secret with the keys `database-url`, `kek.json`, `s3-access-key-id` and `s3-secret-access-key`. The chart never generates a key-encryption key.
- **Migrations.** A `pre-install`/`pre-upgrade` hook Job runs `db migrate` with `migrate.databaseUrl` (or `migrate.existingSecret`, key `migrate-database-url`).
- **Agents.** `agents.persistence` creates a ReadWriteMany claim (or uses `existingClaim`) mounted by every replica. The lease, not the filesystem, keeps a single writer.
- **Rollout.** Two replicas, `maxSurge: 1` and `maxUnavailable: 0`, `/readyz` and `/livez` probes on the health port, a 60 s termination grace period and a PodDisruptionBudget with `minAvailable: 1`.

## Upgrades

Migrate first, then roll the replicas; the Helm hook does this in order. A replica refuses to start (exit 78) against a schema with a migration it doesn't know whose reader level is above its own, or a tenant that a newer version has marked; downgrade by restoring the database, not by starting an older image. On a graceful stop the owner drains and releases the tenant, and a standby takes over within a few seconds. New requests in that window wait at the standbys and reach the new owner; WebUI and Node connections to the old owner reconnect.

To rotate the key-encryption key, mount the new key as `FOXWARM_KEK_FILE` and the old one as `FOXWARM_KEK_PREVIOUS_FILE`, roll the replicas, check with `db status` that every tenant names the new key, then remove the old one.

## Moving a file-mode installation

Stop the file-mode Main, then run `hosted import` with the replicas' database URL, the migration URL and the key-encryption key, from the image or a Foxwarm build:

```sh
foxwarm hosted import --data-root /path/to/foxwarm-data --deployment-config deployment.yaml --report import.json
```

The source directory isn't changed. The import verifies what it copied and writes an owner-only report, including the settings it moved to a draft deployment configuration and the settings hosted mode doesn't have. Copy the installation's `agents/` directory to the Agents volume. The imported tenant keeps its sign-in token and secrets. Details are in [hosted import](../../docs/code-index/units/hosted-import.md).

## Limitations of this release

- One tenant per deployment, served by one replica at a time. Standbys add availability, not capacity.
- Failover is a restart: after a crash, a standby takes over when the lease expires (up to 30 seconds) and resumes interrupted turns as a restarted file-mode Main does. Model streams and tool calls in flight are not continued.
- There is no `master` Node: no commands, terminals, Code or browser on the replica. Connect Nodes for Agents to work on. Stdio MCP servers, Claude Code Sessions and Vector search aren't available.
- Agent folders live on a shared volume, the only state outside the database.
- The hosted image isn't published; build it from this repository.
- Large imports need memory: importing a 64 MB Session document peaked at about 1.1 GB.

## Drills

`drills/run.mjs` checks the failover contracts against local processes or this Compose stack: a turn interrupted by killing the owner, a database partition, the upgrade refusals, a rolling update and an import. CI runs them on the Compose stack with `check-render.sh`, which validates the Compose files and the Helm chart, and `kind/check.mjs`, which installs the chart on a kind cluster and checks the migration hook, the probes, the shared Agents claim and a takeover after the owner pod is deleted. See [hosted packaging](../../docs/code-index/units/hosted-packaging.md).
