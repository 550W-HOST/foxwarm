# Unit: Main-local browser and shared browser evaluation

Files: `dotnet/Foxwarm/Tools/MainBrowserTools.cs`, `dotnet/Foxwarm/Tools/MainBrowserDefinitions.cs`, `dotnet/Foxwarm.BrowserSupport/Foxwarm.BrowserSupport.csproj`, `dotnet/Foxwarm.BrowserSupport/AssemblyInfo.cs`, `dotnet/Foxwarm.BrowserSupport/BrowserEvaluation.cs`, `dotnet/Foxwarm.BrowserSupport/BrowserCloneJson.cs`, `dotnet/Foxwarm.Tests/Tools/ToolAuthorizationEffectsTests.Browser.cs`, `packages/webui/test/dotnetMainBrowser.e2e.mjs`

## Callers and ownership

`SessionToolExecutor.CreateRegistry` registers five Main `browse_*` Node capabilities with the existing Source Main descriptions and schemas. They are discoverable, not default-injected. Direct calls use the selected Node; unified and native ToolScript calls resolve through the same registry and authorization boundary. Explicit master targets retain master Node-effect facts and the actual caller-current Node. A selected remote uses its own advertised implementation, never this manager as a fallback.

`MainBrowserTools.Execute` adapts SDK failures into the existing local tool-error path. Its one browser, sequential `tab1`, `tab2`, … identities and insertion-ordered tab map belong to the Main process, not a Session or Agent. Lazy launch uses `/usr/bin/chromium`, headless and the six Source launch arguments. Existing pages and explicitly opened pages receive the new-document webdriver getter; opened pages receive the Source Windows Chrome/131 user agent and 1280×720 viewport. Only successfully navigated, explicitly opened pages enter the map. Failed effects have no rollback or recovery registry. Short collection locks protect concurrent Sessions; they do not serialize asynchronous browser effects into transactions.

`SessionManager.DisposeAsync` disposes the browser after normal turn drain. One Session Stop, closing the last tab, or changing selected Node does not close the process browser. Tabs do not survive Main restart. Pre-dispatch authorization and Stop fences remain in the existing executor; already-dispatched browser/file work has no new cancellation or reversal guarantee. There is no public close-all API.

## Main behavior

Open returns the Main string with tab ID, title and requested URL. List uses cached metadata and returns `No tabs open` when empty. Get returns body `innerText`, not CLI HTML. Only successful explicit goto refreshes requested URL/title; redirects, script changes, click/history/reload and get do not refresh the cache. Closing removes a tab after page close succeeds, never reuses its ID, and leaves the browser alive.

The eleven actions preserve Main strings and page/keyboard/navigation effects. Click swallows its post-click five-second navigation wait failure. Wait uses selector presence and a truthy timeout with a 5,000 ms fallback. Scroll uses relative y with zero fallback. Evaluate obtains the return-by-value clone and stringifies it in the host. Fill deliberately corrects Source's missing `Page.fill` call: set DOM value and dispatch bubbling input, not change or locator actionability. The process fixture preserves the actual Source failure separately from the corrected effect.

Truthy screenshot requests capture viewport PNG even for `full`. A slash-prefixed string performs Source's raw absolute filesystem write: overwrite is allowed, missing parents fail, and no Agent/cwd/home expansion, parent creation, resolved-path sidecar, ordinary write/export grant or rollback is added. Saved screenshots return a string and do not register an image. Other truthy requests return the Main inline image carrier; normal turn/image owners provide canonical identity, next-provider hydration, persistence, crop, export and delivery. Raw programmatic scalar results stay scalar; ordinary model/history projection wraps them as output.

## Exact isolated-Agent compatibility

These five explicit master capabilities alone bypass the generic bound-Node fence to reach normal generic policy and the existing exact isolated-Agent check. Default isolated denial remains. Only the persisted exact `node/master/browse_*` Agent allow can add that capability; generic allow alone is insufficient, and generic deny still wins. Selection/binding, master exec, structural restrictions, unrelated tools and ordinary scoped file/export authorities are unchanged.

The exact browser grant includes its raw screenshot-file write. Browser screenshot paths do not acquire ordinary file-path authorization facts or an own-Agent-directory restriction. This is a capability boundary, not OS/network isolation or a general isolation migration.

## Shared browser assembly

`Foxwarm.BrowserSupport` owns the single moved `BrowserEvaluation.StringifyResult` and `BrowserCloneJson` implementation and unchanged exact `PuppeteerSharp.Cdp [25.14.0]` dependency. Main and CLI consume it directly; neither imports the other's manager. The BCL-only NodePrimitives retains pure `JsonStringQuoting` and `EcmaNumber`, exposed to the narrow first-party assembly through existing friend access. Managers, launch policies, tabs, text/HTML, screenshots, results and lifetimes remain separate.

Host serialization preserves undefined/nonfinite/negative-zero/BigInt/circular/Date consequences, CDP property order and lone UTF-16 units. Mutable page JSON/prototype hooks do not become host serializers. The [CLI browser unit](./dotnet-cli-browser.md) owns unchanged dependency diagnostics and native/platform limits. Both consumers require an installed browser and matching OS libraries; neither downloads one. Main remains managed; this assembly does not introduce a Main Native AOT milestone.

## Validation

`ToolAuthorizationEffectsTests.Browser.cs` exercises actual Session authorization/visibility with precise grants, default denial, generic precedence, caller-current versus explicit master, unrelated bound-Node/exec/selection/structural restrictions, hidden model projection, discovery and natural scalar values.

`dotnetMainBrowser.e2e.mjs` owns normal Source and C# Main processes, model servers, pages, temporary data and authenticated remote client. It exercises discovery, direct/unified/ToolScript callers, Main strings/settings/IDs/cached metadata, real actions and errors, approved fill separately, viewport PNGs, raw writes, denied effects, exact isolated grants, image owners across restart, Stop and process lifetime. `dotnetCliNodeBrowser.e2e.mjs --shared-only` is the bounded changed-assembly native regression: actual evaluate corpus and both built-in ARIA delegate signatures, not a whole-runtime matrix.
