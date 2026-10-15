# Unit: WebUI fox loaders

Files: packages/webui/src/components/FoxLoaders.tsx, packages/webui/src/components/FoxLoaders.css, packages/webui/src/components/FoxLoaderPreview.tsx
Secondary files: packages/webui/src/main.tsx, packages/webui/src/App.tsx, packages/webui/src/components/ProcessingStatus.tsx, packages/webui/test/processingStatus.test.mjs, packages/webui/test/foxLoaderPreview.e2e.mjs

## Purpose

Theme-aware inline SVG loaders for full-app startup, lazy workbench views, and ordinary model thinking. The sleeping fox uses the semantic accent rather than a hard-coded theme palette.

## Public symbols

- `FoxCub` — draw-in/sleeping fox illustration; the static form suppresses motion.
- `FoxSpinner`, `FoxThinking`, `FoxPaneLoader` — spinner forms for small status rows and lazy view fallbacks.
- `markBootReady`, `BootReadySignal` — idempotent module-local readiness signal and React mount adapter.
- `FoxSplash`, `FoxSplashScreen` — startup lifecycle and its presentational screen.
- `FoxLoaderPreview` — Appearance preview controls for replaying the illustration and inspecting loader sizes or a full-screen splash.

## Behavior

- Startup waits for both content readiness and the 1500ms minimum draw-in interval, then leaves for 480ms and unmounts. One effect enters `leaving`; a separate effect owns the fade-completion timer. Changing phase must not cancel the timer before it can enter `gone`.
- Effects clear pending timers on teardown; React StrictMode setup/cleanup does not leave stale subscriptions or timers. The readiness store is monotonic during one application load.
- Reduced motion skips the minimum draw-in wait and disables SVG motion. The leaving screen becomes transparent, hidden, and pointer-inert before removal.
- The full-app splash is not mounted for popup/embedded roots. Authentication failure also signals readiness so loading cannot obscure the sign-in recovery link.
- Ordinary requesting-model status uses the 20px fox thinking spinner without increasing the existing status block height. Compaction/tool indicators and static waiting behavior retain their previous runtime semantics. Timeline loading uses an accessible waiting label; lazy view fallback uses a centered status loader.
- Appearance previews have no live Session operations. They consume the active theme accent; the presentational full-screen preview closes on click or Escape and returns focus to its Full screen control. Its keyboard listener exists only while that manual preview is open; it cannot dismiss the real startup splash or drive the application boot store.

## Verification

`foxLoaderPreview.e2e.mjs` covers keyboard opening, Escape dismissal and focus return, pointer dismissal, and the real startup splash retaining its readiness gate after Escape. `processingStatus.test.mjs` checks thinking/loading wiring without altering runtime action semantics. Production and development browser probes verify ordinary/reduced-motion splash timer completion, DOM removal, and pointer access to the application beneath the screen.
