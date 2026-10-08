# Unit: WebUI workbench

Files: `packages/webui/src/workbench/types.ts`, `packages/webui/src/workbench/utils.ts`, `packages/webui/src/components/WorkbenchPane.tsx`, `packages/webui/src/components/WorkbenchTabs.tsx`

## Purpose

Owns browser tab, pane, split, route, popup, and persistence presentation state for Chat, Agents, Search, Logs, Tasks, Setup, Terminal, and Code.

## Behavior

Workbench normalization accepts supported legacy tab forms while current writes use the active tab model. Popout URLs are versioned, deployment-relative, same-origin leaf routes; moving a terminal reattaches an existing PTY rather than deleting it. Setup may be forced and non-closable while onboarding is incomplete.

## Tests

Workbench persistence, tab lifecycle, popup, terminal reload, and error-boundary fixtures cover these paths.
