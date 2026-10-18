# Unit: src-session-notices

Files: src/sessionNotices.ts, src/sessionNotices.test.ts, src/commands/sessionControlFeedback.ts

## Purpose and stable symbols

- `createSessionNoticeMessage` creates first-party display-only operational events with bounded UI diagnostics while retaining original diagnostic text in the history payload.
- `markSystemFailurePublished` / `isSystemFailurePublished` deduplicate one error object's presentation within its exact Session. A weak error-keyed registry does not mutate frozen errors or suppress another Session's failure.
- `replySessionControl` emits validated structured feedback for WebUI and preserves the supplied legacy text for other channels.

History owner callbacks durably append compact failures; runner fallback uses temporary typed events when a fenced or failed archive cannot accept another semantic append. Publication is marked only after a real append/notification path. Message visibility remains the provider-replay boundary. These helpers do not change compaction eligibility, wait or queue semantics.

Tests cover bounded metadata, model invisibility, malformed/hostile enum values, exact-Session deduplication, command grammar and channel-specific reply compatibility. Canonical contract: [Session runtime presentation](../threads/session-runtime-presentation.md).
