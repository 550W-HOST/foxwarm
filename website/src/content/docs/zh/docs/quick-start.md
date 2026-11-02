---
title: 快速开始
description: 安装 Foxwarm，添加模型，给 Agent 布置第一个任务。
---

这一页走最短的路径，让你得到一个能干活的 Agent。每一步都附有完整指南的链接，需要更多选项时再看。

## 1. 安装

在你希望放置 Foxwarm 程序目录和数据目录的位置，运行对应平台的命令。

**Linux x64 或 x64 WSL**

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
```

**Windows x64（PowerShell）**

```powershell
irm https://foxwarm.net/install-foxwarm.ps1 | iex
```

**Docker（Linux x64）**

```bash
mkdir -p foxwarm-data
docker run -d --name foxwarm --init -p 3001:3001 \
  -v "$PWD/foxwarm-data:/data" ghcr.io/550w-host/foxwarm:latest
```

安装脚本下载预编译版本，不需要编译。系统没有 ASP.NET Core 10 运行时时，会使用自带 .NET 的安装包。Windows 上另有桌面版。安装包和环境要求见[安装 Foxwarm](/zh/docs/installing/)。

安装完成后，脚本会启动 Foxwarm，并输出一个登录链接，形如 `http://localhost:3001/#token=...`。请像对待密码一样保管它。

## 2. 添加模型

打开登录链接。新安装的实例会打开 **Setup → Models**。粘贴一段服务商配置，例如：

```yaml
default: my-provider/my-model
providers:
  my-provider:
    providerType: openai-completions   # 或 openai-responses、anthropic
    baseUrl: https://api.example.com/v1
    apiKey: replace-with-your-key
    models:
      - my-model
```

保存后就可以开始聊天。保存时只检查配置格式，不会请求服务商；你发出的第一条消息才是真正的连通测试。各字段的含义见[配置第一个模型](/zh/docs/model-setup/)。

## 3. 给 Agent 布置任务

Foxwarm 自带一个 `main` Agent 和它的默认会话。先问一个简单的问题，然后在你放心让它操作的目录里，给它一个真实的任务：

```text
看一下 ~/projects/my-app，跑一遍测试，告诉我哪些失败了、为什么。先不要改任何东西。
```

你会在对话里看到 Agent 的工具调用和结果。会话会保存历史，之后随时回来都能接着聊，服务重启后也一样。

## 接下来

- [Foxwarm 如何工作](/zh/docs/how-it-works/)：服务器、Agent、会话、节点和渠道。
- [Agent、会话和记忆](/zh/docs/agents-sessions-memory/)：给 Agent 长期有效的指令和项目知识。
- [节点](/zh/docs/nodes/)：在另一台机器上执行工具。
- [渠道与群聊](/zh/docs/channels/)：在聊天软件里使用 Agent。
