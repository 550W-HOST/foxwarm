# Unit: WebUI fox loaders

Files: packages/webui/src/components/FoxThinkingText.tsx, packages/webui/test/foxThinkingText.e2e.mjs, packages/webui/src/components/FoxLoaders.tsx, packages/webui/src/components/FoxLoaders.css, packages/webui/src/components/FoxLoaderPreview.tsx
Secondary files: packages/webui/src/main.tsx, packages/webui/src/App.tsx, packages/webui/src/components/ProcessingStatus.tsx, packages/webui/test/processingStatus.test.mjs, packages/webui/test/foxLoaderPreview.e2e.mjs

## Purpose

Theme-aware inline SVG loaders for full-app startup, lazy workbench views, and ordinary model thinking. Loader CSS is included by the application stylesheet, so standalone source fixtures can consume that built stylesheet without a separate component-CSS bundle. The sleeping fox uses the semantic accent rather than a hard-coded theme palette.

## Public symbols

- `FoxCub` — draw-in/sleeping fox illustration; the static form suppresses motion.
- `FoxSpinner`, `FoxThinking`, `FoxPaneLoader` — spinner forms for small status rows and lazy view fallbacks.
- `FoxThinkingText`, `FOX_THINKING_PHRASES`, `FOX_EXEC_PHRASES` — decorative woodland captions with a stable accessible runtime label.
- `markBootReady`, `BootReadySignal` — idempotent module-local readiness signal and React mount adapter.
- `FoxSplash`, `FoxSplashScreen` — startup lifecycle and its presentational screen.
- `FoxLoaderPreview` — Appearance preview controls for replaying the illustration and inspecting loader sizes or a full-screen splash.

## Behavior

- Startup waits for both content readiness and the 1500ms minimum draw-in interval, then leaves for 480ms and unmounts. One effect enters `leaving`; a separate effect owns the fade-completion timer. Changing phase must not cancel the timer before it can enter `gone`.
- Effects clear pending timers on teardown; React StrictMode setup/cleanup does not leave stale subscriptions or timers. The readiness store is monotonic during one application load.
- Reduced motion skips the minimum draw-in wait and disables SVG motion. The leaving screen becomes transparent, hidden, and pointer-inert before removal.
- The full-app splash is not mounted for popup/embedded roots. Authentication failure also signals readiness so loading cannot obscure the sign-in recovery link.
- Ordinary requesting-model status uses a 24px fox thinking spinner. Compaction/tool indicators and static waiting behavior retain their previous runtime semantics. Timeline loading uses an accessible waiting label; lazy view fallback uses a centered status loader.
- Ordinary model requests pick among 32 imaginative woodland phrases; actual exec calls pick among 24 distinct physical-action phrases. Exec has no visible tag and uses the special semantic color for both fox and copy, preserving the real tool identity, sequence, node, and available argument preview in its tooltip. Other tool names keep their real summaries. Captions wait 5–7 seconds between changes, never repeat immediately, and replace old copy from left to right over 450ms with complementary clip masks and no text movement. The transparent borderless thinking/exec row uses 18px copy and a separate quiet Stop action. An invisible, aria-hidden intrinsic sizer measures the current phrase; ResizeObserver tracks font changes. Text width interpolates over the same 450ms as the wipe so Stop follows the text smoothly without a reserved longest-phrase gap. The text layers overlap in one in-flow grid cell, preserving their real text baseline, and share a bounded, measured slot and a 1.5em line box with descender clearance; narrow panes truncate to keep Stop reachable. Reduced motion replaces text without wipe animation. The accessible status stays unchanged, timers clean up on unmount, and non-exec tools and compaction/wait/loading states never mount the rotating caption.
- Appearance previews have no live Session operations. They consume the active theme accent; the presentational full-screen preview closes on click or Escape and returns focus to its Full screen control. Its listener exists only while that manual preview is open and cannot dismiss the real startup splash or drive the application boot store.

## Verification

`foxThinkingText.e2e.mjs` covers wipe-mask interpolation, borderless styling and 18px copy, measured-width interpolation, exec identity/color, reduced motion, accessible copy, Stop action/focus, narrow rows, and state-change timer cleanup. `foxLoaderPreview.e2e.mjs` covers keyboard opening, Escape and pointer dismissal, focus return, and the real startup readiness gate. `processingStatus.test.mjs` checks thinking/loading wiring without altering runtime action semantics. Production and development browser probes verify ordinary/reduced-motion splash timer completion, DOM removal, and pointer access to the application beneath the screen.
