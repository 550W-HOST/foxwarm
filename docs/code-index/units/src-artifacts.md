# Unit: Main-owned artifact publication

Files: src/artifacts/tool.ts, src/artifacts/store.ts, src/artifacts/prepare.ts, src/artifacts/reactBuildWorker.ts, src/artifacts/reactCompiler.ts, src/artifacts/rasterMetadata.ts, src/artifacts/managedPrepare.ts, src/artifacts/routes.ts, src/artifacts/image.ts, src/artifacts/artifacts.test.ts, src/artifacts/artifactTools.test.ts
Secondary files: src/mainManagementToolService.ts, src/mainManagementTools.ts, src/tools.ts, src/tools/definitions.ts, src/tools/placement.ts, src/channels/webuiChannel.ts

## Purpose

Owns source ingestion, immutable persistent snapshots, module preparation and authenticated artifact retrieval. Canonical boundary: [interactive artifacts](../threads/webui-artifacts.md).

## Symbols

- `tool_artifact`: current-Session-only preparation/publication; checks read authorization, resolves Main real paths and isolated-agent boundary, or uses the existing authorized Node file-read service with a captured source CWD. Primitive Provider sources reject an oversized stat before reading and cap total ranged reads at the limit plus one byte to detect growth. Resident CLI sources retain their canonical approval/read and complete-transfer behavior; that legacy path still checks the artifact size only after the complete read. Returns a preparation reference without auto-display, or a display receipt after publication. Raster input uses verified original bytes and the same source authorization.
- `artifactStore`, `ArtifactStore.publish/read/resource/latestRevision`: Main state store, per-artifact serialization, expected-revision conflicts, type/owner invariants and atomic exclusive final-file linking. Content-addressed resources are complete before the revision link and verified on read; temporary files are removed on failure.
- `describeImage`: original raster magic/header, pixel/frame bounds and canonical sharp metadata operation; `image.ts` retains the Source preparation entry.
- `prepareArtifact`, `ArtifactPreparer`: registered preparation adapters; charts need no compilation.
- `reactBuildWorker`: a child-process compilation entry. Calls the Main `compileReact` operation with the fixed WebUI runtime root; virtual source import resolution plus trusted fixed React packages; no evaluation of artifact code. Parent bounds duration and output.
- `compileReact`, `rasterMetadata`: Main-only preparation shared by Source and managed data transports. Shared retains only dependency-independent artifact schemas/validators.
- `managedPrepare`: one bounded stdin/stdout data request per managed child, without Session, source-file or HTTP authority. `build:artifacts` compiles these three Main helpers from `tsconfig.artifacts.json` independently of the retained Source Main reference build.
- `registerArtifactRoutes`: Session-scoped metadata/resource routes, injectable store for tests, no-store JSON response and unavailable fallback without leaking private paths.

## Ownership and persistence

Publication runs through the existing Main-management RPC facade, including Session-worker reverse-source fencing, rather than creating Worker-local stores. The tool is discoverable, not injected by default. `node` selects the manifest source, not the owner of stored revisions. New revisions are never substituted for unavailable historical ones. The immutable store belongs in backups; active compaction must not delete it. No retention/GC endpoint exists in v1.

## Verification

`artifacts.test.ts` covers schemas, source imports, no execution, old snapshot preservation, concurrent revisions, ownership and HTTP scope. `artifactTools.test.ts` verifies direct/unified/ToolScript dispatch, the reverse-source fence and remote source CWD capture. The primitive ingestion regression uses honest 8 MiB manifest and 16 MiB image sources, read accounting, a growing source, denied read policy and a 193-character qualified Node ID. Tests use temporary data roots, never the live state store. The React compiler requires backend and WebUI dependencies to be installed.
