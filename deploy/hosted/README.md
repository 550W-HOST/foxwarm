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

`FOXWARM_MODE`, `FOXWARM_SCRATCH_DIR` and `FOXWARM_DEPLOYMENT_CONFIG` are set by the image. Each `…_FILE` variable also has a plain form holding the value itself.

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

### Multi-tenant operator service

`foxwarm operator serve` runs the control plane on its own database login and HTTP listener. It takes `FOXWARM_DATABASE_URL_FILE` for the operator role and `FOXWARM_KEK_FILE`, never the migration URL. In the deployment YAML, set `url: "https://{slug}.example.com"` and `operator: {url: "https://control.example.net", port: 3003}`. Route the operator host to this service and the wildcard tenant domain to the replicas. Preserve the public Host header, including any non-default port. Terminate TLS at ingress; keep the control plane internal where possible.

The Compose `operator` profile adds this service with the local example in `deployment.operator.yaml`. The Helm equivalent is `operator.enabled`, `operator.url` and `operator.existingSecret` (keys `database-url`, `kek.json`, and, for S3, the operator’s own `s3-access-key-id` and `s3-secret-access-key`). For Compose, run `./generate-secrets.sh --operator secrets` once in the stack directory. The default PostgreSQL service uses the original secrets and leaves the operator role `NOLOGIN`. Enabling the profile runs a one-shot job that sets the separate login password, including on an existing volume. For Helm, provision the login in the external database. The default packaged replicas still use the single-tenant topology pending the multi-tenant forwarding cutover. On these single-tenant (P1) replicas, settings apply on the next start. On P1, a rotation takes effect only after a replica restart.

Create an operator bearer with the migration environment and store it in a private file:

```sh
(umask 077; foxwarm operator token create > operator.token)
foxwarm operator --url https://control.example.net --token-file operator.token tenant create alpha hosted alpha.example.com
```

Give the returned setup token to the tenant administrator. It expires in 24 hours. The first sign-in on the tenant's own origin shows the access token to save. On a multi-tenant replica, `tenant rotate alpha` invalidates the earlier credential once the owner observes the change (normally by the next five-second renewal) and issues another one-time token. See [the operator API](../../docs/code-index/units/hosted-operator.md) for settings, placement and rotation.

Open the operator origin in a browser and sign in with the operator bearer to see tenants, their current owners and the registered replicas. Select a tenant to edit limits or journal recording and retention, or suspend and resume it. The console keeps the bearer in memory until sign-out or reload.

Use `grants set SLUG PROVIDER QUOTAS-FILE` to give a tenant access to a configured Provider, `grants list SLUG` to see its explicit grants, and `grants remove SLUG PROVIDER` to remove one. For example, `{"nodes":5,"execs":2}` overrides the first two quotas and keeps the default 60 lifecycle actions per hour. A grant change refreshes that tenant's running generation on a multi-tenant (P2) replica. Single-tenant (P1) hosted replicas ignore grants and log `Provider grants aren't applied in single-tenant hosted mode.` A hosted tenant needs an explicit grant to a Provider declared `tenancy: per-tenant`. An operator-profile tenant can also use legacy Providers; removing an explicit grant for that profile restores access without grant quotas. Placement reports Provider description or tenancy problems from the current owner.

Choose the Agent store at creation: hosted tenants use SQL Agent files, and the operator tenant uses Agent folders on the master host. `tenant set` refuses a profile edit that would switch stores.

### Move, release or drain

Finish upgrading all participating replicas to a multi-tenant build with placement actions before using these controls. Run `placement` to find a tenant’s `tenantId`, exact `owner` boot ID and `epoch`; pass those values to `tenant move SLUG TENANT-ID BOOT EPOCH` or `tenant release SLUG TENANT-ID BOOT EPOCH`. A move needs another eligible replica. Release leaves the tenant idle until demand starts it again. If placement changed, read it again before deciding whether to retry.

`replica drain BOOT` moves resident tenants to eligible non-draining replicas when available. Until then, a resident stays. New requests and background work prefer non-draining replicas but can activate a tenant on a healthy drained replica when none of the non-draining replicas is eligible. A replica that is shutting down cannot take a new tenant. In the console, select a tenant to move or release its lease, or select **Drain replica** on the Replicas tab. Refresh to see the requested tenant action, whether its lease is draining, and how many unexpired leases the draining boot still holds. An accepted request is not a completed handoff.

### Suspend, resume and erase a tenant

Use `tenant suspend SLUG` to stop serving a tenant, and `tenant resume SLUG` to bring it back. `tenant delete SLUG` requires a suspended tenant. It returns `deleting` as soon as the deletion is recorded. Check `tenant get SLUG`: the key and tombstone remain until the database can finalize the tenant and the object store has returned a settled empty listing. The tenant then returns 404 and its slug can be reused. Restarting the operator resumes outstanding deletions automatically. Finish an in-progress import first; an interrupted Agent-only import can also be abandoned with `foxwarm hosted agents import --tenant SLUG --abandon`.

Hosted S3 Agent files require the operator service. Before switching to the shared tenant replica, stop all pre-upgrade Agent-file writers (including import), confirm that outstanding object requests have settled at the endpoint, and start the upgraded operator and replicas against the same destination. Do not use a client timeout as proof that a previously dispatched PUT is finished. The operator inventories historical Agent object versions before a tenant can admit new large files. Keep it running: a failed inventory prevents admission, and a failed delete or object hold keeps those bytes charged.

Use the **same blob backend, endpoint, region and bucket** on replicas and the operator. Keep them available through the pending late-write check. Each uses its own credentials. For S3, grant the operator `s3:GetBucketVersioning`, `s3:ListBucket` and `s3:ListBucketVersions` (restrict both lists to `t/*`), plus `s3:DeleteObject` and `s3:DeleteObjectVersion` on `BUCKET/t/*`. It does not need object read/write, a retention override or legal-hold management. When enabling the Compose profile, run `generate-secrets.sh --operator` on the existing secrets directory. The setup jobs create the separate database login and VersityGW user. An existing bucket policy is preserved: merge `operator-s3-policy.json` into it if needed. With Helm, provision these permissions in the external object store and put only the deletion identity in the operator Secret.

For S3, `objectsPending: true` includes the first settle interval (one lease TTL plus the PUT timeout) and outstanding versions, including delete markers. Object Lock and access errors keep cleanup pending; check the operator log. A storage administrator may need to restore permissions, wait for retention to expire or clear a legal hold. The operator does not override retention.

A 404 for the tenant does not certify permanent erasure: a PUT accepted earlier can still reach the old namespace. Use `foxwarm operator --url ORIGIN --token-file FILE deletions` (or `GET /operator/v1/deletions`) to see pending late-write checks, identified by the old numeric tenant ID. `observedEmptyAt` records the settled empty listing and `recheckAfter` the next check, 24 hours later. `foundLateObjects` records a late object observed during reconciliation. After removing late objects and observing a fresh empty listing, the operator logs the result and drops the receipt. If the configured S3 destination changes, the operator logs the old namespace, endpoint and bucket and discards that receipt without checking it. The administrator who moved the storage must check the old destination. A connection failure or a missing bucket at the same destination leaves the check pending. Newly created tenants use a different namespace even when they reuse a slug.

## Deployment configuration

The mounted YAML holds only deployment settings: `url`, `bot.httpHost`, `bot.httpPort`, `bot.enableWebUI`, `health.port` (required), `blobs` (required: `backend: s3` with its connection, or `backend: postgres`), `asrService`, `nodeProviders`, `journal.retentionDays` and `egress`. Everything else is a tenant setting, stored in the database and edited through Setup in the WebUI. A replica refuses a tenant setting in this file, naming it. The file is read at start, so a change takes effect through a rolling restart. The keys and the split are described in [hosted configuration](../../docs/code-index/units/hosted-config.md).

### Outbound connections

A hosted tenant's outbound connections (model providers, MCP servers, OAuth, channels) can't reach loopback, private, link-local, metadata and other internal addresses, checked on every connection, redirects included. To let tenants use a model server or MCP server inside your network, list its exact host name, address or CIDR under `egress.allow.hosted`; add the addresses of your own infrastructure (database, object storage, cluster pod and service ranges) under `egress.deny`, which applies to every tenant:

```yaml
egress:
  deny: [10.96.0.0/12, 10.244.0.0/16]
  allow:
    hosted: [llm.models.svc.cluster.local]
```

A host name exception skips the address check for that name only; prefer it to a CIDR. It matches the name exactly as written, trailing dot included: a relative name such as `mock-llm` or a Kubernetes short service name is resolved through the replica's DNS search list, while `api.example.com.` is absolute. Use absolute names for hosts outside the cluster. HTTPS servers must send their full certificate chain: missing intermediate certificates aren't downloaded.

Addresses in the local-use NAT64 range `64:ff9b:1::/48` are refused for every tenant, because the range doesn't say which IPv4 host an address stands for. If you run a translator there, allow its prefix under `egress.allow.hosted` or `egress.allow.operator`; the IPv4 rules then no longer apply to addresses in that prefix. Addresses in the well-known NAT64 prefix `64:ff9b::/96` are checked as the IPv4 address they translate to.

## Docker Compose

`compose.yaml` runs PostgreSQL 18, VersityGW as the object store, a one-shot `migrate` service, two replicas, and an HAProxy that spreads connections over the replicas.

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
kubectl exec statefulset/foxwarm -- /app/Foxwarm hosted token
```

- **Values.** `deployment` holds the deployment configuration keys; the chart adds the listener, `health.port` and the S3 credential paths from `ports` and the mounted Secret. `secrets` supplies the runtime URL, the key-encryption key and the S3 credentials, or `secrets.existingSecret` names a Secret with the keys `database-url`, `kek.json`, `s3-access-key-id` and `s3-secret-access-key`. The chart never generates a key-encryption key.
- **Migrations.** A `pre-install`/`pre-upgrade` hook Job runs `db migrate` with `migrate.databaseUrl` (or `migrate.existingSecret`, key `migrate-database-url`).
- **Rollout.** Two general replicas in a StatefulSet with stable ordinal pod names, rolling replacement, `/readyz` and `/livez` probes on the health port, a 45 s termination grace period and a PodDisruptionBudget with `minAvailable: 1`.

## Upgrades

Migrate first, then finish rolling all replicas before creating tenants or rotating credentials. The schema floor is checked at startup: a running older owner can continue to renew after migration. The operator rejects creation and rotation while any unexpired active grant belongs to an unknown or pre-1200 boot, even when its heartbeat is stale. New-style tenants can only be acquired by a registered boot at level 1200 or later. A replica refuses to start (exit 78) against a schema with a migration it doesn't know whose reader level is above its own, or a tenant that a newer version has marked; downgrade by restoring the database, not by starting an older image. On a graceful stop the owner drains and releases the tenant, and a standby takes over within a few seconds. New requests in that window wait at the standbys and reach the new owner; WebUI and Node connections to the old owner reconnect.

To rotate the key-encryption key, mount the new key as `FOXWARM_KEK_FILE` and the old one as `FOXWARM_KEK_PREVIOUS_FILE`, roll the operator service together with all replicas, check with `db status` that every tenant names the new key, then remove the old one.

## Moving a file-mode installation

Stop the file-mode Main, then run `hosted import` with the replicas' database URL, the migration URL and the key-encryption key, from the image or a Foxwarm build:

```sh
foxwarm hosted import --data-root /path/to/foxwarm-data --deployment-config deployment.yaml --report import.json
```

The source directory isn't changed. The import verifies what it copied and writes an owner-only report, including the settings it moved to a draft deployment configuration and the settings hosted mode doesn't have. Agent folders from the configured `paths.agentsDir` (by default `agents/`) are imported and verified file by file. If the source used a separate Agents volume or its stored path lies outside the offline copy, stage the volume and pass `--agents-dir <path>`. Old file-mode attachments under `.temp/channel-files/` are excluded. The imported tenant keeps its sign-in token and secrets. Details are in [hosted import](../../docs/code-index/units/hosted-import.md).

For an existing hosted tenant that used a separate Agents volume, stop its replicas and run `foxwarm hosted agents import --tenant <name> --from <agents-directory>` with the same database and blob configuration. Restart the replicas after verification succeeds. An interrupted import keeps the tenant offline; run the command again against the same volume. It skips identical files and reports conflicts without overwriting them. To resume service with the files already in place, use `foxwarm hosted agents import --tenant <name> --abandon` and inspect its inventory.

## Limitations of this release

- One tenant per deployment, served by one replica at a time. Standbys add availability, not capacity.
- Failover is a restart: after a crash, a standby takes over when the lease expires (up to 30 seconds) and resumes interrupted turns as a restarted file-mode Main does. Model streams and tool calls in flight are not continued.
- There is no `master` Node: no commands, terminals, Code or browser on the replica. Connect Nodes for Agents to work on. Stdio MCP servers, Claude Code Sessions and Vector search aren't available.
- Agent folders live in the tenant’s Agent store. Replicas need no Agents volume.
- The hosted image isn't published; build it from this repository.
- Large imports need memory: importing a 64 MB Session document peaked at about 1.1 GB.

## Drills

`drills/run.mjs` checks the failover contracts against local processes or this Compose stack: a turn interrupted by killing the owner, a database partition, the upgrade refusals, a rolling update and an import. CI runs them on the Compose stack with `check-render.sh`, which validates the Compose files and the Helm chart, and `kind/check.mjs`, which installs the chart on a kind cluster and checks the migration hook, the probes and a takeover after the owner pod is deleted. See [hosted packaging](../../docs/code-index/units/hosted-packaging.md).

## The master host

Enable the master host only if the deployment has an operator tenant. It runs trusted operator Agents with local exec, Code, terminals, the Main browser and stdio MCP. It carries the runtime database credentials and KEK, and serves only the operator profile. Set configuration through Setup or `ctl config`; the operator's structured configuration is stored in PostgreSQL.

Build the `master-host` target with the Code workbench package from the matching Foxwarm version. Place `foxwarm-code-<version>.fwassets` in its own directory and supply it as the `code` build context:

```sh
docker build --target master-host --build-context code=./code-package -t foxwarm-master:local .
docker compose -f deploy/hosted/compose.yaml --profile master up -d
```

Set `FOXWARM_MASTER_IMAGE` for a different image reference. The mount root `/master` is `FOXWARM_AGENTS_DIR`; it holds numeric tenant folders and `/master/scratch`. The master uses the full Linux runtime image (including git, Python, Node.js and Chromium), the normal browser sandbox and a persistent `master` volume. The ordinary `hosted` image has no Agent tools and no master volume. Compose generates its mesh secret with the base stack secrets; for an older secrets directory, provision `secrets/mesh-secret` with a base64-encoded 32-byte random value matching the other mesh participants. For direct testing use the master replica's listener and the tenant's registered hostname. The default `<slug>.localhost` assignment serves local use only. Remote Nodes need a reachable tenant hostname, or a configured `url` that those Nodes can reach. Without a configured URL, bootstrap scripts use the validated request origin and refuse loopback names. Routing from general replicas is handled by the shared forwarding layer.

In Helm, set `masterHost.enabled=true`, `masterHost.image` to the full image reference and `mesh.secretName` to an existing Secret containing the `mesh-secret` file. Set `masterHost.storage` and optionally `masterHost.storageClassName`. Install `docker/seccomp-chromium.json` on eligible Kubernetes nodes under the kubelet's seccomp directory at `masterHost.chromiumSeccompProfile`. The chart creates one `foxwarm-master` StatefulSet pod with a ReadWriteOnce claim. Upgrades replace ordinal zero without surge. A stopped pod or a volume reattachment is operator downtime; general tenants keep their existing owners. Back up the claim: live terminal processes don't survive restart, but Agent files, Code workspace and exec logs do.

**Forced replacement:** the StatefulSet can guarantee one writer only while Kubernetes waits for the old master to stop. If its node is unreachable, fence the node (for example, confirm it is powered off) or revoke its access to the volume before allowing a replacement. Never force-delete the master pod or its node without that fencing. A new PostgreSQL lease cannot revoke file handles that the old master already has open.

### Operator Agent folders

The master host opens Agent folders under `FOXWARM_AGENTS_DIR/<tenant_id>/`. The numeric directory belongs to that database tenant for its entire lifetime. Back up the master volume alongside its structured state. After replacing or deleting the operator tenant, preserve or remove its old directory explicitly. A replacement gets its own directory.

To migrate a stopped operator installation, mount its offline copy read-only and the master volume read-write in the import job. Set `FOXWARM_AGENTS_DIR` to the same existing directory the master host uses. Both the dry run and the real operator import check that this directory is writable and supports directory sync. Run `foxwarm hosted import --profile operator --tenant <slug> --data-root <copy>`; add `--agents-dir <source>` for a separately staged Agents volume. Use `--dry-run` first to inspect the plan without changing the target. The copy preserves executable modes and symlinks; inspect the report for dangling targets.

**Compose.** Run the importer as a one-off `foxwarm-master` container in the **same Compose project** as the serving master. This reuses the project's `master` volume at `/master`. From `deploy/hosted`, with PostgreSQL and the blob service running, the example below assumes `SOURCE` is the absolute path to the stopped installation's copy and `REPORTS` is an existing directory writable by uid 1000. Use the same `-p` or `COMPOSE_PROJECT_NAME` as the deployment if it overrides the default. Only the import job gets the migration credential.

```sh
docker compose --profile master stop foxwarm-master
import_ops() {
  docker compose --profile master run --rm --no-deps \
    -v "$SOURCE:/source:ro" -v "$REPORTS:/reports" \
    -v "$PWD/secrets/migrate-database-url:/run/secrets/migrate-database-url:ro" \
    -e FOXWARM_MIGRATE_DATABASE_URL_FILE=/run/secrets/migrate-database-url \
    foxwarm-master hosted import --profile operator --tenant ops --data-root /source "$@"
}
import_ops --dry-run --report /reports/ops-plan.json
# Inspect the plan before running the import. Use fresh report filenames for each run.
import_ops --report /reports/ops-import.json
```

**Helm.** In the release namespace, record the serving pod's image and the `master` volume's claim name **before** scaling down. For the default release `foxwarm` they are available with:

```sh
kubectl get pod foxwarm-master-0 -o jsonpath='{.spec.containers[0].image}{"\n"}{.spec.volumes[?(@.name=="master")].persistentVolumeClaim.claimName}{"\n"}'
kubectl scale statefulset foxwarm-master --replicas=0
kubectl wait --for=delete pod/foxwarm-master-0 --timeout=5m
```

Run a Job in that namespace with the **existing** claim (normally `master-foxwarm-master-0`); creating a new PVC would import into a different disk. The example uses a read-only copy on `operator-import-source` and writes the report and deployment draft under `/master/import-reports`. Substitute the exact master image, claim, deployment ConfigMap and runtime Secret from the release. Supply an existing Secret with `migrate-database-url` for this Job; the chart's temporary migration-hook Secret may already have been deleted. Use `--dry-run` and a separate report name for a planning Job first.

```yaml
apiVersion: batch/v1
kind: Job
metadata: {name: foxwarm-import-ops}
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000}
      containers:
        - name: import
          image: registry.example.com/foxwarm-master:replace-with-release-tag
          args: [hosted, import, --profile, operator, --tenant, ops, --data-root, /source, --report, /master/import-reports/ops-import.json]
          env:
            - {name: FOXWARM_AGENTS_DIR, value: /master}
            - {name: FOXWARM_DATABASE_URL_FILE, value: /run/secrets/foxwarm/database-url}
            - {name: FOXWARM_KEK_FILE, value: /run/secrets/foxwarm/kek.json}
            - {name: FOXWARM_MIGRATE_DATABASE_URL_FILE, value: /run/secrets/import/migrate-database-url}
          volumeMounts:
            - {name: master, mountPath: /master}
            - {name: source, mountPath: /source, readOnly: true}
            - {name: config, mountPath: /etc/foxwarm, readOnly: true}
            - {name: runtime, mountPath: /run/secrets/foxwarm, readOnly: true}
            - {name: migration, mountPath: /run/secrets/import, readOnly: true}
      volumes:
        - {name: master, persistentVolumeClaim: {claimName: master-foxwarm-master-0}}
        - {name: source, persistentVolumeClaim: {claimName: operator-import-source, readOnly: true}}
        - name: config
          configMap: {name: foxwarm-deployment, items: [{key: master.yaml, path: deployment.yaml}]}
        - {name: runtime, secret: {secretName: foxwarm-runtime, defaultMode: 0440}}
        - {name: migration, secret: {secretName: foxwarm-import-owner, defaultMode: 0440}}
```

Wait for Job completion and read its import summary and report. Delete the completed Job before scaling the StatefulSet back to one. On Compose, start `foxwarm-master` again. Keep tenant traffic on the old routing configuration until the hostname step below is complete.

After a successful import, register the tenant's public hostname **before moving traffic** to the multi-tenant front. For example, to cut over the imported tenant `ops` to `ops.example.com`:

```sh
printf '%s\n' '{"primaryHostname":"ops.example.com"}' > hostname.json
foxwarm operator --url https://control.example.net --token-file operator.token tenant set ops hostname.json
foxwarm operator --url https://control.example.net --token-file operator.token tenant get ops
```

Check the returned `primaryHostname`, then direct traffic for it to the tenant front. If the import reports `activation-unknown`, inspect the tenant state and the numeric directory named by its ID before taking recovery action. An unacknowledged commit may already have activated the tenant.

If a full operator import failed after writing structured data, stop the import and run `foxwarm hosted import --profile operator --tenant <slug> --abandon`. Wait for the operator service to finish deleting it before importing again. Abandon leaves the source and any already published numeric directory intact.
