# Foxwarm Code Index

This is the entry point for the project map and repository-specific index conventions. The `code-index` skill (`skills/code-index/SKILL.md`) describes the general reading and maintenance method.

## Reading and changing the code

- Start with the entry relevant to the task. Use this overview for unfamiliar architecture; familiar work may start at a module, thread, or unit without traversing every layer.
- Identify the governing contracts and their rationale before choosing an implementation. Confirmed design decisions and supported compatibility contracts constrain changes; source and tests show actual behavior. Report a discrepancy rather than rewriting a contract to match an accidental implementation.
- For translation or replacement, trace the relevant original caller path from entry to observable effects and compare it with the new path. Index summaries and tests written only for the new implementation do not establish parity.
- Put important constraints and their rationale near the beginning of their owning page, before implementation detail. Each decision has one canonical owner; other pages provide a short summary and link. Unconfirmed proposals belong in `Open Questions`, not among effective decisions.

## Behavior entry points

For developers and Agents changing what a human or runtime Agent observes, start with the relevant behavior page, then follow its technical and test links:

- [Conversation and history](./behaviors/conversation-and-history.md): active context, Conversation, Archive, memory, deletion/clear, historical reading and accounting boundaries.
- [Execution and waiting](./behaviors/execution-and-waiting.md): process versus foreground-wait lifetime, Stop/Run queued/Continue, completion events, explicit waits and normal ToolScript completion.

These bounded pages own the product semantics they describe; they are not end-user manuals or a second implementation inventory. Threads retain cross-module mechanisms and invariants, modules retain subsystem boundaries, and units retain source/test entry points. For these topics, keep full observable rules at the behavior owner and use short links elsewhere; stable older decision anchors remain navigation points. Source and historical decisions still need checking when a change exposes uncertainty.

## Overview

Foxwarm is a multi-channel AI agent system that connects LLM providers to users through messaging adapters, terminal interfaces, and a browser UI. A master process owns sessions, context management, tool dispatch, and channel routing. Generic Nodes provide execution environments; production providers cover the colocated master, authenticated remote Nodes, and optional startup-configured executable-provider Nodes with provider-neutral lifecycle support when implemented.

The system uses a queue-driven session loop: inbound events are normalized by channels, routed to a session, processed serially, sent to an LLM, and continued through tool calls until a final response is broadcast. Long sessions remain usable through layered context compaction, archival, and semantic recall.

## Architecture

```text
Channels (messaging adapters, TUI, WebUI)
        |
        v
Message Router -> commands and side requests
        |
        v
Session Core (queue, lifecycle, persistence)
        |-- LLM providers and streaming
        |-- Tool dispatch and isolation checks
        |-- Context compaction, archive, and recall
        `-- ToolScript automation

Infrastructure (HTTP, config, timers, skills, terminal routing)
        |
Nodes, providers, and authenticated CLI Node runtime
```

## Project-wide principles

- **Channel abstraction:** platform adapters translate native protocols into one internal channel contract.
- **Serialized session work:** each session processes queued work in order and prevents concurrent turn loops.
- **Layered context:** archived raw messages and hierarchical summaries preserve recall while controlling model context size.
- **Unified tool resolution:** builtins, MCP tools, and node tools share discovery and dispatch surfaces; isolation checks remain enforced at execution boundaries.
- **Distributed execution:** Nodes expose environment capabilities through Main-owned provider resolution without becoming the source of session state; authenticated remote transport and the bounded executable protocol are provider implementations.
- **Indexed Main catalog:** identity/topology/list projections use the narrow Main-owned catalog boundary defined by [D-main-catalog-indexed-boundary](./threads/main-catalog-storage-and-indexed-queries.md#d-main-catalog-indexed-boundary).
- **Sandboxed automation:** ToolScript runs in a constrained VM and can suspend at safe host-call boundaries.

## Technology map

- Runtime: Node.js and TypeScript
- LLM providers: OpenAI-compatible APIs and Anthropic
- HTTP/WebSocket: Express and `ws`
- Frontend: React 18 and ReactDOM, Monaco, and xterm.js
- Storage: JSON/JSONL, SQLite, and LanceDB
- Automation: Puppeteer, MCP, ToolScript, and optional `node-pty`
- Configuration: YAML with targeted legacy-data readers

## Module index

| Module | Responsibility |
|---|---|
| [browser-node](./modules/browser-node.md) | Browser-extension node tools and per-tab/domain permission policy |
| [channels](./modules/channels.md) | Channel abstraction and concrete platform adapters |
| [cli-node](./modules/cli-node.md) | Remote node client, tool execution, and operator TUI |
| [infrastructure](./modules/infrastructure.md) | Bootstrap, HTTP, configuration, utilities, skills, timers, and terminals |
| [llm](./modules/llm.md) | Provider requests, prompt snapshots, streaming, retries, and MCP client |
| [message-routing](./modules/message-routing.md) | Inbound routing, commands, queue processing, and turn orchestration |
| [nodes](./modules/nodes.md) | Generic Node descriptors/providers plus authenticated remote pairing, transport, and services |
| [scripting](./modules/scripting.md) | ToolScript execution, persistence, suspension, and managed orchestration |
| [session-context](./modules/session-context.md) | Compaction, layered active history, archive, vector indexing, and recall |
| [session-core](./modules/session-core.md) | Session lifecycle, persistence, relations, channels, goals, and managed sessions |
| [shared-utilities](./modules/shared-utilities.md) | Cross-package patch, file, execution, formatting, and node-service utilities |
| [tools-and-permissions](./modules/tools-and-permissions.md) | Tool registry, dispatch, isolation checks, browser, file, and exec tools |
| [webui](./modules/webui.md) | Browser UI, chat, workbench, setup, terminal, and Code integration |
| [webui timeline](./modules/webui-timeline.md) | Timeline modes, pane-local Search, Reasoning presentation, Conversation, and Activity accounting |
| [project website](./modules/website.md) | Static homepage, focused user docs, installer downloads, and Pages artifact deployment |

## Thread index

| Thread | Flow |
|---|---|
| [Code integration](./threads/code-integration.md) | Optional official workbench, WebUI bridge, remote services, terminals, and read-only SCM |
| [context compaction and recall](./threads/context-compaction-and-recall.md) | Context budgeting, summarization, archival, and retrieval; entry and navigation |
| [context compaction](./threads/context-compaction.md) | Triggers, pruning, candidate policy, planner submission, block metadata, and completion markers |
| [compaction lifecycle](./threads/compaction-lifecycle.md) | Snapshot jobs, shared engine, ready-first scheduling, commit safety, cancellation, and busy windows |
| [archive and recall](./threads/archive-and-recall.md) | SQLite archive lineage, Vector indexing, semantic and lexical recall, WebUI expansion, and history search |
| [image blob lifecycle](./threads/image-blob-lifecycle.md) | Canonical image persistence, provider hydration, tools, and authenticated browser URLs |
| [canonical LLM request journal](./threads/llm-request-journal.md) | Content-addressed provider-neutral inputs, attempt provenance, reconstruction, and training boundary |
| [conditional memory snapshots](./threads/conditional-memory-snapshots.md) | Concrete-model memory filtering, snapshot identity, reuse, refresh, and detached ownership |
| [message processing pipeline](./threads/message-processing-pipeline.md) | Inbound message through LLM/tool loop to final broadcast |
| [Main catalog storage and indexed queries](./threads/main-catalog-storage-and-indexed-queries.md) | Main-owned identity/topology catalog, migration, indexed access, and bounded list boundaries |
| [model routing](./threads/model-routing.md) | Concrete/virtual selection, prefix hashing, failover health, attempts, and attribution |
| [node communication](./threads/node-communication.md) | Pairing, authentication, remote execution, services, and transfer |
| [process topology and RPC](./threads/process-topology-and-rpc.md) | Configurable local/child service placement and transport-neutral async contracts |
| [session lifecycle](./threads/session-lifecycle.md) | Creation, persistence, compaction, fork lineage, recovery, and deletion |
| [streaming pipeline](./threads/streaming-pipeline.md) | Provider deltas through session streams to WebUI rendering |
| [tool dispatch](./threads/tool-dispatch.md) | Builtin, MCP, and node tool resolution with isolation enforcement |

## Maintaining this index

### Scope and ownership

Keep final text in English and public-safe: no credentials, private deployment details, personal filesystem paths, or agent-private collaboration notes. Compatibility literals from source or persisted data may be quoted when necessary and identified as such.

For observable rules covered by the behavior pages above, use that behavior owner. For technical contracts, use the narrowest owner that covers a contract: a unit for one semantic unit, a module for several units in that subsystem, a thread for a cross-module flow, or this overview for a project-wide principle. Keep the full decision and rationale only there; use stable headings for links. A critical security, data-integrity, persistence, or external-contract invariant may repeat the same short sentence at an execution boundary with its canonical ID and link; rationale stays at the owner.

Distinguish observed behavior from required invariants. Compatibility notes describe retained persisted-data readers or external contracts, including the old shape read and the new shape written. Replace superseded decisions rather than keeping an implementation chronology.

Unit headers declare source ownership:

```text
Files: path/to/primary.ts, path/to/primary.test.ts
Secondary files: package.json, path/to/integration.test.ts
```

Each source file has at most one primary unit owner. Secondary references do not claim ownership; modules and threads link to units rather than declaring file ownership themselves.

### Targeted updates and checks

Update only changed contracts, responsibilities, and navigation. Keep useful entry points and stable-symbol references, not a prose inventory of every helper, branch, or test run. Update a parent or thread when its own boundary or flow changes, not merely because a child changed.

Remove stale, repeated, or incidental detail before splitting a page by responsibility. Preserve effective contracts and useful rationale; Git history retains superseded material. Do not regenerate the whole index for a local change.

Run from the repository root:

```bash
npm run quality:code-index
```

The audit checks links, primary file existence and ownership, public-safety patterns, English-only text, decision density, and likely duplicated decisions. Review warnings and resolve errors. Files above 24 KiB produce a size warning; files above 48 KiB produce an error. These are structural checks, not evidence of behavioral correctness or translation parity. The audit's own tests run with `npm run test:code-index-audit`.
