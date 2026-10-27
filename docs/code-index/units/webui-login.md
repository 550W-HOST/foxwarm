# Unit: WebUI token sign-in

Files: packages/webui/src/login.html, packages/webui/src/login.css, packages/webui/src/login.ts, packages/webui/build/loginHtml.ts, packages/webui/public/login.html, packages/webui/test/login.e2e.mjs
Secondary files: packages/webui/vite.config.ts, packages/webui/src/components/foxDrawing.json, packages/webui/src/components/FoxLoaders.css, packages/webui/src/theme/runtime.ts, src/channels/webuiChannel.ts

## Purpose

Responsive, independent token entry before the authenticated application. The existing public file and POST authentication endpoint remain the backend integration surface. Login does not mount the application, request protected assets, enumerate Sessions or infer an administrator/WebUI role.

## Symbols and generated output

- `renderLoginHtml` bundles `login.ts`, the real theme runtime/validator and built-in registry into the standalone document. It inlines canonical fox paths/loader CSS and view-specific CSS; no network-loaded script, stylesheet or font is required.
- `loginHtmlPlugin` atomically refreshes `public/login.html` before Vite copies public assets. The backend can read that checked-in generated file without invoking frontend tools at request time. Vite development middleware renders fresh source at `/login.html`.
- `mountLogin` owns form state, reveal/mask, bounded authentication, fragment handling and same-directory navigation. There is no application boot splash/minimum-delay gate on this page.
- `public/login.html` is generated output, not an authoring source. Edit `src/login.*` or shared theme/fox inputs and run the WebUI build. Output is deterministic and does not contain installation configuration or live credentials.

## D-login-cookie-ownership

[2026-10-19] Browser cookie scope follows the actual visible login directory. The configured public URL is not the only valid entry: one instance must support both direct root access and a reverse-proxy base path under the same configuration, including a proxy that strips its prefix. After successful `POST ./api/auth` validation, the existing frontend writes `foxwarm_token` at `location.pathname.replace(/[^/]+$/, '') || '/'`, with a 365-day max-age (31,536,000 seconds), SameSite=Strict and Secure only on HTTPS. The validation endpoint returns JSON only: it does not create, renew or delete cookies, nor infer the pre-proxy path from public URL configuration, Referer or forwarding headers. This keeps cookie ownership at the browser, which knows the address actually used.

An existing same-name/domain/path HttpOnly cookie blocks script replacement. The .NET host retains valid old raw/derived cookie reads, but does not automatically migrate browser storage through backend path inference. The separate native Desktop cookie is owned by [host runtime](./host-runtime.md#desktop-boundary), not this frontend flow.

## D-login-presentation

[2026-10-16] Token sign-in uses the existing animated fox and a restrained entry animation, a desktop illustration/form split and a stacked mobile layout. The illustration has no orbit, halo or visible brand wordmark. Copy is limited to the field, action and current state/error. Existing browser theme selection, including independent light/dark families and validated imports, governs colors. Reduced motion renders static artwork and skips decorative transitions; no animation blocks form interaction. Touch controls remain at least 44px and inputs remain 16px; short screens scroll instead of clipping the form.

## Authentication behavior

`POST ./api/auth` remains relative to the deployment prefix and accepts administrator or restricted WebUI tokens without a new role selector. Pending state prevents duplicate submissions and keeps the input read-only. Invalid credentials, server errors, network failures and the 15-second timeout return to an editable form without persisting the attempted token or displaying response bodies. Errors clear when editing resumes.

Successful authentication keeps the existing `foxwarm_token` cookie/local-storage keys under [the cookie ownership contract](#d-login-cookie-ownership). Local-storage denial does not prevent the cookie path from succeeding. Credentials remain masked by default and are cleared from the input after success. Legacy `#token=` links are consumed after handlers exist; the fragment is removed from history before submission, and malformed encoding leaves a usable form. Navigation replaces the current entry with the same directory root, with only a short decorative success fade (none under reduced motion). Page departure aborts an outstanding request.

## Verification

`login.e2e.mjs` serves the generated page under a nested deployment prefix with synthetic credentials only. Native Chromium checks desktop/mobile/short/landscape geometry, exact canonical fox paths, theme restoration, zero protected-asset dependencies, mask/reveal, pending deduplication, successful cookie/storage persistence, invalid/network/server/timeout recovery, fragment handling, storage denial and reduced motion. Screenshot artifacts use empty fields or synthetic pending data.

`mainHostLoginCookies.e2e.mjs` verifies the unchanged generated page against one owned .NET configuration through direct-root and prefix-stripping proxy URLs: cookie scope/lifetime, validation-only responses, scoped authorization/revocation and the old HttpOnly replacement limitation.
