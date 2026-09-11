---
title: Tools, Skills, and MCP
description: Learn how Foxwarm uses built-in tools, reusable Skills, Nodes, and configured MCP servers.
---

Built-in and Node tools perform actions, Skills provide instructions, and MCP servers add external tools.

## Tools perform actions

Tools are callable operations for work such as reading files, running commands, searching memory, managing Sessions, or using a Node capability. What is available depends on the current Agent, Node, configuration, and authorization rules.

Give tools only the scope they need. Review the Agent and its tools before exposing a new workspace, service, or environment that contains credentials.

## Skills provide reusable process knowledge

A **Skill** is a documented workflow in a `SKILL.md` file, with optional supporting resources. Foxwarm catalogs visible Skills automatically for each Session. Loading one gives the Agent its full instructions; tool, operating-system, and network access stay unchanged.

List visible Skills or read one in full with:

```text
/skill list
/skill show <skill>
```

An Agent can load the same instructions with:

```text
skill({ action: "load", skillName: "<skill>" })
```

The Session snapshot contains the visible Skill catalog. Foxwarm reads the full documents when the Agent loads a Skill.

## MCP connects external tool servers

Model Context Protocol (MCP) servers add tools over stdio, Streamable HTTP, or SSE. Foxwarm stores MCP server configuration in its data directory and provides tools to list, add, update, disable, or remove servers.

Load the bundled `mcp-management` Skill before changing MCP configuration. It walks the Agent through the configuration tools. Avoid editing the persisted MCP state by hand while Foxwarm is running.

After configuring a server, list its tools before calling one. Check what the server can reach, because its own configuration may give it access to files, services, or accounts outside Foxwarm.

:::caution
Keep real tokens out of documentation, chat examples, committed Agent memory, and tool descriptions. Put credentials in your private runtime data or the external service's supported secret store.
:::

## From instructions to execution

```text
Skill: explains a reliable workflow
  ↓
Tool: performs one action
  ↓
Source: built-in, MCP server, or current Node
```

ToolScript can coordinate several tool calls in one automation. The repository includes [ToolScript examples](https://github.com/550W-HOST/foxwarm/tree/main/examples/toolscript) for the next step.
