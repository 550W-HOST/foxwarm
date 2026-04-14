# Foxwarm Browser Node

A Chrome/Firefox extension that connects your browser to a Foxwarm master as a remote node, allowing AI agents to browse, screenshot, and interact with web pages.

## Features

- **List tabs** — see all open tabs (filtered by permission)
- **Get page content** — accessibility tree, HTML, or text extraction
- **Screenshot** — capture visible tab as PNG
- **Click elements** — by CSS selector or coordinates
- **Execute JavaScript** — run code in any tab
- **Open/Close tabs** — manage browser tabs

## Permission Model

Each tab has one of three permission levels:

| Level | Behavior |
|-------|----------|
| **Off** | Tab is invisible to the agent, no operations allowed |
| **Ask** | Each tool call shows a confirmation popup — user must approve |
| **Auto** | Tool calls execute immediately without confirmation |

Permission resolution order: **Tab-specific** → **Domain rule** → **Default** (default: `ask`)

## Installation

### Chrome
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `packages/browser-node/` directory

### Firefox
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from the `packages/browser-node/` directory

## Setup

1. Click the extension icon to open the popup
2. Enter the Foxwarm master URL (e.g., `http://localhost:3001`)
3. Enter the pairing token (from `state/node_token` on the master)
4. Optionally set a node name
5. Click **Connect**
6. Approve the node on the Foxwarm master (WebUI or `/node pair approve`)
7. The extension will automatically reconnect with stored credentials

## Architecture

```
Background Service Worker
├── WebSocket connection (pairing/auth/reconnect/heartbeat)
├── Tool call dispatcher + permission checking
├── chrome.tabs / chrome.scripting API
└── chrome.storage for credentials & settings

Popup UI
├── Connection config & status
├── Tab permission management (off/ask/auto per tab/domain)
└── Tool call confirmation dialogs

Content Script (injected on-demand)
├── DOM accessibility tree extraction
└── Element interaction (click, etc.)
```

## Development

No build step required — plain ES modules, Manifest V3 compatible.

```bash
# The extension is at:
packages/browser-node/

# To test changes, reload the extension in chrome://extensions/
```

## Protocol

Uses the standard Foxwarm node WebSocket protocol:
- **Pairing**: `ws://host/node_ws?token=TOKEN` → `pair_request` → approval → credentials
- **Auth**: `ws://host/node_ws?id=ID&auth=AUTH` → `node_register` → `registered`
- **Tools**: `tool_call` → `tool_call_response` / `tool_call_error`
- **Heartbeat**: JSON ping/pong (browser WebSocket handles WS-level pong automatically)
