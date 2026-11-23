# Session runtime presentation

## Scope and navigation

This flow connects the canonical [runtime DTO](../units/session-turns.md), [turn runner](../units/session-turns.md), [history/compaction owner](../units/session-compaction.md), strict Worker publication, [control commands](../units/message-routing.md), and [WebUI presentation](../units/webui-runtime-status.md).

A logical model request can contain several physical provider attempts. Retry counts describe those attempts, not compaction planning rounds or tool invocations.

## D-session-runtime-presentation

[2026-10-17] Session status uses one consistent borderless presentation with explicit operation identity. Requesting the model uses a fox spinner and the theme accent; executing a tool uses the theme special color and working pose. Waiting uses a sleeping fox. Maintenance, retries, stopping, interruption and failures have recognizable poses and concise labels. Decorative rotating captions belong only to ordinary model requests. Chat and the Session list use the owner's live activity under [live caption continuity](#d-runtime-caption-continuity), otherwise the ordinary runtime caption. Tool identity and execution Node remain available in the stable accessible label and details. Detailed and Conversation views use the same status facts.

| Situation | Presentation |
| --- | --- |
| Ordinary model request | Accent spinner and decorative or eligible live caption; stable accessible operation label |
| Tool execution | Special-color working fox; Chat shows an eligible live caption when available, with resolved tool identity and Node in its accessible label and details |
| Foreground compaction | Accent maintenance pose and planning/application phase |
| Background compaction | Secondary maintenance detail; never replaces active foreground work |
| Retry backoff | Warning retry pose and countdown/attempt count |
| Final request failure | Danger/static failure pose |
| Explicit wait | Warning sleeping fox and the remaining dependency kind/count |
| Waiting on an `ask_user` question | Warning sleeping fox labelled as waiting for the user's answer, with the question IDs in details |
| Stop requested | Warning stopping pose until authoritative state settles |
| Idle unfinished turn | Static interruption/failure pose and permission-gated Continue |
| Unknown active phase | Neutral running pose without an invented tool or request phase |
| Idle complete | No active-status row |

The managed backend projects `requesting-model`, `running-tool`, `waiting`, `idle`, and inactive `llm-failed`. [Terminal foreground failure](../behaviors/messages-and-turns.md#terminal-foreground-request-failure-net) owns classification, clearing, persistence and completion-attention behavior. Retry, stopping and compaction metadata remain orthogonal projections, not scheduler states. A turn's model request is published as an ordinary `requesting-model` phase from the start of its preparation (selection, prompt, journal admission, history projection, redaction and serialization), not only at the provider attempt, so a finished tool batch does not pass through the unknown phase before the next request (user decision, 2026-11-16). A blocking wait for compaction must replace a stale tool phase and release only its exact owned runtime instance. Background job metadata cannot acquire foreground ownership. List/Architecture summaries consume the same presentation mapping; their existing bounded data and busy-ring behavior remain intact.

The current status opens a keyboard/touch-accessible details popover for actual tool identity, source/MCP server, argument preview, batch position, Node, requested model, wait targets/deadline, retry cause and compaction phase. Missing information stays absent. Provider arguments remain bounded previews, not complete invocation payloads. Reduced motion preserves labels and controls while suppressing pose/caption animation.

### D-runtime-caption-continuity

[2026-11-15] The live caption shows the last displayable item since the latest input, replacing the earlier request-local retention and its three-second tool minimum. Displayable items are complete `exec`/`run_script` summary strings, including while arguments are still streaming and when `call_tool` or `ctl tool call` routes to Node `exec` or builtin `run_script` (MCP tools of the same name are excluded), [2026-11-22] the `summary` of any `ctl` call unless the tool it runs states its own, which then wins ([D-ctl-summary](../units/ctl-command-registry.md#d-ctl-summary)), and reasoning headings under the Reasoning card's exact first-line bold-heading gate. Body output, tool results, incomplete headings and calls without a summary do not replace the caption. A displayed item survives generation, execution, the next model request and any period without new displayable content, with no timeout, until a newer item replaces it or the turn ends.

Any input that enters the conversation opens a new segment: direct user messages, other Sessions' messages, and event or notification inputs delivered into the turn. The turn's opening input is simply the first boundary. Model output, tool results, queued input that has not been delivered, Task reminders and compaction maintenance rows, settings and first-run boundaries, and display-only notices are not inputs; a context block also ends earlier evidence. While a batch executes, the running call marks the current position, so its own summary (or the item before it) is shown and later calls of the batch appear when they run.

The exact Session owner computes the value (user decision, 2026-11-15) and publishes it as transient `runtimeState.activity` `{reasoning?, tool?, latest}`: the latest reasoning heading and the latest tool summary since the latest input, each one line of at most 200 characters, and which one is later. It is derived from committed history after the latest input plus the owner's raw model stream, so a heading or summary is published as soon as it is complete, independent of the client draft throttle. The runtime state is republished only when the value changes, never per delta. The value is cleared when an input is appended and at turn end (a Continue without new input starts empty), is present only while the Session is busy, and is never persisted or sent to a model; after a restart the owner derives it again from history.

Presentation shows the later of the two in every Chat timeline view and in the Session list (user decision, 2026-11-15). Session list detailed rows show the activity text with the runtime indicator and tone, moving tool identity and Node to the hover title, and normal rows add it to the status label and tooltip. Without a value, Chat ordinary requests show the decorative caption and the list shows the ordinary runtime summary, never decorative text. Text and style are independent: state color, fox pose, accessible operation label and runtime details follow the current runtime immediately. Waiting (including a pending tool approval), failure, retry, compaction and stopping show their own labels; when ordinary activity resumes, the caption returns. Model-facing Session status quotes the same activity after the execution state.

### D-runtime-send-phase

[2026-11-10] From a send until the runtime reports real work, ProcessingStatus shows the existing request-style `Sending…` rather than the prior inactive state (blank, Waiting, Interrupted/Continue) or the busy-but-unknown `Running…`; it continues through the canonical handoff while the runtime phase is still unknown. The pending row is identified per [D-streaming-optimistic-message-identity](./streaming-pipeline.md#d-streaming-optimistic-message-identity). A failed POST removes the pending row, keeps the draft and shows `Message not confirmed`, as before.

## D-session-control-feedback

[2026-10-17] Stop, Continue, Run queued, compaction and compaction cancellation use correlated structured WebUI feedback rather than inserting successful control receipts into chat history. The HTTP acknowledgement only confirms receipt; canonical runtime data describes ongoing work. Stop remains visibly pending until backend stopping/idle is observed. Continue admission does not imply that an interrupted turn has already finished. Accepted feedback cancels the confirmation timeout; failures and no-ops stay beside the status with optional diagnostics. An unconfirmed request is not presented as a successful stop. Existing backend control semantics, identity checks, and other-channel text responses are retained.

The .NET exact owner publishes transient `runtimeState.processing: true` while its existing foreground run remains retained, including admission preparation and cleanup after a committed idle checkpoint. The field is omitted after the exact completed run is removed, and is not persisted or a separate runtime state. It suppresses premature Interrupted and Continue; otherwise idle processing uses the neutral Running summary. History classification and exact-owner admission still decide whether continuation is eligible. Live, history, reconnect and bounded list/Architecture overlays share this projection; processing retains the local overlay until the normal final publication evicts it. Busy checkpoints, active/busy rings and idle-notification triggers keep their existing rules. [2026-11-10] A successful busy claim publishes `session-state` immediately after its durable save, before turn-start hooks and the canonical append, so presentation sees the busy Session during a slow turn start; turn-start ordering is unchanged. Draft cleanup runs before processor release, so a prior run cannot clear a queued successor's draft or readiness.

Controls retain their existing permissions. Stop belongs to the composer action; queue count/Run queued belong after the final visible message. Ordinary input and attachment drafts remain independent of command feedback.

## D-session-system-events

[2026-10-17] Operational failures use identifiable system-event blocks with a short title/cause and collapsed original diagnostics. Title and summary share one naturally wrapping line, with a semibold title and colon followed by regular-weight summary text; expandable Details remain below without truncating the summary or diagnostics. They remain distinct from assistant prose and native tool results. Only explicit first-party metadata establishes event identity; an `Error:` prefix, arbitrary JSON, or model-authored wording does not.

Typed notices are display-only and cannot enter provider replay. Compaction failures are published at owner-safe application boundaries, not by mutating the foreground history from a planner thread. Exact-Session error deduplication prevents repeated presentation across runner/delivery paths; fenced/archive failures can use a temporary typed event when durable append is unavailable. WebUI consumes those events instead of duplicate plain error finals; other channel deliveries keep their existing behavior. Temporary compact-planner transcripts do not become foreground conversation replies.

Non-LLM system events remain outside Activity and use the same card in every timeline mode. In Conversation, LLM retry notices instead retain the active-history tail rule: a retry/error at the current committed active-context tail is external regardless of `retry.final`. Non-tail retries belong to Activity. Folded nonfinal retries introduce no visible text/clock boundary; older final failures retain their existing terminal timing cut. A later real message or CTX folds the old retry back into Activity. Loaded Archive rows match the active tail by canonical sequence; viewport, Archive, draft and nested tails do not establish authority. Detailed/Grouped use the same typed retry card and full original Details without changing their [tool-run membership and disclosure contract](../units/webui-timeline-rows.md#behavior); card appearance does not make a retry a new group boundary. Live retry countdowns are unchanged.

External system-event cards participate in pane-local Search through their displayed title, summary and bounded diagnostics; selecting a match opens diagnostics without reinterpreting them as HTML. Retry cards inside Activity keep the same full Details content but stay outside Conversation Search even when manually expanded.

## Verification

- Backend runtime/Worker-publication tests cover orthogonal fields, clone/bounds rules and exact-operation cleanup; `LiveActivityTests` cover activity boundaries, streaming completion, batch position, routing, publish-on-change, recovery, clearing and status text.
- Notice/control tests cover metadata validation, Session-scoped deduplication and non-WebUI compatibility.
- Turn runner, delivery and streaming-timeout integration tests cover error/fence/compaction boundaries and physical-attempt hooks.
- Native browser fixtures cover status poses/colors, details focus/Escape, reduced motion, correlated Stop transitions, queue/composer geometry, and system-event rendering/search in all timeline modes.
