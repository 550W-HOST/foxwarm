---
title: Tools, Skills, and MCP
description: Extend Foxwarm with built-in actions, reusable Skills, and configured MCP servers.
---

Foxwarm uses three separate extension layers.

## Tools perform actions

Tools are callable operations such as reading and writing files, running commands, searching memory, managing Sessions, or invoking a Node capability. Available tools depend on the current Agent, Node, configuration, and authorization rules.

Use the smallest scope that completes the task. Review tool calls before exposing a new workspace, service, or credential-bearing environment.

## Skills provide reusable process knowledge

A **Skill** is a documented workflow package with a `SKILL.md` file and optional supporting resources. Skills teach an Agent how to perform a task using tools it already has; attaching a Skill does not itself grant new operating-system or network access.

Useful commands include:

```text
/skill list
/skill attach <name>
/skill detach <name>
```

Foxwarm exposes a visible Skill catalog in the prompt. Full Skill documents are loaded when needed instead of placing every workflow into every request.

## MCP connects external tool servers

Model Context Protocol (MCP) servers can add tools over stdio, Streamable HTTP, or SSE transports. Foxwarm keeps MCP server configuration in its data directory and exposes management tools for listing, adding, updating, disabling, and removing servers.

The recommended workflow is to ask the Agent to load the bundled `mcp-management` Skill, then use the MCP configuration tools. Do not manually edit the persisted MCP state while Foxwarm is running.

After configuration, discover the server's tools before calling one. Confirm the server's trust boundary: an MCP server may reach files, services, or accounts outside Foxwarm according to that server's own configuration.

:::caution
Never place real tokens in documentation, chat examples, committed Agent memory, or tool descriptions. Configure credentials only in your private runtime data or the external service's supported secret store.
:::

## How the layers fit

```text
Skill: explains a reliable workflow
  ↓
Tool: performs one action
  ↓
Source: built-in, MCP server, or current Node
```

For automation that coordinates several tool calls, Foxwarm also includes ToolScript. Start with the [ToolScript examples](https://github.com/550W-HOST/foxwarm/tree/main/examples/toolscript) after the basic tool model is familiar.
