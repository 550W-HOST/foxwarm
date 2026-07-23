# Unit: src-channel-core

Files: src/channel.ts, src/channelAuth.ts, src/channelFiles.ts, src/channelFiles.test.ts, src/channelRuntime.ts

## Purpose

Defines the platform-neutral channel contract/registry, authorization inspection, inbound file storage, and managed adapter lifecycle for Telegram, Matrix, WeWork, and Weixin instances.

## Key exports

### Channel contract and registry

- Channel/context/message/file/source types.
- `registerChannel`, `unregisterChannel`, `getChannelInstance`, `listRegisteredChannels`.
- `getChannelId`, `getChannelType`, `getConversationId`.

### Authorization and files

- `inspectChannelAuthorization`, context wrapper, result formatter/type.
- `saveInboundChannelFile`, `saveInboundSessionFile`, `buildSavedFileText`, `resolveChannelAgentName`.

### Managed runtime

- `initializeChannelRuntime`.
- `getManagedChannelIds`, `startManagedChannel`, `stopManagedChannel`, `restartManagedChannel`.
- `reloadManagedChannels`.
- `getChannelRuntimeStatus`, `listChannelRuntimeStatuses`.

## Registry and authorization

- The registry is one in-memory map keyed by channel instance ID.
- Internal WebUI/TUI sources are trusted at this boundary; external sources use configured allowlists or the per-attachment explicit allow-all-users override.
- Context helpers distinguish adapter type, concrete instance ID, and conversation ID.

## Inbound file behavior

- The current session/agent determines whether storage occurs on master or the isolated agent's node.
- Stored names use sanitized path segments and unique timestamps under the agent's temporary channel-files area.
- The model-facing descriptor gives node/path facts without prescribing a particular file tool.

## Runtime behavior

- `initializeChannelRuntime` stores inbound handlers and builds factories from normalized current config.
- `startManagedChannel` creates, starts, and registers one configured adapter; legacy main-attachment config is applied where supported.
- `reloadManagedChannels` stops **all** currently managed/registered Telegram, Matrix, WeWork, and Weixin instances, rebuilds factories from the latest config file, and starts every enabled/configured instance. It is a managed-channel restart, not an unchanged-config diff.
- Per-channel start/stop/restart APIs remain available.
- Failures are retained in runtime status rather than hiding the adapter from status inspection.
- Factories pass canonical config objects into adapters rather than duplicating every field.

## Compatibility

- Compatibility stored attachment fields are normalized by [src-session-channels](./src-session-channels.md#compatibility).
- Runtime lifecycle exports only current `reloadManagedChannels` naming.

## Canonical ownership

- Managed reload behavior: [D-channel-managed-reload](../modules/channels.md#d-channel-managed-reload).
- Channel type/instance/conversation identity: [D-channel-identity-vocabulary](../modules/channels.md#d-channel-identity-vocabulary) and [D-channel-multiple-instances](../modules/channels.md#d-channel-multiple-instances).
