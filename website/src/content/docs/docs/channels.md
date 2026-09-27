---
title: Channels
description: Configure a messaging platform, restrict who can use it, and connect conversations to Sessions.
---

A Channel carries messages between a messaging platform and Foxwarm Sessions. The managed adapters are Telegram, Matrix, WeWork, Weixin, and QQ Bot. You can configure several instances of the same adapter.

## Add a Channel

Open **Setup → Config** and add an entry under `channels` in `state/config.yaml`. The entry's key is its instance ID; `type` selects the adapter. Each example below is a separate starting point. To configure several Channels, put their entries under one `channels` mapping.

Use platform user IDs in `allowedUsers`, not display names. Grant access to the people who should be able to send work to your agent, then check which Session receives the conversation. A connected bot and an authorized sender do not by themselves define the agent's tool permissions.

Saving Config restarts the managed Channel connections with the new settings. Check the status shown in Setup, or run:

```text
/channel status
```

## Telegram

```yaml
channels:
  telegram:
    type: telegram
    enabled: true
    botToken: "replace-with-your-bot-token"
    mainAttachUser: "your-telegram-user-id"
    allowedUsers:
      - "your-telegram-user-id"
```

Use the bot token for this Telegram bot and your numeric user ID as a string. `mainAttachUser` attaches that user's conversation to the main Session and includes the user in the allow list. Additional users belong in `allowedUsers`; configure their Session attachments separately.

## Matrix

```yaml
channels:
  matrix:
    type: matrix
    enabled: true
    homeserver: "https://matrix.example.com"
    accessToken: "replace-with-the-bot-access-token"
    botUserId: "@foxwarm:matrix.example.com"
    allowedUsers:
      - "@your-user:matrix.example.com"
```

The access token and `botUserId` must belong to the same bot account. Use full Matrix user IDs in the allow list. The conversation target is the room ID, which is different from a sender's user ID.

## Weixin

Use **Start Weixin login** at the bottom of **Setup → Config**. Scan the QR code or open the pairing link, then select **Check login**. On success, Foxwarm saves the credentials and refreshes the Channel.

Review the resulting Channel entry and its access settings before using it. Limit `allowedUsers` to the intended users; enable `allowAllUsers` only if you intend to accept messages from everyone who can reach that bot. Do not copy the login token into a public example or repository.

After a restart, an incoming message may be needed before Foxwarm can send to that user again because the reply context is kept in memory.

## QQ Bot

```yaml
channels:
  qq-primary:
    type: qqbot
    enabled: true
    appId: "replace-with-your-app-id"
    clientSecret: "replace-with-your-client-secret"
    allowedUsers:
      - "allowed-user-openid"
    requireMention: true
```

Use credentials from your QQ Bot application and the actual OpenIDs delivered for allowed users. The app must have access to the conversation and the relevant message events on QQ's side.

By default, a group message must mention the bot to trigger a turn. Foxwarm can retain a bounded amount of preceding ordinary group chat as context for that mention. To process ordinary group messages too, set `requireMention: false`; ordinary text is then batched over a fixed window, which defaults to five seconds. `groupBatchWindowMs: 0` disables that batching. Mentions and media are handled immediately.

C2C and group conversations support text and supported image/file attachments. Guild and guild-DM media are not supported. Conversation IDs use the forms `c2c:<openid>`, `group:<group-openid>`, `guild:<channel-id>`, and `dm:<guild-id>`; these identify destinations, not the users in `allowedUsers`.

## WeWork

For an intelligent bot using a WebSocket connection:

```yaml
channels:
  wework:
    type: wework
    enabled: true
    allowedUsers:
      - "allowed-user-id"
    aibot:
      stream: true
      websocket:
        enabled: true
        botId: "replace-with-your-bot-id"
        secret: "replace-with-your-bot-secret"
```

This mode receives messages without a public callback URL. `stream: true` keeps the response and tool progress in a stream card.

For HTTP callbacks instead, configure `token`, `encodingAESKey`, `listenPort`, and `listenPath`, with the same values and reachable callback URL in the platform's bot configuration. Keep `aibot.websocket.enabled` off for that setup. A `webhookUrl` is a separate group-robot delivery option; it is not required just to receive intelligent-bot callbacks.

When both WebSocket delivery and a webhook are configured, ordinary proactive sends use the enabled WebSocket connection. A failed WebSocket send is not automatically resent through the webhook.

## Session attachments and access

A Session attachment connects a specific Channel conversation to a Session. An instance ID such as `qq-primary`, a conversation ID such as `group:<group-openid>`, and a sender's OpenID are different values.

Ask the agent to inspect and attach the intended Channel conversation to the intended Session. Keep different users and purposes separate when they should not share conversation history or tool access. The agent's `send_to_channel` tool uses `<channel-instance-id>:<conversation-id>` for an explicit destination.

Normal replies are delivered to the attached conversation automatically. A send-only attachment requires explicit delivery. Opening a group to more senders also exposes the receiving agent to their text and files; use an appropriately restricted Agent and Node.

## Optional progress messages

For a Channel that uses ordinary text replies, add this inside its existing entry:

```yaml
channelProgress:
  intervalMs: 60000
```

Foxwarm then sends a brief tool-progress update during longer work. The interval is in milliseconds and must be between 30,000 and 1,800,000. Omit the setting or use `false` to disable it. WebUI and active WeWork stream cards use their own progress display.

## Check a connection

1. Check Setup's Channel status and any save/reload error.
2. Send a short message from an allowed user in the intended conversation.
3. Confirm the conversation is attached to the expected Session.
4. If messages arrive but replies fail, check the platform credentials, destination, and delivery permissions in `state/logs/`.

For manual control, use `/channel start <channel-id>`, `/channel stop <channel-id>`, or `/channel restart <channel-id>`. These use the configured instance ID, not the adapter type unless you chose the same name for both.
