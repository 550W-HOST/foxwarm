---
title: "Give the model a CLI: how Foxwarm 0.9.6 folds dozens of tools into ctl"
description: "An agent runtime keeps gaining capabilities, and if each one becomes a tool, every request carries dozens of schemas. 0.9.6 takes another route: keep the common tools, and hand everything else to something models already know how to use, the command line."
date: 2026-11-17
series: Agent Design Notes
version: Foxwarm 0.9.6
---

A long-running agent platform keeps finding more things for the model to do. Reading and writing files and running commands are the basics. Then come managing Sessions, switching the machine it works on, copying files between machines, reading and writing memory, setting timers, posting to group chats, storing secrets, searching history… Each new capability most naturally becomes one more tool.

With enough tools, problems follow. This post covers what Foxwarm 0.9.6 does about it: keep only the dozen or so most-used tools, and fold every other operation into a single command tool called `ctl`, which the model calls with the command-line syntax it already knows.

## Every tool has a cost

With function calling, each tool's name, description and parameter schema go to the model on every request. The more tools, the bigger that part gets, and it goes along whether or not this turn needs it.

In 0.9.5, Foxwarm declared 31 tools to the model by default: about 51 KB serialized, carried on every request. Yet they were used at very different rates. We counted 138,000 tool calls over 30 days on the instance we use every day:

- `exec` was called 62,000 times and `read` 46,000; `write`, `task`, `wait`, `edit` and `run_script` a few thousand times each.
- Operations such as managing Sessions, reading and writing memory, and sending files ran from a few dozen to a few hundred times a month.
- Some tools were used so rarely that they weren't declared by default at all: timers 42 times a month, configuration changes 33, moving a Session 6. To use one, the model first had to find it with `search_tools`, then call it indirectly through `call_tool`, often after reading a Skill just to learn what to search for.

The result was bad at both ends. The few heavily used tools traveled with a long list of rarely used ones on every request, and the genuinely rare ones took three steps to reach.

## The usual approach: search first, then load the schema

Once there are many tools, loading them on demand is the consensus, and several familiar agents have their own way of doing it, mostly for connected MCP tools:

- **Claude Code** turns on MCP tool search by default. At session start it loads only tool names and server instructions; when the model needs a tool, it finds it with ToolSearch, and then the full definition is loaded.
- **Pi** lets each MCP server choose how its tools are exposed. `direct` declares them like built-in tools. `deferred` tools must first be found with `tool_search`, after which they stay declared on the current branch. `codemode` lets the model call them from scripts, and `hidden` doesn't expose them at all. When a server's state changes, Pi appends the new instructions to the conversation instead of changing the tool declarations, so earlier request prefixes still hit the cache.
- **DeepSeek Harness**, in its PTC mode, exposes only `run_code` directly and generates SDK declarations for the visible tools, which the model calls by writing programs. Its documentation is candid that this trades schemas for SDK text and doesn't guarantee savings.

What these have in common is that the basic unit is still a name plus a JSON schema. They defer loading it, or write it in a different form.

## Another idea: models already know the command line

One observation changed our direction while we were discussing this: models have seen an enormous amount of command-line usage. `kubectl get pods`, `systemctl restart nginx`, `git log --oneline`: the convention of noun, verb and arguments, with `--help` for usage, is everywhere in training data. Given a consistently designed CLI, a model often guesses right without reading any documentation, and when it guesses wrong, one look at the usage is enough to fix it.

So this is the interface in 0.9.6:

```
ctl node list
ctl node copy build-box /work/out.tar.gz master /data/out.tar.gz
ctl history recall B#126
ctl memory edit notes.md --old-text @old --new-text @new
```

- One tool, `ctl`, whose argument is one command line in the form `<noun> <verb> [arguments]`. There are 16 nouns and 68 commands. The nouns are session, history, agent, node, memory, skill, file, image, artifact, channel, timer, script, config, secret, mcp and tool.
- **Usage unfolds in layers.** The `ctl` description lists only the nouns and a few of the most common commands; the whole declaration is about 1.6 KB. `ctl node --help` lists the verbs, and `ctl node copy --help` gives the full arguments.
- **Long text and JSON stay out of quotes.** Multi-line text and nested JSON are easy to get wrong inside a command line. Instead, the command says `@name`, and the content goes in a separate `values` field, used exactly as given.
- **It isn't a shell.** Commands are split with POSIX quoting rules and nothing is expanded. Pipes, semicolons and redirections are rejected with an error that points to ToolScript for combining several commands.
- **MCP tools and Node tools come in through it too.** `ctl tool search <words>` lists commands, MCP tools and Node tools together; `ctl tool call <id> --args @args` calls one; `--help` shows its arguments.

Tools that are called very often, or that control how the turn ends, keep their native declarations: `read`, `write`, `edit`, `exec`, `run_script`, `continue_script`, `wait`, `ask_user`, `send_to_session`, `create_child_session`, `task` and `submit_compact_plan`, plus `ctl`. A native schema keeps the arguments of these frequent calls reliable and saves a level of indirection. Which tools stayed and which moved into `ctl` was decided from the 30-day call statistics above.

The default declarations went from 31 tools to 13, and from 50.8 KB to about 30 KB serialized, roughly 40% smaller. The tool list is now fixed, so using a command for the first time no longer changes the request prefix. Switching to the new declarations invalidates each Session's cache once, and after that it stays stable.

## One registry, four entry points

Behind `ctl` is a hand-maintained command registry. Each entry records a command's noun, verb, argument types and help text, and the concrete capability it ends up calling.

The same registry serves three other entry points:

- **The `/` commands you type in the chat box.** `/session list`, `/node select build-box` and `ctl` share one syntax and one set of help. Some commands are for people only, such as `/continue`, `/fork` and deleting messages; the model doesn't see them.
- **External MCP clients.** An MCP client connected to Foxwarm gets a `ctl` tool as well, which runs the commands open to external clients.
- **ToolScript.** A script that calls `ctl("tool search copy")` gets structured results back.

Because people and the model use the same commands, documentation, help and error messages are written once. When tool output suggests a next step to the model, such as expanding a summary block, the hint is a `ctl` command the model can copy and run.

## ctl carries no permissions

The riskiest part of putting many operations behind one tool is permissions.

We started from the view that tools are like system calls: the runtime can authorize a call against the caller's identity only if it understands what the call does. `exec` is just one such system call, whose job is to hand execution to some machine. ToolScript is an interpreter with no permissions of its own. `ctl` is the same: only a front end.

A `ctl node copy …` call is first parsed into the concrete tool call it stands for, and from there it takes exactly the same path as a direct call: the same rule checks, the same approval card, the same activity record. Not a single existing permission rule had to change. Help and search results are filtered by the caller's rules too. A command that is definitely denied doesn't show up in `--help`, and calling it directly reports that it isn't available to this Session, rather than that the command doesn't exist.

Still, the same operation can now be reached from several entry points: a direct call, `ctl`, ToolScript, `/` commands and external MCP. Rules written against tool names begin to look fragile. So 0.9.6 also lets rules be written against **operations**. `op: node.select` with `action: deny` stops the model from switching Nodes, whichever tool or spelling it uses. That part will get a post of its own.

## Error messages are interface too

For the first day and a half after `ctl` shipped, we looked at the calls the model made directly on our instance. Of 8,659 tool calls, 315 went to `ctl` and 11 of those failed; most were fixed by the model on its next step. Calls for `--help` made up about 6%.

The failed calls are worth studying, because they show what a model naturally guesses:

- `sessions list`, with the noun in the plural;
- `memory edit --old … --new …`, with abbreviated option names;
- `session rename <id> "<name>"`, with the ID of the Session to rename as the first argument (it takes `--session-id`).

One option would be to accept all of these, with aliases and abbreviations. We didn't. With one spelling per command, the rules and the documentation stay clear, whereas accepting abbreviations means an option added later could silently change what an existing command means. So we changed the error messages instead, with one goal: **the model's first retry should succeed.**

- A plural noun gets the matching command: `sessions list` → `session list`.
- An unknown option gets the options it begins or nearly spells: `--old` → `--old-text`.
- An extra positional argument gets a list of the positional arguments the command takes, and what each was filled with.

In addition, for the few commands that are called most and often needed a `--help` lookup first (`node copy`, `node select`, `history recall`, `skill load`, `session view` and `tool search`), we put the usage straight into the `ctl` description. The description travels with every request, so only these few are there.

`tool search` got more compact as well. A built-in capability that has commands now appears as one line of command usage, without the whole schema. Results for "copy file between nodes" went from 5.4 KB to 614 bytes.

## Trade-offs

- **One more level of indirection.** For a command it hasn't used before, the model may spend a turn on `--help` first. Keeping native declarations for the frequent operations is how we avoid paying that on the main path.
- **Structured arguments are clumsier.** `@name` takes care of long text and JSON, but nested arguments written in a command line are never as clear as a JSON schema.
- **Validation happens somewhere else.** A native tool's arguments are constrained by its schema; a `ctl` command line has to be type-checked by the parser, so errors are reported only after the call.
- **The registry needs people to maintain it.** Help text, argument names and error messages are all copy written for the model, and someone has to review every one. We deliberately didn't generate the registry from the schemas: a good CLI needs editing, not translation.
- **Upgrading requires changes.** `search_tools` and `call_tool` were removed outright, with no transition period. Scripts that call them, and memory and Skills that mention them, have to be updated; `update` prints a warning for each one.

## Try it

After you upgrade to 0.9.6, the model side needs no setup. Type `/help` in the chat box to see the commands people can use, and call `ctl()` from ToolScript to combine several commands. Before upgrading, read the [0.9.6 upgrade notes](https://github.com/550W-HOST/foxwarm/blob/main/docs/release-notes/v0.9.6.md), especially the parts about `search_tools` in scripts and rules.

## References

- Claude Code documentation: [MCP](https://code.claude.com/docs/en/mcp), [Scale with MCP tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search) (read November 2026).
- Pi documentation: [MCP](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/mcp.md) ([Control tool exposure](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/mcp.md#control-tool-exposure)) and [Codemode](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/codemode.md) (earendil-works/pi, v1.5.2).
- DeepSeek Harness: [tool-executor-ptc](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/core/tool-executor-ptc/README.md) (dsh-v0.2.2-rc.3).
- Foxwarm: [0.9.6 release notes](https://github.com/550W-HOST/foxwarm/blob/main/docs/release-notes/v0.9.6.md); Code Index [`units/ctl-command-registry.md`](https://github.com/550W-HOST/foxwarm/blob/main/docs/code-index/units/ctl-command-registry.md), [`units/tool-operation-authorization.md`](https://github.com/550W-HOST/foxwarm/blob/main/docs/code-index/units/tool-operation-authorization.md).
