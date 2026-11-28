# Unit: Hosted master host

Files: `dotnet/Foxwarm/Hosted/Schema/Migrations/0006_operator_tenant.sql`, `dotnet/Foxwarm.Tests/Hosted/HostedStartupTests.MasterHost.cs`, `deploy/hosted/helm/foxwarm/templates/master.yaml`, `deploy/hosted/drills/master.mjs`, `deploy/hosted/drills/master-peer.py`
Secondary files: `dotnet/Foxwarm/Hosted/HostedDirectory.cs`, `dotnet/Foxwarm/Hosted/HostedBootstrap.cs`, `dotnet/Foxwarm/Hosted/HostedEntry.cs`


## D-hosted-master-host

The operator runs the installation's trusted Agents on a dedicated `master-host` replica. Master exec and file tools, Code, terminals, browser, Claude, stdio MCP and internal egress use the [operator capability profile](./hosted-capabilities.md#d-capability-profile). Main-local execution shares a security boundary with the deployment's keys and database credentials. Reserve that role and its volume for the operator.

- **Identity and placement.** Migration 0006 sets the pin on existing operator tenants. A check ties `profile = 'operator'` to `pinned_role = 'master-host'` in both directions. The `tenants_one_operator` partial unique index allows zero or one operator tenant in the database. [Placement and lease acquisition](./hosted-runtimes-host.md#d-hosted-placement) both require the explicit profile and pin; a general replica cannot serve that tenant, and the master host cannot take a hosted tenant. Change both fields in a single statement to move between profiles.
- **Files.** `FOXWARM_AGENTS_DIR` is required on a master host. Its value names an existing volume directory, resolved in filesystem order before opening any tenant files, and `<tenant_id>/` inside it is the physical Agents root. The operator's catalog, memory, skills and `FileAgentFiles` open that root. Structured Session state, configuration, credentials and blobs continue to use hosted storage. No `state/*.yaml` file is authoritative. The general profile uses the SQL Agent store and never opens the operator volume.
- **Restart and replacement.** The tenant ID survives a restart, so the operator reopens the same Agent folders. A different tenant ID selects a different folder even if the tenant slug is reused. Old directories are retained for explicit backup or cleanup. This includes a directory published just before a lost operator-import activation commit; abandoning the incomplete import never removes that published copy. The master host's per-tenant scratch area, including exec logs and local tool state, must also be on its persistent volume. Live processes (including PTYs) end with the pod.

## Deployment

The optional `master-host` Docker target reuses the full Linux toolchain and native Main, with the matching Code component supplied by the normal release pack. Compose's `master` profile and Helm's `masterHost.enabled` select the role. The master has a distinct workload selector, runtime credentials and mesh secret. Only the master mounts `/master`; its physical Agent roots and per-tenant scratch survive replacement. The single StatefulSet keeps the RWO claim when the pod or StatefulSet is deleted. Its cluster-internal headless Service provides the StatefulSet's network identity. General replicas keep ephemeral scratch and a minimal image.

## Tests

`PlacementRankTests` and `PlacementAcquisitionTests` cover the explicit pin, roles and profile changes serialized with lease acquisition. `HostedStartupTests` covers database uniqueness and pin constraints, missing volume configuration, opening physical Agent files on two consecutive boots, and keeping another tenant's physical files outside the catalog.

`deploy/hosted/drills/run.mjs --env process|compose --drills master` exercises the real operator turn on the master's listener. Master exec creates a file; Code opens the workbench and reads it; a Python stdio MCP server responds to a tool call. After a clean stop, a general replica refuses to acquire the operator. The replacement master acquires the next epoch and reads the same file while the ordinary tenant keeps serving on its original grant.
