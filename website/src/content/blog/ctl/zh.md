---
title: 给模型一个 CLI：Foxwarm 0.9.6 怎样把几十个工具收进 ctl
description: agent 运行时能做的事越来越多，每样都做成一个工具，每次请求都要背着几十份 schema。0.9.6 换了个思路：常用的留着，其余的交给一个模型早就会用的东西，命令行。
date: 2026-11-17
series: Agent 设计笔记
version: Foxwarm 0.9.6
---

一个长期运行的 agent 平台，能让模型做的事情会越来越多。读写文件、跑命令是基本的；然后是管理会话、切换执行机器、在机器之间拷文件、读写记忆、设定时器、发消息到群聊、存密钥、查历史……每加一项能力，最自然的做法是加一个工具。

工具多了，问题也就来了。这篇讲 Foxwarm 0.9.6 的做法：只保留最常用的十几个工具，其余的操作全部收进一个叫 `ctl` 的命令工具，用模型早就熟悉的命令行语法来调用。

## 每个工具都有成本

函数调用（function calling）的工具，要在每次请求里把名字、描述和参数 schema 全部发给模型。工具越多，这部分越大，而且不管这一轮用不用得到，都要带上。

0.9.5 的时候，Foxwarm 默认给模型声明 31 个工具，序列化后约 51 KB，每次请求都要带上。可它们被用到的频率差得很远。我们统计了自己日常使用的实例 30 天里的 13.8 万次工具调用：

- `exec` 6.2 万次，`read` 4.6 万次，`write`、`task`、`wait`、`edit`、`run_script` 各几千次；
- 管理会话、读写记忆、发文件这类操作，一个月几十到几百次；
- 还有一些工具因为太少用，干脆不默认声明，比如定时器一个月 42 次、改配置 33 次、移动会话 6 次。模型要用它们，得先调 `search_tools` 搜到，再通过 `call_tool` 间接调用，往往还要先读一个 skill 才知道该搜什么。

结果是两头不讨好：常用的少数几个工具，背着一长串很少用的工具一起发；真正不常用的，又要绕三步才用得上。

## 常见做法：先搜索，再加载 schema

工具多了要按需加载，这已经是共识，几个熟悉的 agent 都有自己的办法，主要针对接进来的 MCP 工具：

- **Claude Code** 默认开启 MCP tool search：会话开始时只加载工具名和服务器说明，模型需要时用 ToolSearch 找到工具，再加载完整定义。
- **Pi** 让每个 MCP 服务器选择暴露方式：`direct` 像内置工具一样直接声明；`deferred` 要先用 `tool_search` 找到，找到后在当前分支上保持声明；`codemode` 让模型在脚本里调用；`hidden` 则完全不暴露。服务器状态有变化时，Pi 把新的说明追加到对话里，而不是改工具声明，这样之前的请求前缀还能命中缓存。
- **DeepSeek Harness** 的 PTC 模式只直接暴露一个 `run_code`，再按可见的工具生成一份 SDK 声明，模型写程序调用。文档也说得很坦白：这是拿 SDK 文本换 schema，不保证一定更省。

这些办法的共同点是：工具的基本单位仍然是"名字 + JSON schema"，只是推迟加载，或者换一种写法。

## 换个思路：模型已经会用命令行

讨论这个问题时，有一个观察让我们换了方向：模型见过的命令行太多了。`kubectl get pods`、`systemctl restart nginx`、`git log --oneline`，"名词 + 动词 + 参数，`--help` 看用法"这套约定，在训练数据里到处都是。一个设计规整的 CLI，模型常常不看文档就能猜对；猜错了，看一眼 usage 就能改对。

于是 0.9.6 的接口是这样的：

```
ctl node list
ctl node copy build-box /work/out.tar.gz master /data/out.tar.gz
ctl history recall B#126
ctl memory edit notes.md --old-text @old --new-text @new
```

- 一个工具，`ctl`，参数是一行命令。按 `<noun> <verb> [arguments]` 组织，有 16 个名词、68 条命令：session、history、agent、node、memory、skill、file、image、artifact、channel、timer、script、config、secret、mcp、tool。
- **用法逐层展开。** `ctl` 的描述只列出名词和几条最常用的命令，整份声明约 1.6 KB。`ctl node --help` 列出动词，`ctl node copy --help` 给出完整参数。
- **长文本和 JSON 不塞进引号。** 命令行里写多行文本、写嵌套 JSON，很容易出错。所以在命令里写 `@name`，内容放进单独的 `values` 字段，按原样取用。
- **它不是 shell。** 命令按 POSIX 规则切分引号，不做任何展开；出现管道、分号、重定向直接报错，并提示要组合多条命令就用 ToolScript。
- **MCP 和节点上的工具也从这里进。** `ctl tool search <词>` 把命令、MCP 工具和节点工具放在一个列表里；`ctl tool call <id> --args @args` 调用；`--help` 查看参数。

调用频率高的，或者本身控制着这一轮怎么结束的工具，仍然保留原生声明：`read`、`write`、`edit`、`exec`、`run_script`、`continue_script`、`wait`、`ask_user`、`send_to_session`、`create_child_session`、`task`、`submit_compact_plan`，再加上 `ctl`。原生 schema 能保证这些高频调用的参数质量，也少一层间接。哪些留、哪些收，是按上面那份 30 天的调用统计定的。

默认声明从 31 个工具降到 13 个，序列化后从 50.8 KB 降到约 30 KB，少了约四成。工具列表现在固定不变，模型用到一条新命令，也不会改动请求前缀；换成新声明时，每个会话的缓存失效一次，之后就一直稳定。

## 一份注册表，四个入口

`ctl` 背后是一份手工维护的命令注册表。每条命令写明名词、动词、参数类型、帮助文本，以及它最终调用哪个具体能力。

同一份注册表还服务另外三个入口：

- **你在聊天框里输入的 `/` 命令。** `/session list`、`/node select build-box` 和 `ctl` 是同一套语法、同一份帮助。有些命令只给人用，比如 `/continue`、`/fork`、删除消息，模型看不到。
- **外部 MCP 客户端。** 接入 Foxwarm 的 MCP 客户端多了一个 `ctl` 工具，能用开放给外部的那部分命令。
- **ToolScript。** 脚本里写 `ctl("tool search copy")`，拿到的是结构化结果。

人和模型用同一套命令，文档、帮助和报错只需要写一份；模型在工具输出里看到的下一步提示（比如"展开这个摘要块"），也直接写成能复制执行的 `ctl` 命令。

## ctl 不带任何权限

把一堆操作塞进一个工具，最容易出问题的是权限。

我们的出发点是：工具就像系统调用，运行时能看懂它在做什么，才能按调用者的身份鉴权；`exec` 只是其中一个系统调用，作用是把执行交给某台机器；ToolScript 是一个本身没有权限的解释器。`ctl` 也一样，它只是一个前端。

一次 `ctl node copy …` 先被解析成对应的具体工具调用，然后走和直接调用完全相同的路径：同样的规则判定、同样的审批卡片、同样的活动记录。已有的权限规则一条都不用改。帮助和搜索结果也按调用者的规则过滤：确定被禁止的命令不会出现在 `--help` 里，直接调用会被告知"当前会话不可用"，而不是"命令不存在"。

不过，同一个操作现在可以从好几个入口到达：直接调用、`ctl`、ToolScript、`/` 命令、外部 MCP。按工具名写的规则开始显得脆弱。所以 0.9.6 同时让规则可以按**操作**来写：`op: node.select` 加上 `action: deny`，不管模型用哪个工具、哪种写法去切换节点，都会被拦下。这一部分以后单独写一篇。

## 报错也是接口

`ctl` 上线后的头一天半，我们看了自己实例上模型直接发出的调用：8,659 次工具调用里有 315 次是 `ctl`，失败 11 次，大部分在下一步就自己改对了。查 `--help` 的约占 6%。

失败的调用很有参考价值，因为它们就是模型"自然会猜"的写法：

- `sessions list`，名词写成了复数；
- `memory edit --old … --new …`，选项名写了缩写；
- `session rename <id> "<name>"`，把要改的会话 ID 当成了第一个参数（实际要用 `--session-id`）。

一种做法是把这些猜法都收下，加别名、接受缩写。我们没有这么做：每条命令只有一种写法，规则和文档才清楚；接受缩写的话，以后加一个新选项，可能会悄悄改变一条旧命令的含义。所以我们改的是报错，目标是让模型**重试一次就能成功**：

- 复数名词直接提示对应的命令：`sessions list` → `session list`；
- 不认识的选项，提示以它开头或拼写接近的选项：`--old` → `--old-text`；
- 多出来的位置参数，说明这条命令有哪些位置参数、每个被填成了什么。

另外，被调用最多、又常常要先查 `--help` 的几条命令（`node copy`、`node select`、`history recall`、`skill load`、`session view`、`tool search`），我们把用法直接写进了 `ctl` 的描述里。描述每次请求都要带，所以只放这几条。

`tool search` 的输出也收紧了：已有命令的内置能力，只显示成一行命令用法，不再附带整份 schema。搜 "copy file between nodes" 的结果从 5.4 KB 降到 614 字节。

## 取舍

- **多了一层间接。** 一条没用过的命令，模型可能要先花一轮查 `--help`。高频操作保留原生声明，就是为了不在主路径上付这个代价。
- **结构化参数没那么顺手。** `@name` 解决了长文本和 JSON，但嵌套参数写在命令行里，终究不如 JSON schema 直观。
- **校验位置变了。** 原生工具的参数由 schema 约束，`ctl` 的命令行要由解析器检查类型，错误在调用之后才报。
- **注册表要人来维护。** 帮助文本、参数名、报错都是写给模型看的文案，每一处都要有人把关。我们特意没有从 schema 自动生成，因为好用的命令行需要编辑，而不是翻译。
- **升级要改东西。** `search_tools` 和 `call_tool` 被直接删除，没有过渡期。调用它们的脚本、提到它们的 memory 和 skill 都要更新；`update` 时会逐条给出警告。

## 试一试

升级到 0.9.6 之后，模型那边不需要任何设置。你可以在聊天框里输入 `/help` 看看人能用的命令；在 ToolScript 里用 `ctl()` 组合多条命令。升级前请先读 [0.9.6 的升级说明](https://github.com/550W-HOST/foxwarm/blob/main/docs/release-notes/v0.9.6.md)，尤其是脚本和规则里用到 `search_tools` 的部分。

## 参考

- Claude Code 文档：[MCP](https://code.claude.com/docs/en/mcp)，[Scale with MCP tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)（2026-11 读取）。
- Pi 文档：[MCP](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/mcp.md)（[Control tool exposure](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/mcp.md#control-tool-exposure)）与 [Codemode](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/codemode.md)（earendil-works/pi，v1.5.2）。
- DeepSeek Harness：[tool-executor-ptc](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/core/tool-executor-ptc/README.md)（dsh-v0.2.2-rc.3）。
- Foxwarm：[0.9.6 release notes](https://github.com/550W-HOST/foxwarm/blob/main/docs/release-notes/v0.9.6.md)；Code Index [`units/ctl-command-registry.md`](https://github.com/550W-HOST/foxwarm/blob/main/docs/code-index/units/ctl-command-registry.md)、[`units/tool-operation-authorization.md`](https://github.com/550W-HOST/foxwarm/blob/main/docs/code-index/units/tool-operation-authorization.md)。
