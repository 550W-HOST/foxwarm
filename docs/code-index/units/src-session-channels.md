# Unit: src-session-channels

Files: src/session/channels.ts, src/session/channels.test.ts

## Purpose

Owns persisted channel-instance/conversation attachments to sessions, direct channel delivery, session-wide file/broadcast delivery, and best-channel selection from current plus persisted source metadata.

## Key exports

- `ChannelMode`, `ChannelConfig`, `FileDeliveryResult`, `ChannelTarget`.
- `createChannelsStore`, test store/reset helpers, `loadChannels`, `saveChannels`, `saveChannelsCritical`, `importLegacyChannelAttachments`.
- `attachChannel`, `attachChannelDurably`, `detachChannel`, `detachChannelsForSession`.
- `getSessionByChannel`, `getChannelConfig`, `getChannelsBySession`, `getChannelBySession`, `getAllAttachments`.
- `setChannelMode`, `getChannelDangerouslyAllowAllUsers`, `setChannelDangerouslyAllowAllUsers`.
- `parseChannelTargetId`, `sendToChannelTargetId`, `sendFileToChannelTargetId`.
- `sendFileToSession(deps, sessionId, file, options?)`.
- `createSessionBroadcast(sessionId)`.
- `deliverCommittedFinalToAttachments(sessionId, text, options)` — narrowly awaited one-attempt attachment delivery for the Worker committed-final Main service; ordinary broadcast remains unchanged.
- `reportChannelTurnProgress`, `finishChannelTurnProgress`, `decorateChannelProgressText`, and `resetChannelTurnProgress` — Main-side transient ordinary-text progress integration over current attachments/configured instances.

No runtime getter/setter aliases for `dangerouslyAllowAllGroupMembers` exist. That field is a stored-data reader only.

## Storage and normalization

- The in-memory map key is `<channel-instance-id>:<conversation-id>`; conversation IDs may themselves contain colons and parsing preserves the remainder.
- Store shape is `{ channels: Record<string, ChannelConfig> }`.
- On read/current normalization, `push-only` becomes `send-only` and `dangerouslyAllowAllGroupMembers` becomes `dangerouslyAllowAllUsers`.
- Canonical writes contain current fields only.
- Ordinary mutations update memory and start a best-effort durable write. Creation/command paths use `attachChannelDurably`, which awaits persistence and restores the prior in-memory binding on failure.

## Delivery behavior

- Direct target sends resolve one registered channel instance and call its text/file method.
- Session file delivery reports delivered, skipped, and failed targets. `send-only` attachments and channels without file support are skipped.
- Session broadcast is fire-and-forget: it can target one attached channel, omit excluded/send-only channels, optionally allow an empty platform-finalization message, and logs asynchronous send failures.
- Worker committed-final attachment delivery applies the same target/exclusion/send-only/empty-final selection but awaits each selected channel once and returns bounded attempted/delivered/failure counts to its Main handler.
- Ordinary broadcast and awaited Worker attachment delivery decorate only messages carrying the ephemeral turn ID. Each target consumes its own pending progress baseline; direct tool/file sends do not carry that marker and remain untouched.
- `getChannelBySession` prefers `session.meta.lastChannel`, then scans recent user source wrappers, then falls back to the first attachment.

## Compatibility

- Stored attachment readers normalize `push-only` and `dangerouslyAllowAllGroupMembers`.
- Source-history selection reads current `<foxwarm-message type="channel" ...>` wrappers plus supported legacy `FROM:`/channel-ID source text.
- New API and writes use `send-only`, `dangerouslyAllowAllUsers`, and `channelTargetId`.

## Design decisions

### D-session-channels-read-old-write-current

Persisted attachment compatibility belongs in normalization. Runtime APIs expose only current names, and canonical writes remove legacy fields.

### D-session-channels-source-reader

Best-channel selection keeps narrow readers for persisted source wrappers while every new inbound message uses the current channel wrapper.
