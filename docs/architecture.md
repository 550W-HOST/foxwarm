# 架构设计

Foxwarm 是一个以 **agent / session / tool-calling** 为核心的多渠道 AI assistant runtime。

## 一图概览

```text
Channels
  ├─ Telegram / Matrix / WeChat Work
  └─ WebUI
        ↓
Message Router
        ↓
Session Manager
  ├─ session queue
  ├─ channel attachment
  ├─ agent/session metadata
  └─ persistence
        ↓
LLM Engine
  ├─ model resolution
  ├─ prompt assembly
  ├─ tool-call loop
  └─ token accounting
        ↓
Tools / Nodes
  ├─ local tools
  └─ optional remote nodes
        ↓
State + Memory
  ├─ agents/<agent>/memory/
  ├─ state/token
  ├─ state/node_token
  ├─ state/sessions*.json
  ├─ state/db/
  └─ state/models.yaml
```

## 核心概念

### Agent
- 长期存在的工作区与 memory 容器
- 默认主 agent 位于 `agents/main`
- 可以存在 **没有任何 session** 的 agent

### Session
- 绑定到某个 agent 的运行时会话线程
- 保存历史、统计信息、queue、当前 node、model、aliases 等元数据
- 一个 agent 可以对应多个 session

### Skill
- 可复用的能力 / 方法包
- 通过 `skills/<skill>/` 提供文档型 memory
- 需要显式 attach 到 agent 才会进入 prompt

### `agent.inherit`
- 用于共享 memory 组合
- 表示知识继承链，不表示会话上下级或汇报关系

## Prompt 组装顺序

Foxwarm 会为每个 session 生成 `persistentMemorySnapshot`。当前 prompt 组装逻辑是：

1. inherited agent memory（按继承链从根到当前 agent）
2. 当前 agent 自身 memory
3. visible skills catalog（技能名 + 描述；完整文档按需通过 `load_skill` 加载）

生成后的 snapshot 会缓存到 session，并在相关变更时刷新。

## 运行时组件

### Channels
实现位置：`src/channels/`

- `telegramChannel.ts`
- `matrixChannel.ts`
- `weworkChannel.ts`
- `webuiChannel.ts`

> 注：代码中仍保留一些非主公开流程的运行入口，但首轮公开文档只保留当前建议用户使用的 channel/界面。

### Message Router
实现位置：`src/messageRouter.ts`

职责：
- 授权检查
- 消息分发到 session
- 串行处理 session queue
- 调用命令处理器 / LLM

### Session Manager
实现位置：`src/sessionManager.ts`

职责：
- 创建、加载、保存 session
- 维护 channel attachment
- 持久化 session metadata 与 history
- child session / parent session 关系
- alias / archive / isolated / current node 管理

### LLM Engine
实现位置：`src/llm.ts`

职责：
- 解析当前 session 的模型配置
- 组装系统 prompt 与历史消息
- 执行 tool-calling 循环
- 记录 token usage
- 适配 OpenAI / OpenAI-compatible / Anthropic 请求格式

### Tools / Nodes
实现位置：
- `src/tools.ts`
- `src/toolsSessionAgent.ts`
- `src/nodesManager.ts`
- `src/nodeWebSocket.ts`

职责：
- 文件、命令、浏览器、memory、session、agent 等工具调用
- 可选的 remote node 执行
- 每个 session 可切换当前 node

## Session Queue

当前 queue item 类型包括：

```ts
'user' | 'intersession' | 'background' | 'trigger' | 'onboot'
```

队列由 router 串行消费，避免并发处理同一 session 时的 busy/race 问题。

## 数据布局

```text
agents/
  <agent>/
    memory/

skills/
  <skill>/
    SKILL.md
    skill.json  # optional fallback metadata
    memory/

state/
  token
  node_token
  agents.json
  channels.json
  models.yaml
  sessions.json
  sessions/<id>.json
  logs/
  db/
```

## 配置入口

### `state/config.yaml`
- bot 名称、端口、功能开关
- LLM 默认 provider URL / API key
- channel 配置（telegram / matrix / wework / weixin）
- ASR service 配置
- 路径覆盖（agents dir / skills dir / models config / mcp config）

### `state/models.yaml`
- 默认模型 key
- `providers`（首选）或兼容旧根层 `models`
- 每个 provider entry 的 `providerType` / `models` / `baseUrl` / `apiKey`
- `models` 支持字符串列表，或带 `id` / `contextLimit` / `extraFields` / `extraHeaders` 的 object list

### `templates/`
- 初始 agent memory 模板
- `models.example.yaml`

## 分布式 Node 说明

Foxwarm 后端内部仍保留 optional distributed-node 能力，但相关 remote worker 子包不在首轮公开发布范围内，因此本轮公开文档不再把这部分作为用户入口。
