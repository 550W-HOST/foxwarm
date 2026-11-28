# Unit: Hosted packaging and failover drills

Files: `docker/hosted-entrypoint.sh`, `deploy/hosted/compose.yaml`, `deploy/hosted/deployment.yaml`, `deploy/hosted/haproxy.cfg`, `deploy/hosted/postgres-init/10-foxwarm-roles.sh`, `deploy/hosted/generate-secrets.sh`, `deploy/hosted/operator-s3.sh`, `deploy/hosted/operator-s3-policy.json`, `deploy/hosted/operator-login.sh`, `deploy/hosted/check-render.sh`, `deploy/hosted/helm/foxwarm/`, `deploy/hosted/drills/run.mjs`, `deploy/hosted/drills/drills.mjs`, `deploy/hosted/drills/env-process.mjs`, `deploy/hosted/drills/env-compose.mjs`, `deploy/hosted/drills/compose.drill.yaml`, `deploy/hosted/drills/mock-llm.mjs`, `deploy/hosted/drills/measure-multixact.mjs`, `deploy/hosted/drills/measure-import.mjs`, `deploy/hosted/kind/check.mjs`, `deploy/hosted/kind/fixtures.yaml`, `deploy/hosted/kind/values.yaml`, `deploy/hosted/README.md`
Secondary files: `Dockerfile`, `dotnet/Foxwarm/Hosted/HostedCli.cs`, `dotnet/Foxwarm/Hosted/Postgres/Keys/HostedKeyRing.cs`, `dotnet/Foxwarm/Program.cs`, `.github/workflows/tests.yml`

## Purpose

The `hosted` stage of the `Dockerfile` belongs here; the file itself belongs to [the public image](./public-main-docker.md).

How a [hosted](./hosted-runtime.md) tenant is packaged and run: the container image, the Compose stack and the Helm chart, the operator commands they rely on, and the drills that check the failover contracts with real processes and containers. The runtime contracts themselves (lease, fence, forwarding, exit codes) are in [hosted runtime](./hosted-runtime.md); the deployment configuration keys in [hosted configuration](./hosted-config.md#d-hosted-config-split).

For the optional full image and single-pod deployment of the operator tenant, see [master host](./hosted-master-host.md#deployment). The claims, image and role described there belong only to that tenant.

## D-hosted-image

**Approved plan §9 (2026-11-26).**

- **Target.** `docker build --target hosted` builds `debian:trixie-slim` with the `build` stage's `/out` payload in `/app`, the same NativeAOT build as the existing image. The existing `runtime` target stays the default and unchanged; `release.yml` doesn't build or publish the hosted image in P1.
- **Packages.** CA certificates, tzdata and tini, plus `libicu76` and `libssl3t64`, which native Main loads at run time (approved 2026-11-26: runtime libraries, not tools; ICU rather than invariant globalization). The hosted targets also include the [one-shot image worker](./hosted-image-decoder.md), libseccomp2 and `/usr/bin/prlimit`. No Chromium, git, Python, Node or curl.
- **Process.** uid and gid 1000, `FOXWARM_MODE=hosted`, `FOXWARM_SCRATCH_DIR=/scratch`, `FOXWARM_DEPLOYMENT_CONFIG=/etc/foxwarm/deployment.yaml`, `TMPDIR=/scratch/.temp`. `tini` is PID 1, in the image rather than through the orchestrator (Kubernetes adds no init): it forwards signals, passes on Foxwarm's exit code and reaps orphaned descendants of the processes a replica starts, such as ToolScript workers and Node providers. The entrypoint creates the temporary directory in the scratch mount and runs `/app/Foxwarm` with the container's arguments, so `db migrate`, `hosted token` and `hosted import` run in the same image.
- **Writes.** The root filesystem can be read-only: a replica writes only to the scratch mount (ephemeral); Agent files are in the tenant's [Agent store](./hosted-agent-store.md), so a replica mounts no shared volume. `/scratch/.temp` is inside the [scratch allowlist](./hosted-capabilities.md#d-capability-scratch-guard).
- **Health check.** `HEALTHCHECK` runs `/app/Foxwarm hosted health`, which probes `/livez` (approved 2026-11-26): an idle boot is a working container, and orchestrators route on `/readyz` themselves. The probe reads `health.port` from the same deployment configuration the replica reads, so the port has one source.

## D-hosted-operator-commands

**`hosted token` approved 2026-11-26; `hosted health` follows from the image health-check decision.**

- **`foxwarm hosted token [--tenant <name>]`** prints a version-zero tenant's sign-in token (after operator provisioning or rotation it refuses and directs the operator to issue a new setup token), the HTTP token [instance credential](./hosted-config.md#d-hosted-tenant-keys). It runs with a replica's environment (`FOXWARM_DATABASE_URL`, `FOXWARM_KEK_FILE`, `FOXWARM_KEK_PREVIOUS_FILE`) and writes nothing: no lease, no DEK creation or rewrap (`HostedKeyRing.OpenExisting`). Whoever holds the database URL and the KEK can already decrypt the tenant, so it exposes nothing new. Exit 0 with the token; 78 for bootstrap, KEK or locked-key errors and an unknown tenant; 1 while the tenant has no token yet (its first owner creates it). The token is never logged.
- **`foxwarm hosted health [--ready]`** probes this replica's health listener on the local host, `/livez` or `/readyz`, and exits 0 for 200 and 1 otherwise, including an unreadable deployment configuration.

## D-hosted-compose

**Approved plan §9 and user decision Q1.**

- `deploy/hosted/compose.yaml`: pinned `postgres:18.7-trixie` with an init script that creates `foxwarm_owner`, `foxwarm_app` (`NOSUPERUSER NOBYPASSRLS`), `foxwarm_operator` (NOLOGIN until the Compose operator-login job enables its separate login for the [operator service](./hosted-operator.md)) and the `foxwarm` database; `ghcr.io/versity/versitygw:v1.11.0` with a POSIX backend whose bucket is a directory; a one-shot `migrate` service with the migration URL; two replicas `foxwarm-1` and `foxwarm-2`; and `haproxy:3.2.10-alpine`, round-robin TCP over the replicas that pass `/readyz`, with `retries 2`, `option redispatch` and a 1 s connect timeout: a connection sent to a replica just stopped or recreated, before its checks mark it down, is redispatched after a second instead of the 5 s a longer timeout cost in the drills.
- **Replicas** are read-only, run as 1000, mount `/scratch` as tmpfs and the deployment YAML read-only, and stop with a 45 s grace period, above the 32 s multi-tenant process drain bound. Each has its own `FOXWARM_REPLICA_ID` and `FOXWARM_ADVERTISE_ADDRESS`; everything else is shared. `restart: unless-stopped` restarts a fenced replica (exit 75) with a new boot ID.
- **Proxy.** Round-robin TCP over both replicas with an HTTP check of `/readyz` on the health port. Any Ready replica takes connections because the front routes requests by tenant hostname. A replica enters rotation only after its first passing check (`init-state down`), and a connection that can't reach the chosen replica is redispatched to another. The proxy resolves replicas through Compose DNS with `init-addr none`, so a replica that is stopped or not yet created doesn't stop it.
- **Networks.** `backend` (internal) holds PostgreSQL and the object store; `frontend` holds the proxy and the replicas' egress.
- **Secrets** are files under `deploy/hosted/secrets/` (git-ignored), written by `generate-secrets.sh`: the database passwords and the URLs carrying them, the KEK in the instance key format, and the S3 credentials. The directory is 0700 and the files 0644, so the containers' fixed users can read their bind-mounted copies.

With S3, the operator uses the deployment bucket and a separate list/delete identity. The Compose setup job creates the VersityGW user and installs the sample policy on a bucket without one. Helm mounts the operator’s S3 keys only from its own Secret. See [physical erasure](./hosted-operator.md#suspension-and-deletion).

Both example deployments keep the operator running. With S3 it inventories historical Agent-file versions and must be able to list versions and delete objects at the same destination used by the replicas. Before migrating a pre-ledger installation (1102/1103), stop old Agent writers and imports, confirm all dispatched S3 writes have settled at the endpoint, then migrate and start the upgraded operator and replicas. New large-file admissions wait for the committed per-tenant inventory. Never resume a pre-ledger writer. See the cutover instructions in `deploy/hosted/README.md`.

## D-hosted-helm

**Approved plan §9.**

- A PVC-free StatefulSet of `replicaCount: 2` with `podManagementPolicy: Parallel`, a headless governing Service and rolling replacement, `/readyz` readiness and `/livez` liveness probes on the `health` port, and `terminationGracePeriodSeconds: 45`. `FOXWARM_REPLICA_ID` is the pod name and `FOXWARM_ADVERTISE_ADDRESS` the pod IP with the private mesh port.
- **One source for the ports.** `ports.http` and `ports.health` feed both the container ports and probes and the generated deployment YAML (`bot.httpHost: 0.0.0.0`, `bot.httpPort`, `health.port`). The ConfigMap holds that YAML: the operator's `deployment` values, with the listener, health port and the mounted S3 credential file paths set by the chart. The default S3 block is dropped for another backend. A checksum annotation rolls the pods when it changes.
- **Secrets.** A mesh Secret (`mesh.secretName`, containing the same base64-encoded 32-byte `mesh-secret` for all general and master-host pods); a runtime Secret (`database-url`, `kek.json`, optional `kek-previous.json`, S3 credentials) from values or `secrets.existingSecret`; the chart never generates a KEK. The migration URL is a separate hook Secret (or `migrate.existingSecret`) that exists only while the hook runs.
- **Migrate Job.** `db migrate` (schema only) as a `pre-install,pre-upgrade` hook with the migration URL, deleted after success, so a new version's schema is in place before its replicas start.
- **Pods.** No persistent volume: the tenant's state is in the database and the blob store. A PodDisruptionBudget keeps `minAvailable: 1`. Pods run as 1000 with a read-only root, no privilege escalation, all capabilities dropped and the RuntimeDefault seccomp profile.

## D-hosted-drills

**Plan §11 PQ row; each drill names the existing contract it checks and adds no behavior.**

- **One implementation, two environments.** `drills.mjs` holds the drills; `env-process.mjs` runs them on local processes (PostgreSQL from a prefix, VersityGW, the scoped S3 operator, a Foxwarm build, a partitionable TCP route per replica and a round-robin entry), `env-compose.mjs` on the Compose stack with `compose.drill.yaml` (no restart policy, since the runner acts as the orchestrator; a third replica slot for the surge; the mock model; a file-mode source and an importer). Replicas use the production lease timings (TTL 30 s, renew 5 s, fence 20 s).
- **Setup and login.** `db migrate`, two replicas, `foxwarm hosted token`, `POST /api/auth` through the entry (and a wrong token refused), then Setup installs a models document pointing at `mock-llm.mjs`, a scripted OpenAI Responses provider whose turn requests can be held open.
- **Smoke.** A turn, then a turn held at the model while the owner is killed with SIGKILL and restarted under its logical name. Checked against [D-session-restart-recovery](./session-manager-bootstrap.md#d-session-restart-recovery) and the persistence contract that a restart resumes recorded work: the takeover waits for the expiry, the new owner sends one new model request carrying the `session-resumed` event with the user's message once, history has the message once and one resume event, the interrupted request is never answered into history, and the Session ends idle with the new answer.
- **Partition.** The owner's database route is cut mid-turn, then the model answers it. Checked against [D-hosted-self-fence](./hosted-runtime.md#d-hosted-self-fence) and the [write fence](./hosted-database.md#d-hosted-write-fence): the isolated generation retires before expiry (exit 75 on escalation); another boot acquires only after expiry; the Session resumes as in the smoke; and the old owner's answer is in no row of a full data dump (text and hex-encoded `bytea`).
- **Upgrade fences.** An incompatible cluster schema refuses the replica at startup (78). A higher installation-reader floor on one tenant prevents its activation without stopping the boot or affecting other tenants.
- **Rolling update.** Start a compatible new boot, wait for readiness, stop an old boot and observe the tenant lease at a higher epoch. Requests go through the public front before, during and after the move; durable Session history reads back. The old boot's liveness is independent of how many tenants are resident. The separate managed process waves cover three ordinal replacements, a fourth boot joining/leaving, a locked lease and busy tenants in a slow confirmed stop.
- **Import.** A file-mode installation of the same build runs a turn, stops and is imported. The shared front serves the tenant by its hostname with the original token and Session history.
- **Container checks** (Compose only): both replicas reach Docker health `healthy`, run as 1000, can't write the root filesystem and can write scratch; after all drills `docker diff` of every replica shows nothing outside its mount points.
- **Render checks** (`check-render.sh`): `docker compose config` of the stack and of the drill overrides, `helm lint --strict`, `helm template` of each `ci/*-values.yaml` through `kubeconform -strict`, and a parse of every deployment YAML (Compose and rendered) by Foxwarm itself.
- **CI.** The `hosted-containers` job of `tests.yml` (also on `workflow_dispatch`) builds the image, checks it, runs the render checks, the Compose drills and the [kind check](#d-hosted-kind), and uploads both reports.

## D-hosted-kind

**P1 closeout (2026-11-26).** `kind/check.mjs` installs the chart on a one-node kind cluster (pinned kind, node image and kubectl) in the `hosted-containers` job, after the Compose drills and whenever the image built, bounded at 15 minutes.

- **Fixtures** (`kind/fixtures.yaml`): PostgreSQL with the Compose init script and VersityGW, with secrets from `generate-secrets.sh`; the chart's values-created Secrets and S3 settings point at them (`kind/values.yaml`).
- **Checks.** The migration Job completes before the StatefulSet creates its ordinal pods. Both pods pass `/readyz` and `/livez`; the runtime is activated by a request to the tenant host through the Service. The owner is identified by its lease and boot ID. After deletion the surviving boot takes a higher epoch before TTL expiry and the replacement ordinal registers a new boot. The check records the old container exit, lease transitions and Service probes.
- **Service traffic** during the takeover, new connections every 250 ms from inside the cluster through the Service, is counted and reported, not asserted: Kubernetes removes a deleted pod's endpoint concurrently with its SIGTERM.

## Measurements (2026-11-26, one development machine)

- **MultiXact churn from the lease row** (`measure-multixact.mjs`, owner and standby processes, complete turns against the mock model; about 21 write transactions per turn). One busy Session: 12 writes/s, 0.08 MultiXacts/s. Four: 26 writes/s, 7 MultiXacts/s. Sixteen continuously busy Sessions: 46 writes/s, 32 MultiXacts/s and 153 member offsets/s, which reaches `autovacuum_multixact_freeze_max_age` (400 million) in about 145 days and half the member space in about 163 days. At single-tenant rates this is ordinary anti-wraparound vacuuming; the lease lock needs no change in P1. With many tenants in one database the rates add up, which P2 should revisit.
- **Import of a large Session document** (`measure-import.mjs`, `foxwarm hosted import` of a file-mode installation whose document is grown with tool-call records; NativeAOT build, every statement logged). 9, 32 and 64 MiB documents import in 0.9, 1.4 and 5.0 s in total (the Session phase 0.15, 0.5 and 2.9 s), verified, as 37, 126 and 251 segments (12 MiB stored for 64 MiB). Each segment insert is its own statement, at most 65 ms; the slowest statement was the 64 MiB document's `COMMIT` at 1.9 s. `statement_timeout` (15 s) bounds each statement, not the document, so it isn't a limit at these sizes; it would be for a document whose commit approaches it, several times larger. Memory is the practical limit: the importer's peak RSS was 258, 633 and 1,097 MiB, about seventeen times the document.

## Open Questions

- **Service traffic during a Kubernetes takeover.** The kind check reports, but doesn't assert, requests through the Service while the owner pod is deleted: endpoint removal races the pod's SIGTERM, while a healthy remaining edge can hold a fresh request during an ownership move. A `preStop` delay, or readiness that stays 200 through a takeover, would narrow it; neither is decided.
