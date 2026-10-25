# Foxwarm Browser Node

Use your existing logged-in Chrome or Chromium tabs from Foxwarm. You choose which tabs or windows to share; the Agent can read pages, fill forms and capture a background tab while you use another tab. Chrome 120 or newer is required. This unpacked Manifest V3 extension is not a Chrome Web Store or Firefox distribution.

## Install and pair

1. In Foxwarm, open **Nodes → New nodes → Browser**. Download and extract Browser Node.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted directory containing `manifest.json`.
3. Open the extension popup. Copy the Main address and private pairing token from Browser setup, enter a Node name, and click **Connect**. The Main address includes any deployment path.
4. Approve the request in Foxwarm's **Pending approvals**. The extension reconnects with its own credential and discards the pairing token.
5. Share a tab or window with **Ask** or **Auto**. New installations share nothing.

Developers can load this source directory unpacked without a build step. The runtime download at `node/browser-extension.zip` contains only extension assets and no credentials; the pairing details require authenticated setup access.

## Sharing and control

- **Off** hides a tab's metadata and denies page operations. **Ask** shares basic tab metadata and asks before each page operation. **Auto** permits operations without a per-call prompt. Ask shows the requesting Agent, Session, page and action.
- The popup groups tabs by window. Sharing a window includes its current tabs, new tabs and tabs moved into it, including subsequent HTTP(S) origins. Moving out removes the window-derived grant.
- An explicit tab rule wins over a site rule, then a window rule; the fallback is Off. **Clear** removes a rule and restores inheritance. An explicit tab Off excludes it even inside a shared window.
- Positive direct-tab grants apply to the selected origin. Live tab/window grants use browser-session storage; closing the browser or reloading the extension clears them. Remembered hostname rules include subdomains and persist separately.
- **Stop** pauses connection and work until you explicitly Connect again. Network reconnects and alarms respect Stop. **Forget pairing** also removes credentials and the bootstrap token; entering a fresh pairing token and approving again is required. Removing the approved Node on Main revokes server-side trust.
- Changing the Main address, including its deployment path, clears the prior credential and requires pairing to that target.

## Chrome debugger permission

Page operations use one `chrome.debugger`/CDP adapter. Chrome displays its debugging banner while a shared page is attached. Pressing the banner's **Cancel**, or another unexpected debugger detach, stops Browser Node; it does not automatically reattach. Use the extension's Connect button to resume deliberately.

Debugger permission is broad. Sharing is enforced by the extension, not a Chrome per-window sandbox. No operation deliberately activates a tab or window. A snapshot and subsequent action retain their attachment; unsharing, stopping, disconnection or navigation invalidates old references. Human and Agent edits in the same tab can compete. DevTools, browser policy, dialogs and protected pages can interrupt operations.

## Tools and normal workflow

`list_tabs` → `get_tab_content` → `click` / `fill` / `select_option` / `press_key` / `scroll` → `wait_for` → read again.

- Content formats are `snapshot` (default), `text` and `html`. Snapshots are bounded DOM summaries with opaque element refs, not the browser's native accessibility tree. Password values are omitted from ordinary content; fill approval previews and results do not echo entered text.
- Element actions accept a ref from the latest snapshot or a CSS selector matching exactly one element. Navigation/detach and a new snapshot invalidate old refs; obtain a fresh snapshot rather than guessing a selector.
- `screenshot` captures the target viewport without activating it. Coordinate `click` requires its `pageId` and viewport CSS-pixel coordinates.
- `open_tab` requires a shared `windowId` and opens inactive. Site/window rules determine the new tab's sharing. `navigate` reports the resulting page identity and sharing; crossing an unshared origin does not disclose its content. `close_tab` can close a window when it removes its last tab.
- `wait_for` has fixed element, visible-text and URL conditions and a bounded timeout. `execute_js` evaluates page-context JavaScript, awaits Promises and follows the same Ask/Auto rule. Explicit JavaScript can access sensitive page data; ordinary-content password omission is not a JavaScript sandbox.

You can leave a development Node selected and use `search_tools` with this Browser Node's ID, followed by an explicit `call_tool` target such as `node:my-browser/get_tab_content`. Node and Session authorization still applies. These tools operate your shared browser; the separate `browse_*` tools launch a process-owned browser.

The first version targets ordinary top-document HTTP(S) pages. It does not provide frame/OOPIF automation, cookie/network APIs, arbitrary CDP passthrough or browser-global shortcuts. Real logged-in sites and different OS/compositor states require their own qualification.

## Validation

`node --test packages/browser-node/test/*.test.mjs` covers protocol validation, screenshot envelopes, connection/credential lifecycle, sharing precedence and confirmation expiry. The existing disposable C# host harness runs the actual packaged MV3 extension in `packages/webui/test/experimentHostBrowserNode.e2e.mjs`, including real model dispatch, background images in history, form operations, sharing races and Main Stop. With an owned 1280×900 Xvfb display it also exercises foreground OS typing and the actual Chrome debugging banner. No personal profile or installation state is used. The broader external-Node and original onboarding drivers retain their CLI and UI coverage.

The extension sends JSON ping every 25 seconds; the current C# Main replies with JSON pong. Alarms provide bounded reconnect wakeups and never override persisted Stop.
