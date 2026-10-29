# Behavior: configuration and activation

For developers and Agents changing Setup, configuration tools, or reload behavior. This page describes the current TypeScript Main installation path. Saving a file, publishing a live snapshot, updating a connection, and restarting a process are different outcomes; do not describe one as proof of all the others.

## Supported saves install a complete validated candidate

**Selected configuration contract; directly clarified for supported live saves.** Validate and persist the candidate before applying the affected runtime settings. Installer coordination implements that behavior while existing connections and in-flight work keep their separately defined lifetimes; file persistence and every downstream runtime effect are not one transaction.

WebUI Setup and `set_config` share one serialized Main-owned installer for `config`, `models`, and `tool-rules`. Setup supplies edited text or builds a candidate from a section form; the tool reads a complete regular-file candidate on Main. A tool candidate's location is not the active configuration location, and selecting a remote execution Node does not make that file a remote candidate; [operation placement](nodes-workspaces-and-permissions.md#selection-routes-operations-not-the-whole-session) remains independent.

The tool must be allowed by the current authorization policy both to install that target and to read the candidate through Main's file capability. Those checks run before reading and again at installation admission. A candidate cannot grant permission to install itself. Supported saves validate before replacement, retain the submitted bytes rather than redumping YAML, and replace the target through a synced same-directory temporary file. Schema-valid configuration is not proof that a provider credential works or an external service is reachable.

Section edits build their candidate only after earlier installations finish applying. This avoids a queued Channels edit rebuilding the app file from the version that existed before an earlier Config save. It is not a merge service for stale full documents from different editors.

| Entry/action | Replacement meaning |
| --- | --- |
| Raw Config or Models save; `set_config` candidate | Replaces that whole document. Comments and formatting in the candidate remain; an omitted setting is not silently recovered from an earlier editor's copy. |
| Channels or login-related channel update | Replaces the intended section using the latest file inside the installer lane, retaining unrelated app text/settings. |
| Retained structured Models input | Replaces the submitted provider set; omitted providers are removed. Submitted providers retain the latest supported overrides/custom fields, and top-level extension fields are preserved. It is not an additive provider patch. |
| Invalid candidate | No active file replacement or new live snapshot. Existing configuration remains. |
| Valid file saved, then a connection/channel cleanup fails | The new file stays saved. Report partial application, not a successful rollback or an unchanged file. |

Models Setup currently exposes raw YAML. Its local editor assistance is not an independent runtime validator. The canonical installation, merge, and validation contracts are [live installation](../units/src-config.md#d-config-live-install) and [Setup implementation](../units/webui-setup-view.md).

## Interpret the installation result by scope

The installer separates `saved`, `applied`, `notApplied`, and `restartRequired`. These are not four interchangeable success/failure spellings. In particular, a target can be saved and partly applied while other fields still need restart.

| Configuration | Current activation boundary | Important consequence |
| --- | --- | --- |
| `access.identities` through Setup/tool save | Publishes Main's live identity snapshot and fences affected transports, then awaits cleanup. | Later authentication uses the new snapshot; existing affected connections are handled too. Cleanup failure does not unpublish the snapshot. |
| Managed channel configuration through app save | Reloads managed channels through their lifecycle. | A channel can report a reload error while unrelated saved settings remain installed. This is not a generic hot-reload promise for every startup-created adapter. |
| Models file | Later model resolution reads the active file. | `applied: models` does not mean an already-dispatched or captured request was rebuilt. |
| Tool authorization rules | Installing Main invalidates its policy cache immediately; other processes use their own bounded caches. | A Worker can retain its prior successful policy until the first authorization after cache expiry. There is no global simultaneous policy-generation switch. |
| Other app settings, including listener binding, public URL, process placement, executable Provider definitions, and handoff-confirmation toggle | Startup-owned; changed fields are reported as restart-required. | Saving does not relocate services, launch a new listener, or alter startup constants in an existing process. |

Pending restart fields are compared against the actual startup configuration, not just the last saved file. Saving the same pending change again must not make its restart warning disappear. An MCP identity can be enabled live when an existing Main HTTP listener is available; without a listener it is saved with a restart requirement, not a promise that the installer starts a server. Detailed ownership stays in [configuration](../units/src-config.md#d-config-live-install).

For example, a valid app save changing an access scope and the HTTP port can apply the new scope now while leaving the old listener bound until restart. If affected-connection cleanup also fails, the result still describes the saved document and published identity snapshot, with incomplete connection application and a pending port restart. It must not collapse this into either “nothing changed” or “everything is active.”

## Connections and already-started work have different lifetimes

Revoking an identity, rotating its token, or withdrawing a surface affects its existing entry connections, not only new logins. WebUI scope changes fence affected WebSocket/SSE/scoped responses and remove revoked uploads; captured authentication is checked before later attachment/message effects. MCP changes fence/dispose affected contexts and close their SSE.

The affected set is surface-specific: changing only WebUI scope does not rebuild that identity's unrelated MCP context, selected Node, or cwd. Unchanged identities are not disconnected. These rules prevent a revoked connection from continuing to authorize new work without treating configuration as process cancellation.

Already-started commands are not killed, and durably accepted Session input is not withdrawn. A connection closing after [input admission](messages-and-turns.md#which-boundary-am-i-observing) therefore does not prove the message was rejected or undo what the Agent has done. Inspect the relevant committed state before repeating an uncertain operation. [Access identities](../units/src-access-config.md) owns authentication/fencing; [execution and waiting](execution-and-waiting.md) owns cancellation and command lifetime.

## Direct file edits do not invoke the installer

There is no general configuration file watcher. A successful filesystem write alone provides neither validation nor a live-application receipt. Different consumers have different read boundaries:

| Direct edit | Observable boundary |
| --- | --- |
| App configuration | Does not publish access changes or run managed-channel reload. Startup-owned values are read on restart; direct edits are not equivalent to a supported hot save. |
| Active models configuration | The next independent model resolution reads it. An invalid edit can fail later resolution; it is not automatically replaced with the previous good configuration. |
| Tool authorization file | Execution-time loaders can observe it after their successful-cache interval, currently ten seconds per process. After fresh read/parse and one retry fail, authorization fails closed rather than using stale good rules. |
| Memory or prompt files | Follow the separate [instruction-adoption boundaries](conversation-and-history.md#when-do-changed-instructions-reach-the-model), not installation activation or a general file watcher. |

Missing and malformed files are also different. A missing active models file can read the packaged template as a read-only fallback; that does not initialize a new mutable models file. The active location is always the data root's `state/models.yaml`, not an arbitrary app path override. Model syntax errors are not the missing-file fallback. Path and compatibility readers are owned by [configuration paths](../units/src-config.md#path-resolution).

Tool rules have their own narrow compatibility case: exact missing-file `ENOENT` means the compatibility empty policy, while parse, permission, and other I/O failures do not. Internal and external default authorization differ; absence must not be summarized as universal access. `set_config` avoids uncontrolled partial file writes but does not bypass the current policy. See [policy loading and failure](../units/src-tool-authorization.md#loading-and-failure-behavior).

## Requests adopt configuration at bounded points

Model saves affect later model resolution. A normal request captures a models snapshot, route generation, and requested effort; an ordinary reload does not replace that snapshot halfway through retries. An explicit raw model-selection change can be adopted at the normal owner's retry safe point, without retargeting the attempt already in flight. Later independent requests use the new file. These distinctions, effective-selection notices, and missing-key fallback are owned by [models and requests](models-and-requests.md#switching-takes-effect-at-an-adoption-boundary).

Tool permission changes are checked on newly executed calls, including subsequent ToolScript host calls; they are not a sweep cancelling earlier effects. Likewise, changing future-child defaults affects later creation, not existing children. Refreshing an available-model picker is presentation and does not itself change Session selection or cancel a request. The current Setup page refreshes its picker after Models save; no cross-window model-cache synchronization contract is implied.

## Change entry points and remaining limits

- `src/configInstaller.ts`, `src/tools/configTools.ts`, and `src/channels/webuiSetup.ts` connect entry points to validation, replacement, and application.
- `src/accessConfig.ts` and the transport consumers implement live snapshot/fencing; `src/toolAuthorization.ts` owns policy cache/failure behavior.
- `src/configHotApply.test.ts`, `src/configSectionSaves.test.ts`, and `src/configInstaller.test.ts` cover invalid candidates, partial application, startup-baseline warnings, and serialized section edits.
- [Prompt snapshots](../threads/conditional-memory-snapshots.md) and [persistence and recovery](persistence-and-recovery.md) explain adjacent state boundaries.

The installer is not a process orchestrator, cross-file configuration transaction, connection-effect rollback service, or conflict detector for multiple stale full-document editors. Those absent guarantees should remain explicit limitations, not be filled in by a new caller's assumptions. The known supported boundary is serialized installation through these entry points; arbitrary external writers do not join that lane.
