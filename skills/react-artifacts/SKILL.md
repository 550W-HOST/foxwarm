---
name: react-artifacts
description: Build interactive React demonstrations, algorithm animations, simulations and small visual explainers in an isolated WebUI preview. Prepares immutable interactive previews for inline prose placement or standalone reply cards.
---
# React artifacts

Use this for custom interactive demonstrations. For ordinary plots, prefer `data-visualization`.

## Workflow

1. Write a JSON manifest with `type:"react"`, `schemaVersion:1`, `title`, optional short `description`, `entry:"App.tsx"` and `files:{"App.tsx":"...source...","style.css":"..."}`.
2. Export a default React component from the entry. Import `react` hooks normally. Relative TS/TSX/JS/JSX/CSS/JSON imports must exist in `files`.
3. Discover `artifact` with `search_tools`; prepare with `{action:"prepare",filePath:"demo.json",node?}`. Put the exact returned `marker` on its own line at column 0 between blank lines, at the desired position in ordinary assistant prose. Put any short caption below it. Use `action:"publish"` instead for a separate reply-end card. `prepare` alone displays nothing.
4. Revise with the returned `artifactId` and explicit `expectedRevision`. Historical replies remain pinned to their version.

Up to 24 source files, 200,000 characters/file, 2 MiB/manifest. No filesystem paths outside the package. The runtime provides fixed React 18.3.1; arbitrary npm dependencies, remote imports and installation scripts are not supported. Do not include ReactDOM setup: the host mounts your default component.

## Runtime contract

The user starts the preview. It runs in opaque-origin sandbox frames without Foxwarm credentials or host APIs. The sandbox restricts ordinary resource loading, popups, forms, browser workers and nested frames, but it does not guarantee complete network isolation. Store interaction state in React memory. Stop/Reset and background-tab suspension discard that state; reopening begins from the initial state. Do not promise durable user edits.

Use inline SVG, HTML and CSS. Theme variables: `--artifact-bg`, `--artifact-text`, `--artifact-accent`, `--artifact-accent-text`. Design for a narrow phone and a resizable expanded view. Label controls and support keyboard input. Respect `prefers-reduced-motion`; use explicit Play/Pause, speed and Reset for animations. Clear intervals/animation frames on unmount. Avoid unbounded computation; this is a browser preview, not a secure compute service.

Do not ask the preview to execute tools, read files, access tokens or contact external services. Supply needed data in the source snapshot. The host shows compilation/runtime errors and permits source download.

## Example

[Sorting animation](examples/sorting.json) is a self-contained insertion-sort demonstration with play/pause, speed and reset. It uses synthetic numbers and no external assets. Use it to test the complete publish → Run → interact → expand → reopen path.

A complete inline reference loads the preview but never auto-runs React. Streaming more prose preserves the mounted preview; code fences, quotes, lists and user/tool text remain inert. `send_file` is separate file delivery, not inline placement.

Use `artifact({action:"get",artifactId})` to inspect the latest revision metadata, or add `revision` for a historical one. The returned marker can reference that exact revision again in this Session. This does not republish or change the content.
