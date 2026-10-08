# Unit: WebUI logs view

Files: `packages/webui/src/components/LogsView.tsx`

## Purpose

Presents bounded logger history and a live tail through the authenticated host route.

## Behavior

The view keeps file reads bounded, supports approximate date navigation, and refreshes or tails without treating browser state as log authority.

## Tests

Logs route and browser fixtures cover bounded history, tail updates, and error states.
