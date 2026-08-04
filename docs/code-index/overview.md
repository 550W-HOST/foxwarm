# Foxwarm Code Index

See [README.md](./README.md) for governance, canonical ownership, and publication rules.

## Overview

Foxwarm is a multi-channel AI agent system that connects LLM providers to users through messaging adapters, terminal interfaces, and a browser UI. A master process owns sessions, context management, tool dispatch, and channel routing. Optional remote nodes provide distributed file, shell, browser, Git, and terminal capabilities.

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
Remote Nodes and CLI Node runtime
```

## Project-wide principles

- **Channel abstraction:** platform adapters translate native protocols into one internal channel contract.
- **Serialized session work:** each session processes queued work in order and prevents concurrent turn loops.
- **Layered context:** archived raw messages and hierarchical summaries preserve recall while controlling model context size.
- **Unified tool resolution:** builtins, MCP tools, and node tools share discovery and dispatch surfaces; isolation checks remain enforced at execution boundaries.
- **Distributed execution:** authenticated nodes expose tools and versioned backend services without becoming the source of session state.
- **Sandboxed automation:** ToolScript runs in a constrained VM and can suspend at safe host-call boundaries.
- **Source-first documentation:** this index is a public-safe active map; source and tests remain authoritative.

## Technology map

- Runtime: Node.js and TypeScript
- LLM providers: OpenAI-compatible APIs and Anthropic
- HTTP/WebSocket: Express and `ws`
- Frontend: React-compatible Preact build, Monaco, and xterm.js
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
| [nodes](./modules/nodes.md) | Pairing, registry, authentication, and remote-node communication |
| [scripting](./modules/scripting.md) | ToolScript execution, persistence, suspension, and managed orchestration |
| [session-context](./modules/session-context.md) | Compaction, layered frontier, archive, vector indexing, and recall |
| [session-core](./modules/session-core.md) | Session lifecycle, persistence, relations, channels, goals, and managed sessions |
| [shared-utilities](./modules/shared-utilities.md) | Cross-package patch, file, execution, formatting, and node-service utilities |
| [tools-and-permissions](./modules/tools-and-permissions.md) | Tool registry, dispatch, isolation checks, browser, file, and exec tools |
| [webui](./modules/webui.md) | Browser UI, chat, workbench, setup, terminal, and Code integration |

## Thread index

| Thread | Flow |
|---|---|
| [Code integration](./threads/code-integration.md) | Optional official workbench, WebUI bridge, remote services, terminals, and read-only SCM |
| [context compaction and recall](./threads/context-compaction-and-recall.md) | Context budgeting, summarization, archival, and retrieval |
| [image blob lifecycle](./threads/image-blob-lifecycle.md) | Canonical image persistence, provider hydration, tools, and authenticated browser URLs |
| [canonical LLM request journal](./threads/llm-request-journal.md) | Content-addressed provider-neutral inputs, attempt provenance, reconstruction, and training boundary |
| [message processing pipeline](./threads/message-processing-pipeline.md) | Inbound message through LLM/tool loop to final broadcast |
| [model routing](./threads/model-routing.md) | Concrete/virtual selection, prefix hashing, failover health, attempts, and attribution |
| [node communication](./threads/node-communication.md) | Pairing, authentication, remote execution, services, and transfer |
| [process topology and RPC](./threads/process-topology-and-rpc.md) | Configurable local/child service placement and transport-neutral async contracts |
| [session lifecycle](./threads/session-lifecycle.md) | Creation, persistence, compaction, fork lineage, recovery, and deletion |
| [streaming pipeline](./threads/streaming-pipeline.md) | Provider deltas through session streams to WebUI rendering |
| [tool dispatch](./threads/tool-dispatch.md) | Builtin, MCP, and node tool resolution with isolation enforcement |
