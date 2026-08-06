# Android Node

Experimental Android remote node for Foxwarm.

This package currently supports one practical workflow:

- run `server.py` on the host machine
- connect to a real Android device over **ADB**
- optionally register the node into Foxwarm over `/node_ws`

Everything else from the older docs was stale and has been removed.

## What it can do

Current tools exposed by `server.py`:

- `android_tap`
- `android_swipe`
- `android_input`
- `android_screenshot` (supports `inline=true`, which always returns JPEG quality 80)
- `android_get_ui_tree`
- `android_list_elements`
- `android_unlock` (numeric PIN only)
- `android_keyevent`
- `android_current_app`
- `android_launch_app`
- `android_stop_app`

## Requirements

Host:
- Python 3.8+
- `adb`

Phone:
- Developer options enabled
- USB debugging enabled
- USB authorization accepted for this computer

Check connection first:

```bash
adb devices -l
```

Expected state is `device`, not `unauthorized`.

---

## Setup

From repo root:

```bash
cd packages/android-node
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

If `adb devices` only works under `sudo`, fix host permissions first or temporarily run adb-related checks with sudo.

---

## Mode 1: standalone test

Start the server:

```bash
cd packages/android-node
. .venv/bin/activate
python server.py
```

This starts:

- HTTP: `http://localhost:8765`
- WebSocket: `ws://localhost:8766`

Run the built-in test script in another shell:

```bash
cd packages/android-node
. .venv/bin/activate
python test.py
```

What `test.py` currently exercises:
- screenshot
- UI tree dump
- tap
- swipe
- text input

`android_unlock` is not covered by `test.py`; validate it on a real test device.

---

## Mode 2: dynamic registration into foxwarm (pairing-based auth)

The current backend no longer allows direct `?token=...&id=...` registration.
Android node now follows the same pairing-based flow as the shared node client:

1. connect with the pairing token
2. create a pending pairing request
3. approve it from foxwarm with `/node approve ...`
4. store per-node credentials locally
5. reconnect with `?id=...&auth=...`

### Recommended env vars

```bash
cd packages/android-node
. .venv/bin/activate
export FOXWARM_HOST="http://localhost:3002"
export FOXWARM_NODE_TOKEN="$(cat ../../test/state/node_token)"
export FOXWARM_NODE_ID="android-e2e"
export FOXWARM_NODE_CREDENTIALS_FILE="./node_credentials.json"
python server.py
```

Typical first-run log now looks like:

```text
🚀 Starting in foxwarm pairing/auth mode
Sending pair request...
⏳ Pairing pending approval: pendingId=... pairCode=... requested=android-e2e
```

Then approve it from foxwarm:

```text
/node
/node approve <pending-id> android-e2e
```

After approval, the node stores credentials in `node_credentials.json` and reconnects automatically. A successful post-approval log looks like:

```text
✅ Pairing approved for node: android-e2e
Sending node registration...
✅ Successfully registered as node: android-e2e
```

Then from a Foxwarm session, use:
- `remote_node(action="list")`
- `remote_node(action="call", nodeId="...", tool="android_screenshot", args={"inline": true})`
- `remote_node(action="call", nodeId="...", tool="android_list_elements", args={"clickableOnly": true})`
- `remote_node(action="call", nodeId="...", tool="android_unlock", args={"pin": "0000"})`
- `remote_node(action="call", nodeId="...", tool="android_keyevent", args={"keycode": 3})`
- `remote_node(action="call", nodeId="...", tool="android_current_app", args={})`
- `remote_node(action="call", nodeId="...", tool="android_launch_app", args={"packageName": "com.android.settings"})`
- `remote_node(action="call", nodeId="...", tool="android_stop_app", args={"packageName": "com.android.settings"})`

---

## Known-good test flow

This is the flow that has actually been exercised on a real Android device:

1. `adb devices -l`
2. `python server.py` in standalone mode
3. `python test.py`
4. restart `server.py` with `FOXWARM_HOST=http://localhost:3002` and `FOXWARM_NODE_TOKEN=...`
5. from a Foxwarm test session, call:
   - `remote_node(list)`
   - `remote_node(call -> android_screenshot)`
   - `remote_node(call -> android_unlock)`
   - `remote_node(call -> android_keyevent)`

A real screenshot file was successfully produced through the remote-node path during testing.

---

## Notes / limits

- This package is still experimental.
- Current docs only describe the ADB host-run workflow because that is the path that has actually been tested.
- Pairing credentials use the same JSON shape as the shared node client: `nodeId`, `authToken`, `pairedAt`.
- Do not rely on the deleted older markdown files; they were stale.
- If you need richer device control (for example dedicated unlock / keyevent helpers), add explicit tools rather than relying on undocumented behavior.
