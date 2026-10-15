# Unit: WebUI fox loaders

Files: packages/webui/src/components/FoxLoaders.tsx, packages/webui/src/components/FoxLoaders.css, packages/webui/src/components/FoxThinkingText.tsx, packages/webui/test/foxThinkingText.e2e.mjs, packages/webui/src/components/foxDrawing.json, packages/webui/src/components/FoxLoaderPreview.tsx, packages/webui/src/boot.ts, packages/webui/src/boot.css, packages/webui/src/bootTypes.d.ts, packages/webui/build/bootHtml.ts, packages/webui/test/htmlBoot.e2e.mjs
Secondary files: packages/webui/src/index.css, packages/webui/tsconfig.node.json, packages/webui/index.html, packages/webui/vite.config.ts, packages/webui/src/main.tsx, packages/webui/src/App.tsx, packages/webui/src/components/ProcessingStatus.tsx, packages/webui/test/processingStatus.test.mjs, packages/webui/test/foxLoaderPreview.e2e.mjs

## Purpose

Theme-aware inline SVG loaders for HTML startup, lazy workbench views, and ordinary model thinking. Loader CSS is included by the application stylesheet, so standalone source fixtures can consume that built stylesheet without a separate component-CSS bundle. The sleeping fox uses the semantic accent rather than a hard-coded theme palette.

## Public symbols

- `FoxThinkingText` — decorative thinking/exec caption pools with a stable accessible label, measured inline width and a masked phrase wipe.
- `FoxCub` — draw-in/sleeping fox illustration; the static form suppresses motion.
- `FoxSpinner`, `FoxThinking`, `FoxPaneLoader` — spinner forms for small status rows and lazy view fallbacks.
- `markBootReady`, `BootReadySignal` — React adapters to the HTML-owned startup readiness gate.
- `FoxSplashScreen` — presentational screen for the independent Appearance demo, not a second startup lifecycle.
- `FoxLoaderPreview` — Appearance preview controls for replaying the illustration and inspecting loader sizes or a full-screen splash.
- `bootHtmlPlugin`, `renderBootHtml` — build/dev HTML transform; inline the SVG, loader/recovery CSS, and a bundled ordinary script before external module execution.
- `window.foxwarmBoot.ready/fail` — page-local readiness and failure callbacks shared by the inline bootstrap and React entry/root boundary.

## Behavior

- The HTML owns a visible startup illustration before React or any external JavaScript, stylesheet, or font loads. The build hook reuses the same SVG geometry and loader CSS as the React illustrations; generated output is not a separately maintained palette or animation source.
- The inline script resolves colors through the real theme selection, built-in registry, and strict custom manifest validator. It projects canvas, accent, text, and filled-accent foreground only. The complete theme runtime still initializes before React and owns subsequent theme changes. No extra persisted palette cache or custom-manifest migration is introduced.
- Initial HTML stylesheet links load with non-applying media so they cannot block the inline screen’s first paint. The inline load handler enables each sheet without changing document/cascade order; content readiness waits for these actual sheets too. The app root remains hidden until that readiness gate completes, including in popup/embedded roots, avoiding an unstyled reveal. There is no general resource manager or timeout.
- Startup waits for both content/style readiness and the 1500ms minimum draw-in interval, then leaves for 480ms and removes its DOM node. The inline controller retains the detached node for recovery after startup. `main.tsx` signals readiness only after authentication and the selected root's real mount; authentication failure also signals readiness so loading cannot obscure the sign-in recovery link. Entry execution or `window.load` is not readiness.
- Readiness is idempotent during a page load. Reduced motion skips the minimum and fade wait and disables SVG motion. The leaving screen becomes transparent, hidden, and pointer-inert before removal. Escape cannot dismiss startup.
- Strict popup/embedded target parsers are reused by the inline script. Valid leaf roots have no full-screen startup animation or minimum delay, but resource failures still expose the recovery screen.
- Before readiness, captured module-script, module-preload, and stylesheet resource errors plus uncaught execution errors display recovery. The React root boundary covers uncaught root/lazy-render failures. Vite's `vite:preloadError` remains observed after startup. Before real content mounts it uses full-screen recovery; after `contentReady` it uses a dismissible non-modal notice with the original error and Reload, preserving an already usable app or supported local fallback. If initial CSS is still pending, that notice waits for the same startup gate to complete rather than blocking readiness. Entry stylesheet failures and uncaught root render failures remain fatal full-screen errors, irrespective of a mounted root. These handlers preserve ordinary console/error propagation and do not prevent Vite's default throw.
- Recovery displays the original available error message as text, never HTML, with an explicit Reload button. Later resource notices can also be dismissed without changing application or local fallback state. There is no automatic reload, local-data reset, startup timeout, or global interpretation of ordinary fetch/API rejection as boot failure. Startup-only global error listeners are removed on readiness; the specific Vite module-load listener remains.
- Ordinary requesting-model and actual exec status use a 24px fox with 18px decorative captions. Phrases change every 5–7 seconds; a 450ms masked wipe and measured-width transition keep Stop adjacent without moving the text baseline. Mode changes restart the matching phrase pool, and unmount clears timers/width observation. Reduced motion removes the wipe/width animation, not the stable accessible runtime label. Compaction, other tool indicators and static waiting retain their runtime semantics. Timeline loading uses the accessible Loading label; lazy view fallback uses a centered status loader.
- Appearance previews have no live Session operations. They consume the active theme accent; the presentational full-screen preview closes on click or Escape and returns focus to its Full screen control. Its keyboard listener exists only while that manual preview is open; it cannot dismiss the real startup splash or drive the application boot gate.

## Verification

`htmlBoot.e2e.mjs` serves the production HTML and assets over HTTP under a deployment prefix. Browser request blocking, actual entry/static-dependency/lazy-root 404s, held render-blocking CSS with a first-paint assertion, delayed auth/root delivery, auth recovery, safe execution-error text, representative built-in/custom/Auto/fallback selections, and popup/embed failures exercise the real startup path. A small Vite-built two-version fixture verifies old HTML against only new hashed assets and an already-running old page importing a removed asynchronous chunk after readiness, including continued interaction beneath the non-modal notice. A caught module failure while entry CSS is held verifies that the original readiness gate still completes; a stylesheet failure after root mount remains fatal. The same HTTP suite has a native Firefox administrator startup, entry/static-module failure, and Reload path. These are controlled resource-failure reproductions, not proof of browser tab discard or the source of a user's cached HTML. Optional browser evidence includes screenshots and request/error diagnostics.

`foxThinkingText.e2e.mjs` covers rotation, width/Stop positioning, mode changes, reduced motion, stable labels, queue placement and timer cleanup.

`foxLoaderPreview.e2e.mjs` covers keyboard opening, Escape dismissal and focus return, and pointer dismissal for the independent demo. `processingStatus.test.mjs` checks thinking/loading wiring without altering runtime action semantics.

The production cases in `setupModels.e2e.mjs` verify real YAML worker markers and a blocked lazy worker import that still permits OOBE Models/Config editing and saving beneath the dismissible resource notice. The editor fallback contract remains owned by [WebUI editor](./webui-editor.md).
