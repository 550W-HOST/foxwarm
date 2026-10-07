# Unit: Android-compatible Python Node

Files: `packages/android-node/node_auth.py`, `packages/android-node/server.py`, `packages/android-node/requirements.txt`, `packages/android-node/README.md`, `packages/android-node/test_node_auth.py`, `packages/android-node/test.py`

## Purpose

Provides the Python Node server and authentication helpers used by the Android-compatible deployment surface.

## Stable symbols and callers

`server.py` owns the Node HTTP/WebSocket service and capability dispatch; `node_auth.py` owns pairing/auth token validation; the two Python tests exercise the boundary.

## Behavior and side effects

This is a remote Node/service boundary, not a .NET Session store. Keep authentication and protocol compatibility aligned with `packages/shared` and do not imply that the .NET host has replaced this runtime.

## Tests

`test_node_auth.py`; `test.py`.
