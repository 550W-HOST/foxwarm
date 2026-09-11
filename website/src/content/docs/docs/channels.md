---
title: Channels
description: Connect a Foxwarm Session to WebUI or an optional messaging platform.
---

A **Channel** carries messages between an external interface and Foxwarm Sessions. WebUI is the recommended first interface. Add messaging Channels after the local model and Session flow works.

Managed Channel adapters on the current public Main source include:

- Telegram
- Matrix
- WeWork
- Weixin
- QQ Bot

## Configure Channels

Open **Setup → Config** in WebUI. The editor writes `state/config.yaml` in the active data directory. Saving the file also refreshes managed Channels without a full Foxwarm restart.

Each provider has its own credentials, platform setup, conversation identity, and allow-list controls. Follow the provider-specific example in the repository README and begin with the narrowest allowed user or target set.

Runtime commands are available for inspection and manual control:

```text
/channel status
/channel start <channel-id>
/channel stop <channel-id>
/channel restart <channel-id>
```

## Attach conversations deliberately

An external conversation must resolve to a Foxwarm Session. Keep separate users, groups, and purposes attached to appropriate Sessions or Agents; do not route every source into one high-privilege workspace by default.

Channels can expose the Agent to untrusted text and attachments. Review the Agent's tools, current Node, and external service permissions before enabling a public or group-facing integration.

## Troubleshooting

- Save Channel configuration again in Setup and inspect the displayed reload error.
- Run `/channel status` to see managed runtime state.
- Check `foxwarm-data/state/logs/`.
- Confirm that callback URLs, ports, platform event subscriptions, tokens, and allow lists match the chosen provider.

The root [README Channel section](https://github.com/550W-HOST/foxwarm#channels-stateconfigyaml-and-hot-reload) contains current YAML examples and provider-specific notes. Keep credentials in your private data directory.
