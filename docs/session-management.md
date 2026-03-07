# Session 管理

Foxwarm 当前把 **agent** 与 **session** 明确分开：

- `agent` = 长期存在的工作区 + memory 容器
- `session` = 绑定到某个 agent 的运行时会话线程

## 常用命令

### Session 相关

```bash
/session list
/session new
/session create <agent> <session>
/session fork
/session rename <name>
/session move [agent/]<new-session-id>
/session clear
/session delete <sessionId>
/session archive [session-id]
/session unarchive [session-id]
/session parent <parent-session-id> [child-session-id]
/session unparent [child-session-id]
/session isolated [on|off] [node]
/session index
```

### 其他常用命令

```bash
/status
/messages <num>
/model [name|default]
/node [node-id]
/agent list
/agent create <name> [--no-main]
/agent inherit <agent> <parent-agent|none>
/skill list
```

## 持久化结构

Foxwarm 主要使用以下路径保存 session 与 agent 状态：

- `state/sessions.json` - session 元数据索引
- `state/sessions/<id>.json` - session 历史、snapshot 与附加状态
- `state/agents.json` - agent metadata
- `state/channels.json` - channel attachment
- `agents/<agent>/memory/` - agent 长期记忆
- `state/models.yaml` - 模型列表与默认模型（用户本地配置）

## Session 关键字段

```ts
interface Session {
  id: string;
  agent?: string;
  aliases?: string[];
  history: Message[];
  persistentMemorySnapshot: string;
  stats: SessionStats;
  busy: boolean;
  queue: QueueItem[];
  meta: SessionMeta;
  displayName?: string;
  archived?: boolean;
  currentNode?: string;
  isolated?: boolean;
  model?: string;
  vectorIndexPosition?: number;
  historyVersion?: number;
  parentSessionId?: string;
}
```

### 字段说明

- `agent`：当前 session 绑定的 agent
- `aliases`：旧 ID / 别名，便于 move/rename 后兼容解析
- `persistentMemorySnapshot`：当前 prompt snapshot
- `currentNode`：当前工具执行 node，默认 `master`
- `isolated`：是否限制为当前 node / 相关会话树使用
- `model`：session 层覆盖的模型 key
- `parentSessionId`：child session 的父会话

## Prompt Snapshot

Foxwarm 会把当前 session 可见的长期记忆预组装成 `persistentMemorySnapshot`。
其来源通常是：

1. inherited agent memory
2. 当前 agent 自身 memory
3. attached skills memory

当 agent memory / inherit / skills 变化时，相关 session snapshot 会刷新。

## Queue

当前 queue item 可能包含：

```ts
interface QueueItem {
  type: 'user' | 'intersession' | 'background' | 'trigger' | 'onboot';
  source?: QueueSource;
  parts?: MessagePart[];
}
```

说明：
- `user`：来自用户或 channel 的普通消息
- `intersession`：来自其他 session 的消息
- `background`：后台恢复或异步任务
- `trigger`：外部 `/trigger` 触发
- `onboot`：启动时由 `ONBOOT.md` 触发

## 模型选择

- 如果 `session.model` 为空，则使用 `state/models.yaml` 中的默认模型
- `/model` 可以查看可用模型或切换当前 session 模型

## Node 与隔离

- `/node` 查看或切换当前执行 node
- `/session isolated on [node]` 可把当前 session 固定在某个 node 范围内
- isolated 主要用于限制跨 session / 跨 node 操作
