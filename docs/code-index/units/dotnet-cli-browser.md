# Unit: .NET CLI browser adapter

Files: `dotnet/Foxwarm.CliNode/NodeBrowserTools.cs`, `packages/webui/test/dotnetCliNodeBrowser.e2e.mjs`, `packages/webui/test/dotnetCliNodeBrowserMain.e2e.mjs`

## Purpose and caller paths

The [headless CLI Node](./dotnet-cli-node.md) dispatches Session `browse_*` calls here after its ordinary owner split. `Execute` owns tool results; `EnsureBrowser` launches lazily; `StringifyResult` preserves JS clone/stringification semantics; `DisposeAsync` closes the process-owned browser only at final CLI shutdown. NodePrimitives and Main do not reference this browser package or import its manager.

## Behavior, dependency and image boundary

`NodeBrowserTools` owns one browser and insertion-ordered tab map per CLI process, not per Session or Agent. Launch is lazy, with `PUPPETEER_EXECUTABLE_PATH`, then `CHROME_PATH`, then the Source literal `/usr/bin/chromium-browser`; no BrowserFetcher or implicit download is used. Transport reconnect retains tabs. Final CLI disposal closes its browser without killing independent persistent execs.

Open and goto cache the requested URL; get refreshes URL/title and returns HTML unless a screenshot is requested; list reads cached metadata. Only exact `full` requests full-page PNG. Other truthy screenshot values produce viewport PNG and never write a supplied path. Click precedes the swallowed post-click navigation wait; fill sets DOM value and emits bubbling input, not change. Evaluate preserves Puppeteer's return-by-value clone followed by JavaScript JSON.stringify, including undefined, nonfinite, Date and circular-result consequences. Main's separate local browser wrappers and screenshot-file/body-text policies are not implemented or redefined here.

CLI screenshot replies carry bytes only. Ordinary Main discovery and `call_tool` dispatch keep policy, Session image registration, canonical blob references, provider hydration, crop/export, remote read and file delivery in their existing owners. Browser tools are discoverable Node capabilities, not default-injected tool definitions. Persistence/history retain canonical references rather than inline screenshot blobs.

The exact package pin is `PuppeteerSharp.Cdp [25.14.0]`, confined to CLI rather than NodePrimitives/Main. Native publication emits seven IL2026, seven IL3050, two IL2075 and one IL3000 upstream diagnostics; none are suppressed. The package's generated resolver and fixed JSON DOM/DTO callers bound the serializer paths. Actual native single-ARIA and compound query-all selectors qualify both built-in delegate result signatures for this graph; retain these cases when dependencies/compiler/graph change. Arbitrary CLR callbacks/DTOs and future WebMCP events are not qualified. Explicit executable selection bypasses the warned BrowserFetcher location branch.

`dotnetCliNodeBrowser.e2e.mjs` compares real Source and managed/native process effects for all five tools/eleven actions, screenshots, JS values, metadata, reconnect and missing/last-tab lifetime. `dotnetCliNodeBrowserMain.e2e.mjs` uses normal Source and C# Main model turns with the actual CLI, then proves next-request images, canonical history, crop/read/export/delivery and retained identity after an owned Main restart. The qualified Linux host browser is Chromium 145.0.7632.109 with an explicit executable; this does not qualify package-default Chromium 155, other platforms or a browser-equipped no-CLR container. Native process maps contain no CLR, and browser work needs no Node/Python implementation driver; Chromium and its real OS libraries remain prerequisites.

