---
title: Tools, Skills, and MCP
description: Use built-in tools, load reusable Skills, and connect external MCP tool servers.
---

Tools perform actions such as reading files, running commands, or searching history. Skills provide instructions for a task. MCP servers add tools from another program or service.

## Use tools

Ask the agent for the task you want done. It can discover available tools and call them with the needed arguments. Availability depends on the Agent, selected Node, configured servers, and authorization rules.

Check the current Node before working on files or running commands. Review access before giving an agent a workspace or service containing private data. Tool authorization controls the call; the chosen environment determines what the command or external service can reach.

## Load a Skill

A Skill is a workflow written in `SKILL.md`, with optional scripts and reference files. Foxwarm includes the visible Skill catalog in each Session's prompt and reads a Skill's full instructions when it is loaded.

You can inspect Skills with:

```text
/skill list
/skill show <skill>
```

Or ask the agent to load the relevant Skill. The bundled `about-foxwarm` Skill introduces the system; `mcp-management` covers MCP configuration; `node-setup` covers Node pairing. Loading a Skill does not grant tools or change operating-system permissions.

## Connect an MCP tool server

Foxwarm supports stdio, Streamable HTTP, and SSE servers. Load the `mcp-management` Skill and ask the agent to configure the server using Foxwarm's MCP management tools. For example:

> Add an MCP server named project-tools using Streamable HTTP at my server's MCP URL. Then list the tools it exposes.

For a stdio server, provide its executable and arguments. For an HTTP server, provide its URL and required authentication settings through your private configuration. Credentials should not be stored in public Skill files or committed examples.

The configured servers are stored in `state/mcp.json` in the data directory. Use the management tools to update them while Foxwarm is running so its live connections and stored configuration stay in agreement.

After connecting, discover the server's tools and make a small permitted call. If discovery fails, check the server process or endpoint, credentials, and transport type before changing tool rules. A server's own permissions may let it reach files or accounts outside Foxwarm.

To make Foxwarm itself an MCP server, use the separate [external MCP client guide](/docs/mcp-inbound/).

## Combine calls with ToolScript

ToolScript lets the agent coordinate several tool calls in one script and work with their structured results. It is useful when a task needs repeated reads, transformations, or a sequence of dependent actions.

Load the `toolscript-automation` Skill for the calling conventions, or see the repository's [ToolScript examples](https://github.com/550W-HOST/foxwarm/tree/main/examples/toolscript).
