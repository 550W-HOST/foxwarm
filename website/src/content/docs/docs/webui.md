---
title: Using the WebUI
description: "Find your way around the Foxwarm browser interface: Sessions, timeline views, Nodes, terminals, code and settings."
---

The WebUI is where you talk to agents, watch their work and manage your instance. It works on desktop and mobile browsers.

## Layout

- **Sidebar:** the Session list, grouped as a tree so child Sessions appear under their parents. Above it are **Agents** (overview of all Agents), **Code** and **Terminal**. At the bottom are **Tasks**, history search and settings.
- **Session header:** the Session name, ID and working directory, with **Find** (search this conversation), **Code** and the Session options menu.
- **Timeline:** the conversation, including the agent's tool calls and results.
- **Composer:** the message box, with pickers for the model and reasoning effort and for the Session's current [Node](/docs/nodes/).
- **Status bar:** running and waiting work, open Tasks, token usage and connected Nodes.

Selecting a Node in the composer changes where the Session's tools run next, without sending a message.

## Timeline views

Choose a view from the Session options menu in the header, under **Timeline view**:

| View | Shows | Good for |
| --- | --- | --- |
| **Conversation** | Your messages and the agent's replies. Tool activity is folded into short "worked for…" summaries you can expand. | Following the result; the default on mobile |
| **Grouped** | Replies with consecutive tool calls grouped together. | A balance of outcome and process |
| **Detailed** | Every tool call, its arguments and output, inline. | Reviewing exactly what the agent did |

The same menu can show or hide inter-agent messages, the agent's commentary, usage badges and the timeline minimap, and switch to full width.

## Long conversations

When older parts of a Session are [compacted](/docs/history-search/), they appear as context blocks with a summary. Expand a block to read the summary; the original messages remain in the archive, and the agent can recall them.

Use **Find** in the header to search the current conversation, or history search in the sidebar to search across Sessions.

## Terminal and code

**Terminal** opens a real shell in the browser, next to the conversation, on `master` or another Node that supports terminals. It runs with your administrator access, not through an agent's tool rules.

**Code** opens a VS Code–based editor for files on the Foxwarm server or a Node, and lets you open files the agent touched straight from its tool results. The editor needs an optional asset bundle that is not part of the normal build; see [optional components](/docs/installing/#optional-components).

## Setup and settings

The settings button at the bottom of the sidebar opens **Setup**, where you edit models (`state/models.yaml`) and application configuration (`state/config.yaml`), check Channel status and pick a theme. Saving Config refreshes Channels right away; startup settings such as the HTTP port, Node providers, semantic search and inbound MCP need a restart. See the [FAQ](/docs/faq/#i-saved-config-do-i-need-to-restart).

## Sharing an instance

The sign-in token gives full administrator access. To let someone use only certain Sessions in their browser, give them a separate identity with [scoped WebUI access](/docs/access-control/#scoped-webui-access) instead of your token.
