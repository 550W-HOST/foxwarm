# Unit: Desktop instances

Files: `dotnet/Foxwarm/DesktopInstances.cs`, `dotnet/Foxwarm.Desktop/DesktopWindow.Local.cs`, `dotnet/Foxwarm.Desktop/DesktopWindow.Instances.cs`, `dotnet/Foxwarm.Desktop.Mac/DesktopApplication.Local.cs`, `dotnet/Foxwarm.Desktop.Mac/DesktopApplication.Instances.cs`, `packages/webui/src/components/InstanceBrand.tsx`, `dotnet/Foxwarm.Tests/Channels/DesktopInstancesTests.cs`, `packages/webui/test/instanceBrand.test.mjs`
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
- **The brand shows the instance.** Browser, PWA and Desktop brand rows show the WebUI settings `tabIcon` and `instanceName` when set, each falling back on its own to the Foxwarm logo and name. After the macOS lights the default wordmark stays hidden, as the app name is in the menu bar; a configured name shows.
- **Local starts on demand.** At launch, local Main starts only if the local instance is selected (also for the Windows `--tray` start). Selecting it later starts it. The stop button asks for confirmation with the number of Main-local Sessions with a running turn (`MainHost.RunningSessionCount`, an in-process call), then disposes Main through its ordinary drain. Interrupted turns resume at the next start through Main's existing busy recovery. While the local instance is selected and stopped, the window shows **The local instance is stopped.** with Start and Switch Instance.
- **Quit and single instance are unchanged.** Quit (Exit on Windows) closes the app windows, waits for a local start in progress and stops local Main if it runs. An administrative Main shutdown still ends the app; only the stop button stops Main without quitting. The per-user single-instance locks and second-start behaviour are unchanged.

### Scope

The selected instance is the app's scope: its origin plus its base path (`/` for the local instance, for example `/foxwarm/` for a remote behind a path prefix). `DesktopNavigation.IsApp` holds `<base>` without its slash and everything below `<base>/`, case-sensitively, but not a sibling such as `/foxwarm-other/`. [D-desktop-app-windows](./host-runtime.md#d-desktop-app-windows) and [D-window-frame](./webui-window-frame.md#d-window-frame) apply to the scope rather than to the local origin: pages and new windows in it stay in the app, everything else goes to the default browser, and HTTP(S) loads outside it are blocked. The document-start frame state is installed only in top-level documents of the scope (`DesktopNavigation.ScopeCondition`), and both page messages are accepted only from them. A switch closes the previous instance's app windows, moves the scope (WebView2 resource filter and document script; WebKit content rules and user script) and then navigates. Deployment-relative WebUI paths keep working under a base path because the scope's own pages and resources are under it.

### Fallback entries and failures

A remote whose WebUI predates the click message, or that does not load, has no brand row. The native entries always work: the **Instances** menu in the macOS menu bar, and on Windows **Ctrl+Shift+F1** and the tray menu's **Switch instance…**. Ctrl+Shift+F1 is bound by neither the WebUI (its own shortcuts and the terminal's Ctrl and Ctrl+Shift keys) nor Code's default keybindings, and on keyboards with AltGr it is not a character key.

When the main window's document fails to load (unreachable host, DNS, TLS, refused connection; a navigation replaced by another or refused by the policy does not count), the page is replaced by a native message: **lab.example/foxwarm could not be reached.** (local: **Foxwarm could not open.**) with Try Again and Switch Instance, the latter opening the menu below its button. A remote's HTTP error page is shown as the page; the fallback entries still reach the menu. A failed local start shows **Foxwarm could not start.** with the error, Try Again and Switch Instance; it is retried only on request.

## Function index

- `DesktopInstances.Load/Parse/Select/Add/Remove/ToJson` — the host settings file.
- `DesktopInstances.Normalize(input)`, `Label(url)`, `RunningSessionsText(count)` — typed URLs, menu labels, stop confirmation detail.
- `DesktopInstanceMenuRequest.Parse(json)` — the brand row's message.
- `DesktopNavigation.IsApp/InBasePath/ScopeCondition` — the scope.
- `MainHost.RunningSessionCount()` — Main-local Sessions with a running turn.
- Windows `DesktopWindow.SwitchAsync`, `EnsureLocalAsync`, `StopLocalAsync`, `OpenInstanceMenu`; macOS `DesktopApplication.SwitchAsync`, `EnsureLocalAsync`, `StopLocalAsync`, `FillInstancesMenu`, `InstanceMenuRow`.
- WebUI `InstanceBrand`, `hasHostChannel()`, `requestInstanceMenu(anchor)`.

## Tests

- `DesktopInstancesTests.cs`: URL normalization and rejection, labels, settings round trip through the file (remove the selected remote selects local, no temporary file left), unusable settings, the stop confirmation counts, the menu message's exact schema against frame-region messages.
- `DesktopNavigationTests.cs`: a remote scope with a base path (in, sibling paths, other scheme, port and case), its frame selection, and the document condition with escaping.
- `instanceBrand.test.mjs`: emoji and name or the logo and name, each field on its own, the button only with a host, and the message sent only through an existing top-level host channel.
- `windowFrame.e2e.mjs` brand-row cases: the browser shows the configured emoji and name as a plain heading, light and dark; under a Windows host the brand is a centred title-row button outside every drag rectangle, and one click sends exactly one `instance-menu` message with its rectangle; after the macOS lights the default shows the logo only and a configured instance its emoji and name.

## Open questions

- Remote rows show their address, not the remote's own emoji and name; the host does not read pages.
- Host copy is English on both platforms, like the rest of the native shell; only the Windows installer is localized.
- Popup title rows keep the Foxwarm logo.
