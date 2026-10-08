# Unit: WebUI terminal view

Files: `packages/webui/src/components/TerminalView.tsx`, `packages/webui/test/popupMove.e2e.mjs`

## Purpose

Presents a browser terminal attached to a host-managed PTY identified by terminal, node, and working-directory state.

## Behavior

Terminal tabs restore only when the host reports a matching active terminal. Browser close and popup actions do not treat a terminal tab as a Session or silently delete a backend PTY.

## Tests

Terminal, popup, reload, and bounded navigation fixtures cover the supported client behavior.
