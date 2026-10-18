# Thread: Node-local Foxwarm data usage

## D-node-data-scope

[2026-10-18] Storage accounting covers each Node's local Foxwarm data only: runtime state, Agent workspaces, attachments/artifacts and temporary/cache files. Program installation/dependencies and arbitrary Session cwd/project directories are outside the scope. Master uses configured state/Agents roots; CLI uses its actual state directory and node-tool Agent root, including the single-Agent override. Standard `data/state` deployments also include their owned data root (logs, managed environments and older `data/agents` workspaces); workspace locations are keyed by full root/path so coexisting installations are not conflated. Scope is fixed by the runtime, never a browser-provided path.

Categories are disjoint, and workspace child rows reconcile to workspace/category totals. Roots and hard links are deduplicated. Nested symlinks are not followed. Metadata-only asynchronous scans have time/entry bounds; inaccessible or truncated scans are visibly partial lower bounds. Allocated file bytes are used where available, with an explicit logical-file-size fallback on Windows. This is not filesystem capacity, free-space monitoring or an atomic filesystem snapshot.

## D-node-data-presentation

[2026-10-18] Topology Node headers and Nodes cards share a compact Data entry. It opens a right-side storage drawer without replacing the Session inspector; mobile uses the full viewport. The drawer shows total, a thin category bar, category sizes and searchable Agent workspaces with paths and first-level breakdowns. No external workspace group is shown. Path copying does not grant new filesystem access.

Scans are on-demand and cached for five minutes, with one scan at a time and a 30-second manual-refresh throttle. Opening a view does not start a scan per heartbeat. Visible widgets poll progress; hidden/unmounted widgets stop polling. Offline Nodes can show the last sample and its timestamp; unsupported Nodes never masquerade as zero bytes. The bounded optional `foxwarm-data` v1 service requires no core protocol bump or automatic Node upgrade.

## Owners and checks

- [Storage service and scanner](../units/node-data-usage.md): fixed roots, scan bounds, service and administrator-only HTTP boundary.
- [WebUI storage](../units/webui-node-data.md): shared trigger, drawer, polling and formatting.
- Tests use temporary directories and synthetic UI data; no live Session creation or remote upgrade is needed.
