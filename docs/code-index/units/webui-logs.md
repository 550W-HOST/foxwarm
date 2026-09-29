# Unit: WebUI Logs

Files: src/channels/webuiLogs.ts, src/channels/webuiLogs.test.ts, packages/webui/src/components/LogsView.tsx
Secondary files: src/common.ts, src/channels/webuiChannel.ts, src/channels/webuiRealtime.ts, packages/webui/src/realtime.ts, packages/webui/src/App.tsx, packages/webui/src/PopupWebUiApp.tsx, packages/webui/src/EmbeddedWebUiApp.tsx, test/app-e2e/logs.e2e.mjs

## Purpose

Provides the authenticated Main WebUI's read-only logger viewer: one Logs workbench tab, bounded byte-addressed history, an optional file-backed live topic on the existing realtime WebSocket, and approximate date/time navigation. It is not a general file browser, Session execution-log viewer, model tool, or external MCP surface.

## Key exports and function index

| Symbol | Responsibility |
|---|---|
| `WebUiLogFile.read` / `readNow` | Serialize bounded reads of the configured file, identify observed file lifetimes, and return UTF-8-aligned byte windows |
| `WebUiLogFile.seek` | Probe bounded windows and return an approximate dated record and its actual byte position |
| `WebUiLogFile.subscribe` / `tick` | Own a non-overlapping tail timer only while live subscribers exist |
| `WebUiLogFile.dispose` | Cancel tail scheduling and subscriber ownership; in-flight reads close their handles and cannot publish afterward |
| `registerWebUiLogRoutes` | Register the authenticated fixed-file history/time endpoint |
| `cleanLogText` / `timestamps` | Strip ANSI/control sequences for timestamp parsing while retaining raw-line byte accounting |
| `LogsView` / `appendWindow` | Render text-only history or bounded live blocks, release live ownership during history navigation, and fence stale requests |

## History contract

`WebUIChannel` constructs the file service with `MAIN_LOG_PATH`, the same `LOGS_DIR/BOT_NAME.log` destination used by the logger. `GET /api/webui/logs` accepts `direction=latest|before|after`, a safe integer `offset`, and `fileId`; paging requires both cursor fields. Date lookup accepts only `time` plus `fileId`. Unknown keys and non-scalar values are rejected. Routes use ordinary full WebUI authentication and accept no path or filename.

A history response contains `window` with `fileId`, current `size`, half-open `startOffset/endOffset`, raw decoded `text`, `lineCount`, `startsMidLine/endsMidLine`, `pendingBytes`, and `missing`. Each content window is at most 100 KiB, plus a fixed one-byte read allowance to inspect its preceding boundary. Reverse reading counts LF bytes within that window, never absolute line numbers or a whole-file total. An empty existing file differs from a missing destination.

Boundaries align to complete UTF-8 codepoints. Paging uses the returned byte offsets, not decoded character counts; a cut line is shown as a partial line rather than extended without a bound. A temporarily incomplete EOF codepoint remains outside `endOffset` and is read again when its remaining bytes arrive. A line without a final LF is still shown. Unknown file identities and observed truncation return an explicit reset (HTTP 409) instead of mixing file lifetimes.

## Live contract

The existing `set-subscriptions` union may include `logs: { id, cursor?: { fileId, offset } }`. The topic's ID identifies its logical lifetime; unrelated Session/list revisions do not restart an unchanged ID. Initial registration starts the file subscriber after the hub's ordinary initialization completes. Later log frames are independently cursor-addressed and never accumulate in the Session initialization queue.

Without a cursor the service sends `logs-snapshot` containing the newest bounded window. With a cursor, including after a physical reconnect, it sends contiguous `logs-delta` windows from that byte position. Every frame carries `logsId`. The page transport remembers the latest frontier for reconnect and ignores obsolete logical-lifetime frames. Snapshot and tail use the same file reader, so writes from other processes sharing that destination appear without logger RPC or per-process fanout.

The tail uses a non-reentrant 250 ms scheduler only while subscribers exist. Reads always close their handles. A catch-up gap beyond 200 KiB, or a client whose WebSocket buffer reaches 512 KiB, stops further log accumulation and produces one `logs-gap` once the socket can receive it. File replacement, disappearance or observed shrinking produces `logs-reset`; IO failures produce `logs-error`. Those conditions stop only the logs topic. Other Session/list subscriptions keep their existing transport. A fresh Latest action creates a new logical logs lifetime. Unsubscribe, connection cleanup and channel stop release the timer/subscribers.

`LogsView` retains at most 200 KiB of raw-byte-addressed blocks and a finite block count. Small contiguous chunks can merge using their wire offsets; pruning drops whole blocks and never derives a cursor from ANSI-cleaned text. History retains one window, stops live subscription, and cannot be pulled to the latest output by new writes. Latest explicitly resumes live mode. Display uses React text in one scrollable `pre`, with ANSI/OSC/control removal and no Markdown, HTML, terminal emulation, or model-marker interpretation.

## Time navigation

The normal file-only pretty target writes full local date/time, milliseconds and numeric time zone through `SYS:standard`, with color disabled. Console formatting and `FOXWARM_SYNC_FILE_LOG=1` synchronous JSON logging remain unchanged. Lookup recognizes those full pretty timestamps and numeric JSON `time` values, retaining offsets from the original raw lines even when ANSI is stripped for parsing.

A lookup reads the latest and first windows, performs at most 20 byte-bisection probes with one bounded preceding-window attempt per undated probe, and makes bounded candidate-local reads. HH-only or otherwise undated samples never imply an older date; if neither nearby sample has usable dates, probing stops. A result reports `approximate: true`, actual `locatedTime`, and the window beginning at the selected dated record. Requests outside the sampled dated range, or with no usable full timestamp, fail visibly without replacing the UI's previous window.

## Design decisions

### D-webui-logs-fixed-file-and-near-time

Logs is one singleton Main WebUI workbench tab reached by the settings menu's `Open logs` action. It supports the same restoration and top-level leaf popout mechanism as other system tabs. Code's embedded sidebar opens that same-origin popup leaf rather than introducing a Code editor or host bridge. The Application menu actions are `Open setup`, `Reload WebUI`, and `Open logs`.

History begins at the file tail and stays bounded by bytes. Live output follows that same file through the existing page-scoped realtime connection. New pretty file records include complete dates and time zones; older HH-only records remain browseable but have no guessed date. Time navigation is a bounded jump **near** a time, not a full-file exact search, earliest-after guarantee, or persistent indexing service. Concurrent processes can write non-monotonic timestamps, and finite probes can miss a dated region or a nearer record. The UI reports the actual approximate result or a lookup failure; it does not disguise the newest window as a successful hit. Reset detection covers observable file replacement/shrinking, not truncate-and-regrow sequences hidden between observations.

## Tests

- `webuiLogs.test.ts`: synthetic large (including a 384 MiB sparse file)/UTF-8/CRLF/no-LF windows, continuous paging, incomplete EOF, mixed full-date/JSON/HH-only/ANSI records, modest timestamp disorder, authenticated real HTTP/WS history and live output, reconnect catch-up, gaps, replacement, slow-client isolation, and cleanup.
- Existing logger fixture checks natural async exit, directory creation, final record, dated color-free file output, unchanged console timestamps, and synchronous JSON time/natural exit.
- Existing realtime transport, popup parser and Workbench normalization fixtures cover the shared socket, reconnect frontier, obsolete topic IDs and Logs restoration/URLs.
- The disposable application harness's `logs.e2e.mjs` uses production routes, WS and Chromium for menu/tab/history/live/time lookup, text safety, restoration, popout, embedded-sidebar popup, mobile dark-mode entry, bounded live display, partial UTF-8 and observed replacement.
