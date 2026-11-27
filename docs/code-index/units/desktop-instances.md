# Unit: Desktop instances

Files: `dotnet/Foxwarm/DesktopInstances.cs`, `dotnet/Foxwarm/DesktopAuthCookie.cs`, `dotnet/Foxwarm.Desktop/DesktopWindow.Local.cs`, `dotnet/Foxwarm.Desktop/DesktopWindow.Instances.cs`, `dotnet/Foxwarm.Desktop.Mac/DesktopApplication.Local.cs`, `dotnet/Foxwarm.Desktop.Mac/DesktopApplication.Instances.cs`, `packages/webui/src/components/InstanceBrand.tsx`, `dotnet/Foxwarm.Tests/Channels/DesktopInstancesTests.cs`, `dotnet/Foxwarm.Tests/Channels/DesktopAuthCookieTests.cs`, `packages/webui/test/instanceBrand.test.mjs`
Secondary files: `dotnet/Foxwarm/DesktopNavigation.cs`, `dotnet/Foxwarm/MainHost.cs`, `dotnet/Foxwarm.Desktop/DesktopWindow.cs`, `dotnet/Foxwarm.Desktop/DesktopWebViews.cs`, `dotnet/Foxwarm.Desktop/DesktopFrame.cs`, `dotnet/Foxwarm.Desktop/DesktopNative.cs`, `dotnet/Foxwarm.Desktop/DesktopPopupWindow.cs`, `dotnet/Foxwarm.Desktop.Mac/DesktopApplication.cs`, `dotnet/Foxwarm.Desktop.Mac/DesktopFrame.cs`, `dotnet/Foxwarm.Desktop.Mac/DesktopPopupWindow.cs`, `dotnet/Foxwarm.Tests/Channels/DesktopNavigationTests.cs`, `packages/webui/src/components/Sidebar.tsx`, `packages/webui/src/windowFrame.ts`, `packages/webui/src/index.css`, `packages/webui/test/windowFrame.e2e.mjs`

## Purpose

The Windows and macOS Desktop apps switch between instances: the local instance, whose Main runs inside the app, and remote Foxwarm instances that the user adds by URL. For a remote the app is only a browser shell around that instance's own WebUI.

## Contract

### D-desktop-instances

[2026-11-23] User decisions.

- **Switching changes the URL the window loads.** The main window's web view navigates to the selected instance. One instance's page never calls another instance's API, so no cross-origin requests or CORS rules are involved. Each origin keeps its own cookies and login in the app's one WebView profile.
- **The host owns the list.** The instance list and the selection live in `desktop-settings.json` in the Desktop data directory (`FOXWARM_DATA_DIR` or the default Desktop data path), beside Main's `state/` and the web view profile and not in Main's configuration. `{ "selected": "local" | "<url>", "remotes": [{ "url": "<url>" }] }`; a missing or unreadable file selects the local instance, invalid entries are skipped, and writes replace the file through a temporary sibling. Pages can neither read nor change it.
- **The menu is native.** The host draws it: an `NSMenu` on macOS, a WinUI `Flyout` on Windows. Rows: **Local** (with a stop button while it runs), each remote labelled by host, port and base path (with a remove button, except on the current row), a separator, and **Add Remote Instance…** (Windows: sentence case). The current instance has a check mark. Adding asks for an address in a native dialog (`ContentDialog`, `NSAlert` sheet) and switches to it. `DesktopInstances.Normalize` accepts only HTTP(S) URLs without user information, drops the query and fragment and ends the path with `/`. Without a scheme, `localhost`, IP addresses and names without a dot get `http://`, others `https://`.
- **The brand row opens it.** In the WebUI, a click on the brand (`InstanceBrand`) sends one one-way message, `{ type: "instance-menu", anchor: [x, y, w, h] }` in viewport CSS px, and only when a host channel exists ([D-window-frame](./webui-window-frame.md#d-window-frame)). Without a channel (browsers, PWAs) the brand is a plain heading. The hosts open the menu below the rectangle, only while that window is the active or key window, and the page learns nothing back. `DesktopInstanceMenuRequest.Parse` accepts only that exact shape.
- **The brand shows the instance.** Browser, PWA and Desktop brand rows show the WebUI settings `tabIcon` and `instanceName` when set, each falling back on its own to the Foxwarm logo and name. After the macOS lights the default wordmark stays hidden, as the app name is in the menu bar; a configured name shows. [2026-11-24] User decision: after the macOS lights (`data-foxwarm-frame-leading`) a configured name that doesn't fit beside the icon at its full width is hidden instead of truncated, leaving the emoji (or the logo when none is set), and returns as soon as it fits again, for example in a wider sidebar. `InstanceBrand` measures the full name against the row's width beside its controls whenever the row, the brand, the name or those controls change size or fonts finish loading, and marks the heading `data-brand-overflow`; `index.css` then takes the name out of the flow and clips it, so it still names the button or heading for assistive technology and the freed width becomes drag chrome. Windows, browsers and frames without leading controls keep the truncated name.
- **Local starts on demand.** At launch, local Main starts only if the local instance is selected (also for the Windows `--tray` start). Selecting it later starts it. The stop button asks for confirmation with the number of Main-local Sessions with a running turn (`MainHost.RunningSessionCount`, an in-process call), then disposes Main through its ordinary drain. Interrupted turns resume at the next start through Main's existing busy recovery. While the local instance is selected and stopped, the window shows **The local instance is stopped.** with Start and Switch Instance.
- **Local Main holds the data directory.** Each start of local Main takes the [installation lock](./installation-lock.md) before reading configuration, and releases it after that `MainHost` is disposed, whether the start failed or local Main was stopped. A later start in the same process takes it again. A start refused because another process holds the directory reports that as the local start error.
- **Quit and single instance are unchanged.** Quit (Exit on Windows) closes the app windows, waits for a local start in progress and stops local Main if it runs. An administrative Main shutdown still ends the app; only the stop button stops Main without quitting. The per-user single-instance locks and second-start behaviour are unchanged.

### Scope

The selected instance is the app's scope: its origin plus its base path (`/` for the local instance, for example `/foxwarm/` for a remote behind a path prefix). `DesktopNavigation.IsApp` holds `<base>` without its slash and everything below `<base>/`, case-sensitively, but not a sibling such as `/foxwarm-other/`. [D-desktop-app-windows](./desktop-windows.md#d-desktop-app-windows) and [D-window-frame](./webui-window-frame.md#d-window-frame) apply to the scope rather than to the local origin: pages and new windows in it stay in the app, everything else goes to the default browser, and HTTP(S) loads outside it are blocked. The document-start frame state is installed only in top-level documents of the scope (`DesktopNavigation.ScopeCondition`), and both page messages are accepted only from them. A switch closes the previous instance's app windows, moves the scope (WebView2 resource filter and document script; WebKit content rules and user script) and then navigates. Deployment-relative WebUI paths keep working under a base path because the scope's own pages and resources are under it.

### Local sign-in cookie

Each start of local Main posts the token to its `/api/auth`, and the host then puts the sign-in cookie into the app's one web view profile (`DesktopAuthCookie`): `foxwarm_token` with the escaped token, the local endpoint's host and path, 365 days, HttpOnly, Secure only over HTTPS, and SameSite=Lax, the same SameSite value as the WebUI's own sign-in cookie ([webui-login](./webui-login.md)). Remote instances keep their own cookies on their own hosts; the host never touches them. [2026-11-24] Coordinator decision: Lax, not Strict, on both hosts. WebKit on macOS 26 withholds a Strict cookie from a client `loadRequest` issued while the view shows another site's document, which is every switch from a remote back to the local instance, so the local document request arrived without it and Main served the sign-in page. macOS 15's WebKit still sends it. Lax still keeps the cookie off cross-site subresource requests and POSTs.

### Fallback entries and failures

A remote whose WebUI predates the click message, or that does not load, has no brand row. The native entries always work: the **Instances** menu in the macOS menu bar, and on Windows **Ctrl+Shift+F1** and the tray menu's **Switch instance…**. Ctrl+Shift+F1 is a system hot key registered only while the main window is active (`DesktopNative.ActivateShortcut`), because the focused web view keeps key presses from XAML keyboard accelerators; another application may already own it, in which case the tray entry remains. It is bound by neither the WebUI (its own shortcuts and the terminal's Ctrl and Ctrl+Shift keys) nor Code's default keybindings, and on keyboards with AltGr it is not a character key.

When the main window's document fails to load (unreachable host, DNS, TLS, refused connection; a navigation replaced by another or refused by the policy does not count), the page is replaced by a native message: **lab.example/foxwarm could not be reached.** (local: **Foxwarm could not open.**) with Try Again and Switch Instance, the latter opening the menu below its button. A remote's HTTP error page is shown as the page; the fallback entries still reach the menu. A failed local start shows **Foxwarm could not start.** with the error, Try Again and Switch Instance; it is retried only on request.

## Function index

- `DesktopInstances.Load/Parse/Select/Add/Remove/ToJson` — the host settings file.
- `DesktopAuthCookie.For(endpoint, token, now)` — the local sign-in cookie's properties.
- `DesktopInstances.Normalize(input)`, `Label(url)`, `RunningSessionsText(count)` — typed URLs, menu labels, stop confirmation detail.
- `DesktopInstanceMenuRequest.Parse(json)` — the brand row's message.
- `DesktopNavigation.IsApp/InBasePath/ScopeCondition` — the scope.
- `MainHost.RunningSessionCount()` — Main-local Sessions with a running turn.
- Windows `DesktopWindow.SwitchAsync`, `EnsureLocalAsync`, `StopLocalAsync`, `OpenInstanceMenu`; macOS `DesktopApplication.SwitchAsync`, `EnsureLocalAsync`, `StopLocalAsync`, `FillInstancesMenu`, `InstanceMenuRow`.
- WebUI `InstanceBrand`, `brandNameOverflows(heading)`, `hasHostChannel()`, `requestInstanceMenu(anchor)`.

## Tests

- `DesktopInstancesTests.cs`: URL normalization and rejection, labels, settings round trip through the file (remove the selected remote selects local, no temporary file left), unusable settings, the stop confirmation counts, the menu message's exact schema against frame-region messages.
- `DesktopAuthCookieTests.cs`: the local sign-in cookie's name, escaped value, host, path, lifetime, Secure only over HTTPS, and SameSite=Lax.
- `DesktopNavigationTests.cs`: a remote scope with a base path (in, sibling paths, other scheme, port and case), its frame selection, and the document condition with escaping.
- `instanceBrand.test.mjs`: emoji and name or the logo and name, each field on its own, the button only with a host, and the message sent only through an existing top-level host channel.
- `windowFrame.e2e.mjs` brand-row cases: the browser shows the configured emoji and name as a plain heading, light and dark; under a Windows host the brand is a centred title-row button outside every drag rectangle, and one click sends exactly one `instance-menu` message with its rectangle; after the macOS lights the default shows the logo only and a configured instance its emoji and a name that fits, light and dark; a name that doesn't fit (with an emoji, and a long one with the logo) leaves the glyph alone in a button that still has the instance's accessible name, the freed width drags, and widening the sidebar brings the name back into the button until it is narrowed again; under Windows a long name stays truncated. Every case holds the region contract.

## Open questions

- Remote rows show their address, not the remote's own emoji and name; the host does not read pages.
- Host copy is English on both platforms, like the rest of the native shell; only the Windows installer is localized.
- Popup title rows keep the Foxwarm logo.
