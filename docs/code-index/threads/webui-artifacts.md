# Thread: Interactive WebUI artifacts

## D-artifact-modules

[2026-10-18] Interactive content uses a common versioned envelope, immutable resource snapshots and a frontend host, with separate trusted modules for image snapshot/preview, chart validation/rendering and React preparation/sandboxing. Skills teach authoring and publication; they do not install renderers or grant execution authority. Adding a module registers a validator, preparation adapter and lazy renderer rather than adding content-type branches throughout ChatTimeline. Protocol version, module schema version and artifact revision are independent.

Implementation: [shared contract](../units/shared-artifacts.md), [Main publication](../units/src-artifacts.md), [WebUI rendering](../units/webui-artifacts.md).

## D-artifact-publication

[2026-10-18] The Main-owned `artifact` tool prepares or publishes a size-bounded, self-contained JSON manifest or raster image from an authorized source Node into `state/artifacts`. Main and primitive Provider ingestion enforce the bound while reading; resident CLI ingestion retains its existing complete-read path and applies the artifact size check afterwards. Source identity is reconstructed by the existing fenced management service. Data and source files are snapshots, not live paths. React compilation is completed before publication. A successful structured receipt identifies the exact Session, artifact ID and immutable revision; arbitrary Markdown/code fences and file writes do not publish runnable content.

Updates require the artifact ID and expected previous revision, preserve owner/type, and fail on conflicts. Older replies remain pinned. The original archive retains receipts for history reconstruction; artifact storage has its own persistent lifetime and is not deleted by active-context compaction. Artifacts are not automatically garbage-collected or copied to other Sessions. Backups must retain this store alongside history. No public share links or cross-Session publication are introduced.

Every HTTP read rechecks Session access and stored ownership. IDs are not bearer credentials. The original manifest or image bytes can be downloaded from authenticated bytes without exposing filesystem paths. A missing revision fails visibly and does not silently substitute the latest revision. Non-WebUI channels receive the textual tool result; authors can deliver a static figure or data file through existing tools.

## D-artifact-inline-placement

[2026-10-18] `prepare` persists a snapshot and returns a reference without adding a standalone card. Ordinary assistant prose may embed `<foxwarm-artifact id="..." revision="..." />` as a top-level block, separated by blank lines. The shared Markdown lexer owns recognition; nested quotes/lists, code fences/spans, user/tool content and arbitrary HTML are not alternate rendering entry points. Partial streamed references remain inert until complete. The current Session and pinned revision are checked on every fetch; a marker conveys no new authority.

`publish` retains reply-end cards, suppressing the same revision's tail duplicate when embedded in that reply. `send_file` remains separate file delivery. Captions are ordinary Markdown paragraphs. Renderers share the same host and stable identity whether inline or standalone; later streamed prose does not remount an unchanged preview. React remains explicitly user-started.

Images accept PNG/JPEG/GIF/WebP files, bound to 12 MiB, 40 megapixels and bounded animation frames/decoded size. Verified raster metadata and immutable content-addressed binary resources are stored separately. Blobs are completely linked before their revision becomes visible; an interrupted write may leave an unreferenced blob but cannot block the next revision. Authorized resource reads verify size/hash and safe MIME without leaking source paths. Images appear as borderless prose figures with no card background, title bar or inline toolbar. Image clicks reuse the existing full-screen preview, which retains download controls; image downloads return original image bytes. Chart and React card chrome is unchanged. SVG/HTML and external image URLs are not accepted by this module.

## D-artifact-execution

[2026-10-18] Charts accept a closed Vega-Lite subset with bounded embedded data, no external URLs, authored expressions/signals or arbitrary transforms. Generated expressions use the Vega interpreter, and a rejecting loader prohibits external chart loads. Host-side controls provide recent-row filtering, trailing means and layer visibility; metrics use the full snapshot or their explicit trailing window. Unsmoothed values and nulls remain distinguishable.

React source is compiled as data in a bounded-lifetime child process; generated JavaScript is never evaluated by Node. A virtual source resolver permits package-local imports and a fixed React runtime only. The artifact includes compiled output for historical replay. Compilation depends on the installed WebUI React/ReactDOM packages and esbuild; supported deployment includes those dependencies.

Previews start only after a user action. A trusted opaque-origin outer frame permits only blob child frames; its frame CSP blocks the inner frame's external self-navigation. The inner opaque-origin frame runs generated code with no same-origin privilege, host storage or Foxwarm credentials. The sandbox restricts ordinary resource loading, popups, forms, browser workers and nested frames, but it does not guarantee complete network isolation. The bridge accepts only source-window/channel-matched ready/error reports and host-supplied bounded theme colors. It has no tool or file API. CSS adapts to semantic theme variables. Sandbox isolation is not a hard CPU/memory quota; Stop/Reset destroy the preview, and hiding the browser tab stops it. Durable user state is not provided.

## D-artifact-presentation

[2026-10-18] Successful artifact receipts render outside Activity in every main timeline mode, once per ID/revision and within their input-bounded reply span. New final text does not remount an already interactive artifact. Download exposes the original snapshot. The header omits revision badges and a source-code viewer; revisions remain part of the persisted identity. Native-dialog expansion puts the same mounted content into the top layer, with focus/inert/Escape behavior and phone edge-to-edge layout. Closing expansion preserves interaction state; Stop, Reset and reopening a Session do not.

Charts provide readable metrics and direct controls. The footer omits provenance text and an expandable data table; downloads retain the complete snapshot, including all rows and provenance. Desktop cards have balanced side gutters and a centered bounded width; expanded desktop previews are also centered and bounded. Phones retain their compact inline and edge-to-edge expanded layouts. Artifact containers and sandbox content hide scrollbar chrome while preserving wheel, touch and keyboard scrolling; overflow is not clipped to simulate this appearance. Renderer errors stay within the artifact. Heavy renderers are lazy-loaded and content is fetched only near the viewport. Unsupported types remain downloadable rather than executed speculatively.

## Verification

- `src/artifacts/artifacts.test.ts`: validation, immutable revisions, concurrent conflict, owner checks, compiler imports and HTTP access.
- `packages/webui/test/artifacts.test.mjs`: structured projection, exact scope, deduplication and input-boundary ownership.
- `packages/webui/test/artifacts.e2e.mjs`: actual timeline, responsive chart, sandbox interaction, stable expansion/reply updates, reload and blocked host/fetch access.
- Skills contain synthetic training and insertion-sort examples, also exercised by tests.
