---
title: Channels
description: Connect Foxwarm Sessions to WebUI or a supported messaging platform.
---

A **Channel** carries messages between an interface and Foxwarm Sessions. WebUI is the simplest place to begin. Once the local model and Session work, you can add a messaging platform.

Foxwarm currently includes managed adapters for:

- Telegram
- Matrix
- WeWork
- Weixin
- QQ Bot

## Set up a Channel

Open **Setup → Config** in WebUI. The editor writes `state/config.yaml` in the active data directory. Saving the file also refreshes managed Channels without a full Foxwarm restart.

Each provider has its own credentials, platform setup, conversation IDs, and allow-list controls. Follow its example in the repository README and start with a narrow user or target allow list.

Use these commands to inspect or control the runtime:

```text
/channel status
/channel start <channel-id>
/channel stop <channel-id>
/channel restart <channel-id>
```

## Keep attachments scoped

Each external conversation resolves to a Foxwarm Session. Attach different users, groups, and purposes to the Sessions or Agents that fit them. Avoid routing every source into one high-privilege workspace.

A Channel can bring untrusted text and attachments into an Agent. Check the Agent's tools, current Node, and external service permissions before enabling a public or group-facing integration.

## Troubleshooting

- Save the configuration again in Setup and read any reload error.
- Run `/channel status` to inspect managed runtime state.
- Check `foxwarm-data/state/logs/`.
- Compare the provider settings with its callback URLs, ports, event subscriptions, tokens, and allow lists.

The root [README Channel section](https://github.com/550W-HOST/foxwarm#channels-stateconfigyaml-and-hot-reload) has current YAML examples and provider notes. Keep credentials in your private data directory.
