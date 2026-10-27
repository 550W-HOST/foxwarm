# Foxwarm Browser Node

Use your existing logged-in Chrome, Chromium, or Firefox tabs from Foxwarm. You choose which tabs or windows to share; the Agent can read pages, fill forms and capture a background tab while you use another tab. The Chrome manifest requires version 120 or newer; the CDP path was qualified with Chrome 145 on Linux. The Firefox package requires Firefox 153 or newer, where document-targeted injection and `userScripts.execute` are available. Firefox 153.0 and 158.0.1 were qualified with owned Linux profiles. These packages are development installations, not store distributions.

## Install and pair

1. In Foxwarm, open **Nodes → New nodes → Browser**. Select your browser, then download and extract Browser Node.
2. **Chrome/Chromium:** open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted directory. **Firefox 153+:** open `about:debugging` → **This Firefox** → **Load Temporary Add-on**, then select the extracted `manifest.json`. Firefox removes temporary installations at browser shutdown; load it again afterward. Persistent release/beta installation requires a Mozilla-signed package, which this delivery does not provide.
3. Open the extension popup. Copy the Main address and private pairing token from Browser setup, enter a Node name, and click **Connect**. The Main address includes any deployment path.
4. Approve the request in Foxwarm's **Pending approvals**. The extension reconnects with its own credential and discards the pairing token.
5. Share a tab or window with **Ask** or **Auto**. New installations share nothing.

Developers can load this source directory unpacked in Chrome without a build step. The runtime download at `node/browser-extension.zip` keeps the Chrome default; `node/browser-extension-firefox.zip` selects the Firefox manifest and page driver. Both contain only extension assets and no credentials; the pairing details require authenticated setup access.

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

## Firefox permissions and input

Firefox uses its module event-page background, document-targeted `scripting` and `userScripts` APIs, and explicit-tab `tabs.captureTab`. It does not require a debugger, a companion process or a remote-debugging server. The `<all_urls>` host permission is required for target-tab screenshots and DOM injection. Extension sharing remains the authority for Agent access; host permission alone shares no page.

Pin the extension icon to see the pending Ask count, then open its popup to review the Agent, Session, page and action. Firefox uses this badge and popup instead of OS notifications. It never opens or focuses the popup automatically. Allow/Deny, deadlines, navigation, moves, revocation and Stop settle requests and clear the badge.

Firefox `click` dispatches DOM activation with a synthetic mouse event, including supplied viewport coordinates. `fill` updates DOM values and dispatches synthetic input/change events. These are not trusted native input; applications that require trusted events may refuse them. Firefox does not advertise `press_key`, and direct attempts fail. Chrome retains native CDP input and its editing-key tool.

`execute_js` additionally needs the optional **Allow page JavaScript** permission, requested only when you click that button in the extension. Accept Firefox's permission prompt to enable it; **Remove JavaScript permission** revokes it. Basic reads, screenshots and form operations work without that optional grant. Scripts run directly in the admitted page's MAIN world, await Promises and use the same Ask/Auto policy. Site CSP is not relaxed, and an explicit call to page `eval` can still be blocked by CSP. Page scripts do not receive extension APIs or stored credentials. Firefox 140 ESR cannot provide this package's full API contract; no MV2 fallback is included.

## Tools and normal workflow

`list_tabs` → `get_tab_content` → `click` / `fill` / `select_option` / `scroll` → `wait_for` → read again. Chrome also supports `press_key`.

- Content formats are `snapshot` (default), `text` and `html`. Snapshots are bounded DOM summaries with opaque element refs, not the browser's native accessibility tree. Password values are omitted from ordinary content; fill approval previews and results do not echo entered text.
- Element actions accept a ref from the latest snapshot or a CSS selector matching exactly one element. Navigation/detach and a new snapshot invalidate old refs; obtain a fresh snapshot rather than guessing a selector.
- `screenshot` captures the target viewport without activating it. Coordinate `click` requires its `pageId` and viewport CSS-pixel coordinates.
- `open_tab` requires a shared `windowId` and opens inactive. Site/window rules determine the new tab's sharing. `navigate` reports sharing status; page identity and URL are returned while the destination remains shared. `close_tab` can close a window when it removes its last tab.
- `fill` supports text, search, email, URL, telephone, password and number inputs, textarea, and contenteditable elements. Native date/time and other unsupported input types are rejected before focus or value changes.
- A successful click (or Chrome editing key) reports the accepted action even when it follows a link or submits the page. Old references and pending requests still expire on navigation; obtain a fresh snapshot for the destination.
- `wait_for` has fixed element, visible-text and URL conditions and a bounded timeout. `execute_js` evaluates page-context JavaScript, awaits Promises and follows the same Ask/Auto rule. Explicit JavaScript can access sensitive page data; ordinary-content password omission is not a JavaScript sandbox.

You can leave a development Node selected and use `search_tools` with this Browser Node's ID, followed by an explicit `call_tool` target such as `node:my-browser/get_tab_content`. Node and Session authorization still applies. These tools operate your shared browser; the separate `browse_*` tools launch a process-owned browser.

The first version targets ordinary top-document HTTP(S) pages. It does not provide frame/OOPIF automation, cookie/network APIs, arbitrary CDP passthrough or browser-global shortcuts. Real logged-in sites and different OS/compositor states require their own qualification.

## Validation

`node --test packages/browser-node/test/*.test.mjs` covers protocol validation, screenshot envelopes, connection/credential lifecycle, sharing precedence and confirmation expiry. The existing disposable C# host harness runs the actual packaged MV3 extension in `packages/webui/test/mainHostBrowserNode.e2e.mjs`, including real model dispatch, background images in history, form operations, sharing races and Main Stop. Ordinary invocation is headless even when `DISPLAY` is inherited. The explicit `--owned-xvfb` test flag also exercises foreground OS typing and the actual Chrome debugging banner; use it only with a separately owned 1280×900 Xvfb display. No personal profile or installation state is used. The broader external-Node and original onboarding drivers retain their CLI and UI coverage, including browser package selection and prefixed links.

The explicit Firefox driver is `packages/webui/test/mainHostFirefoxNode.e2e.mjs`. Set `FOXWARM_FIREFOX` to an owned Firefox 153+ executable and `FOXWARM_GECKODRIVER` to geckodriver, then run it against the built current C# Main (or set `FOXWARM_PUBLISHED_CORE` to a prepared publish). Geckodriver is qualification tooling only, not an extension dependency. This test downloads both archives from the owned runtime, temporarily installs the Firefox archive, pairs/approves it, dispatches real model tools, checks strict-CSP JavaScript and optional permission changes, background PNG/image history, refs/forms/sharing/Ask/Stop, and leaves all extension pages closed for 65 seconds before repeating read/screenshot calls. It uses only disposable configuration, profiles and ports. `--remote-allow-system-access` is passed to that owned WebDriver profile only to automate extension and browser permission UI; production use needs no such flag.

For the owned headed qualification (Linux with Xvfb), run:

```sh
xvfb-run -a -s '-screen 0 1280x900x24 -nolisten tcp' node packages/webui/test/mainHostBrowserNode.e2e.mjs --owned-xvfb
```

The extension sends JSON ping every 25 seconds; the current C# Main replies with JSON pong. Alarms provide bounded reconnect wakeups and never override persisted Stop.
