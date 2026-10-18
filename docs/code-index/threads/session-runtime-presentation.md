# Session runtime presentation

## Scope and navigation

This flow connects the canonical [runtime DTO](../units/src-session-runtime-state.md), [turn runner](../units/src-session-turn-runner.md), [history/compaction owner](../units/src-session-history.md), strict [Worker publication](../units/src-session-worker-publication.md), [control commands](../units/src-commands.md), and [WebUI presentation](../units/webui-runtime-status.md).

A logical model request can contain several physical provider attempts. Retry counts describe those attempts, not compaction planning rounds or tool invocations.

## D-session-runtime-presentation

[2026-10-17] Session status uses one consistent borderless presentation with explicit operation identity. Requesting the model uses a fox spinner and the theme accent; executing a tool uses the theme special color and working pose. Waiting uses a sleeping fox. Maintenance, retries, stopping, interruption and failures have recognizable poses and concise labels. Decorative rotating captions belong only to ordinary model requests; tools retain their actual names. Detailed and Conversation views use the same status facts.

| Situation | Presentation |
| --- | --- |
| Ordinary model request | Accent spinner and decorative caption; stable accessible operation label |
| Tool execution | Special-color working fox, resolved tool name and execution Node |
| Foreground compaction | Accent maintenance pose and planning/application phase |
| Background compaction | Secondary maintenance detail; never replaces active foreground work |
| Retry backoff | Warning retry pose and countdown/attempt count |
| Final request failure | Danger/static failure pose |
| Explicit wait | Warning sleeping fox and the remaining dependency kind/count |
| Stop requested | Warning stopping pose until authoritative state settles |
| Idle unfinished turn | Static interruption/failure pose and permission-gated Continue |
| Unknown active phase | Neutral running pose without an invented tool or request phase |
| Idle complete | No active-status row |

The four backend states remain `requesting-model`, `running-tool`, `waiting`, and `idle`. Retry, stopping and compaction metadata are orthogonal projections, not scheduler states. A blocking wait for compaction must replace a stale tool phase and release only its exact owned runtime instance. Background job metadata cannot acquire foreground ownership. List/Architecture summaries consume the same presentation mapping; their existing bounded data and busy-ring behavior remain intact.

The current status opens a keyboard/touch-accessible details popover for actual tool identity, source/MCP server, argument preview, batch position, Node, requested model, wait targets/deadline, retry cause and compaction phase. Missing information stays absent. Provider arguments remain bounded previews, not complete invocation payloads. Reduced motion preserves labels and controls while suppressing pose/caption animation.

## D-session-control-feedback

[2026-10-17] Stop, Continue, Run queued, compaction and compaction cancellation use correlated structured WebUI feedback rather than inserting successful control receipts into chat history. The HTTP acknowledgement only confirms receipt; canonical runtime data describes ongoing work. Stop remains visibly pending until backend stopping/idle is observed. Continue admission does not imply that an interrupted turn has already finished. Accepted feedback cancels the confirmation timeout; failures and no-ops stay beside the status with optional diagnostics. An unconfirmed request is not presented as a successful stop. Existing backend control semantics, identity checks, and other-channel text responses are retained.

Controls retain their existing permissions. Stop belongs to the composer action; queue count/Run queued belong after the final visible message. Ordinary input and attachment drafts remain independent of command feedback.

## D-session-system-events

[2026-10-17] Operational failures use identifiable system-event blocks with a short title/cause and collapsed original diagnostics. Title and summary share one naturally wrapping line, with a semibold title and colon followed by regular-weight summary text; expandable Details remain below without truncating the summary or diagnostics. They remain distinct from assistant prose and native tool results. Only explicit first-party metadata establishes event identity; an `Error:` prefix, arbitrary JSON, or model-authored wording does not.

Typed notices are display-only and cannot enter provider replay. Compaction failures are published at owner-safe application boundaries, not by mutating the foreground history from a planner thread. Exact-Session error deduplication prevents repeated presentation across runner/delivery paths; fenced/archive failures can use a temporary typed event when durable append is unavailable. WebUI consumes those events instead of duplicate plain error finals; other channel deliveries keep their existing behavior. Temporary compact-planner transcripts do not become foreground conversation replies.

Non-LLM system events remain outside Activity and use the same card in every timeline mode. In Conversation, LLM retry notices instead retain the active-history tail rule: a retry/error at the current committed active-context tail is external regardless of `retry.final`. Non-tail retries belong to Activity. Folded nonfinal retries introduce no visible text/clock boundary; older final failures retain their existing terminal timing cut. A later real message or CTX folds the old retry back into Activity. Loaded Archive rows match the active tail by canonical sequence; viewport, Archive, draft and nested tails do not establish authority. Detailed/Grouped use the same typed retry card and full original Details without changing their [tool-run membership and disclosure contract](../units/webui-timeline-rows.md#behavior); card appearance does not make a retry a new group boundary. Live retry countdowns are unchanged.

External system-event cards participate in pane-local Search through their displayed title, summary and bounded diagnostics; selecting a match opens diagnostics without reinterpreting them as HTML. Retry cards inside Activity keep the same full Details content but stay outside Conversation Search even when manually expanded.

## Verification

- Backend runtime/Worker-publication tests cover orthogonal fields, clone/bounds rules and exact-operation cleanup.
- Notice/control tests cover metadata validation, Session-scoped deduplication and non-WebUI compatibility.
- Turn runner, delivery and streaming-timeout integration tests cover error/fence/compaction boundaries and physical-attempt hooks.
- Native browser fixtures cover status poses/colors, details focus/Escape, reduced motion, correlated Stop transitions, queue/composer geometry, and system-event rendering/search in all timeline modes.
