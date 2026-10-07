# Unit: Terminal view and virtual keyboard

Files: `packages/webui/src/components/TerminalView.tsx`, `packages/webui/src/components/TerminalVirtualKeyboard.css`, `packages/webui/src/components/TerminalVirtualKeyboard.tsx`, `packages/webui/src/terminalPinchZoom.ts`, `packages/webui/src/terminalTarget.ts`, `packages/webui/src/terminalVirtualKeyboard.ts`

## Purpose

Renders terminal sessions and adapts touch/keyboard/zoom behavior to the host terminal route.

## Stable symbols and callers

`TerminalView`; virtual keyboard/target/zoom helpers.

Callers and boundary: Host `WebUIChannel.Terminal` and `TerminalRegistry` routes.

## Behavior and side effects

`TerminalView` subscribes to authenticated PTY events, sends bounded input/resize/close operations, and reconciles exit/error revisions. Touch zoom, target selection, and virtual keyboard helpers only alter client transport/presentation; terminal process state remains owned by the host registry.

## Tests

Terminal stream/view and virtual-keyboard tests.
