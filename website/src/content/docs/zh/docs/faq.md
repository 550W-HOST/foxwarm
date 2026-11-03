---
title: 常见问题
description: 关于 Foxwarm 是什么、安装与登录、模型、对话、节点、渠道和日常运维的简短解答。
---

## 关于 Foxwarm

### foxwarm.net 是托管服务吗？

不是。这个网站只提供文档和安装脚本。Foxwarm 运行在你自己的电脑或服务器上，对话、文件和密钥都留在那里。

### 收费吗？

Foxwarm 免费开源，采用 MIT 协议。你只需要为模型服务商的 token 用量付费；如果用本地模型，则完全不用付费。给模型配置 [pricing](/zh/docs/model-options/#单模型设置) 后，可以看到每条回复的估算费用。

### 能用哪些模型？

任何兼容 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages 格式的端点都可以，包括本地服务和网关。可以配置多个服务商，并按会话切换。见[配置第一个模型](/zh/docs/model-setup/)和[模型选项与路由](/zh/docs/model-options/)。

### 和终端或编辑器里的编程 Agent 有什么不同？

Foxwarm 是一个常驻运行的服务器。对话会持久保存，可以持续好几天，重启后还在，太长时会被压缩而不是截断。工作可以交给其他会话和 Agent，可以通过节点在其他机器上执行，也可以从浏览器、手机或团队群聊里访问。见 [Foxwarm 如何工作](/zh/docs/how-it-works/)。

## 安装与登录

### 能在 macOS 上运行吗？

可以，支持 macOS 15 或更新版本的 Apple Silicon Mac，安装命令和 Linux 相同。Intel Mac 不能作为服务器运行，也没有 macOS 桌面版。任何 Mac 都可以作为[节点](/zh/docs/nodes/)接入其他服务器。见 [macOS（Apple Silicon）](/zh/docs/installing/#macosapple-silicon)。

### 在哪里登录？

在你自己的实例上，使用启动时输出的链接，形如 `http://localhost:3001/#token=...`。如果找不到了，读取数据目录里的 `state/token`，见[打开 WebUI](/zh/docs/installing/#打开-webui)。

WebUI 令牌、节点配对令牌和外部 MCP 身份令牌是不同的凭据，连接哪个接口就用哪个。

### 能用手机访问吗？

可以。WebUI 支持手机浏览器；如果手机访问不到你的服务器，可以通过你常用的 VPN 或反向代理接入。也可以通过[渠道](/zh/docs/channels/)在聊天软件里和会话对话。

### 能让别人使用我的实例吗？

不要分享你的登录令牌，它是完整的管理员凭据。可以给对方一个只能打开指定会话的身份，见[限定范围的 WebUI 访问](/zh/docs/access-control/#scoped-webui-access)（英文），或者把对方加入某个渠道的允许列表。

### 为什么 Setup 一直弹出来？

Foxwarm 当前使用的数据目录里还没有 `state/models.yaml`。在 [Setup → Models](/zh/docs/model-setup/) 里保存一份模型配置即可。如果你原本已经有配置，先确认 Foxwarm 指向的是正确的数据目录，再考虑新建。

## 模型

### 模型配置保存成功了，但对话失败，该查什么？

保存时只检查配置，不会请求服务商。检查服务商类型、基础地址、准确的模型 ID 和 API Key，然后发一条简短的纯文字消息。确认可用后再开启托管工具。错误日志在 `state/logs/` 下。

### 不同会话能用不同的模型吗？

能。每个会话有自己的模型和推理强度，可以在输入框旁的菜单里修改，或者用 `/model`。子会话也可以使用和父会话不同的模型。

## 对话与 Agent

### 对话特别长时会怎样？

Foxwarm 会压缩它：较早的部分被总结成可以展开的块，原始消息保存在归档里，Agent 可以随时回溯。你也可以手动运行 `/compact`。见[长对话与历史检索](/zh/docs/history-search/)（英文）。

### 重启后工作还在吗？

在。会话、历史、排队中的消息和定时任务都会保存。重启后，正在处理中的会话会自动恢复，让 Agent 检查被中断的地方。如果某个会话停住了，可以用 `/continue` 在不添加新消息的情况下继续。

### 怎么给 Agent 长期有效的指令？

写进 Agent 的记忆文件 `agents/<agent>/memory/`，或者直接让 Agent 记住。见 [Agent、会话和记忆](/zh/docs/agents-sessions-memory/)（英文）。

### 怎么让 Agent 停下来？

在 WebUI 里点停止按钮，或者发送 `/stop`。

### 怎么限制 Agent 能做的事？

使用工具规则：可以按整个实例设置，也可以按 Agent 设置，让 Agent 创建的帮手拥有比它更少的权限。见[访问控制](/zh/docs/access-control/)（英文）。

## 节点与安全

### 节点是沙箱吗？

不是。节点上的命令以运行节点客户端的用户身份执行，那个用户能做的它都能做。需要更强的隔离时，请使用容器或专用的用户和机器，并用[工具规则](/zh/docs/access-control/)（英文）决定哪些 Agent 可以使用哪个节点。

### 需要在节点上放 API Key 吗？

不需要。模型、MCP 服务器及其凭据都留在 Foxwarm 服务器上，节点只执行交给它的文件、命令和浏览器操作。

### 为什么 Foxwarm 访问不到 `localhost` 上的服务？

`localhost` 指的是发出请求的那台机器或那个容器。在容器里，它就是容器本身；在节点上，它就是那个节点。请使用从发出请求的位置能访问到的地址。

如果模型服务运行在 Docker 主机上，可以使用 `host.docker.internal`，仓库的 Compose 文件已经把它映射到主机。服务本身也要监听在容器能访问到的地址上。

## 渠道

### 渠道已连接，但发消息没有回复，为什么？

依次检查：发送者的平台用户 ID 是否在 `allowedUsers` 里（发送 `/whoami` 可以看到），这个聊天是否接到了预期的会话，机器人是否有在这里发言的权限。[渠道指南](/zh/docs/channels/#检查连接)里有完整的排查步骤。

### 机器人在群里不理人。

QQ 机器人在群里默认需要 @ 才会回复，设置 `requireMention: false` 可以处理所有消息。不在允许列表里的群成员会被拒绝，除非你在这个群里开启了 `/channel dangerously-allow-all-users yes`。见[谁能和 Agent 对话](/zh/docs/channels/#谁能和-agent-对话)。

## 运维

### 保存了 Config，需要重启吗？

在 **Setup → Config** 里保存后，渠道、访问身份和 `sessionAutoTitle` 的修改会立即生效。HTTP 端口、节点 Provider、语义检索、入站 MCP 监听等启动设置需要重启。在 **Setup → Models** 里修改模型永远不需要重启。

使用 Docker 时，修改端口还需要同步修改端口映射（使用 Compose 时还有健康检查），见 [Docker](/zh/docs/installing/#docker)。

### 怎么升级？

先备份数据目录，然后在程序目录里运行 `foxwarmctl update`，或者拉取新的容器镜像。见[更新预编译安装](/zh/docs/data-upgrades-backups/#update-a-release-installation)（英文）。

### 需要备份什么？

整个数据目录（默认是 `foxwarm-data`），在 Foxwarm 停止时复制，或者使用与 SQLite 一致的在线备份。见[需要备份什么](/zh/docs/data-upgrades-backups/#what-to-back-up)（英文）。

### 在哪里反馈问题？

在 [issue 列表](https://github.com/550W-HOST/foxwarm/issues)提交。请附上 Foxwarm 的 commit、平台、安装方式、错误信息和复现步骤。分享日志前，先删掉令牌、API Key、私人消息和个人路径。
