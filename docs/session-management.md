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
/session move <new-session-id>
/session move <existing-agent>/<new-session-id>
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
/node [list|<node-id>]
/node approve <pending-id> [node-id]
/node reject <pending-id>
/node pair-help
/agent list
/agent create <name> [--no-main]
/agent delete <name> [--confirm]
/agent inherit <agent> <parent-agent|none>
/skill list
```

`/session move` 说明：

- `/session move my-project`：在当前 agent 内重命名当前 session
- `/session move my-agent/main`：把当前 session 移动到**已存在的** agent `my-agent` 下，并改名为 `main`
- 该命令**不会创建 agent**；如果目标 agent 不存在，请先用 `/agent create`
- 该命令也**不会重命名 agent 本身**；agent 级别变更更适合走新建/迁移/清理流程

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
  systemPromptFiles?: string[];
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
- `systemPromptFiles`：可选文件列表；设置后，仅替换 snapshot 中的 memory 文件来源，其他系统注入（如 skills catalog）仍保留。相对路径按 agent 工作目录解析；文件可用 session-specific frontmatter 继续筛选。
- `currentNode`：当前工具执行 node，默认 `master`
- `isolated`：是否限制为当前 node / 相关会话树使用
- `model`：session 层覆盖的模型 key
- `parentSessionId`：child session 的父会话

## Prompt Snapshot

Foxwarm 会把当前 session 可见的长期记忆预组装成 `persistentMemorySnapshot`。
其来源通常是：

1. `agents/00_SYSTEM.md` 这一层框架级系统提示（如果不存在，则兼容 fallback 到 legacy `agents/main/memory/00_SYSTEM.md`）
2. inherited agent memory
3. 当前 agent 自身 memory
4. visible skills catalog（技能目录摘要，不是完整技能文档）

补充说明：

- `agents/00_SYSTEM.md` 是特殊文件，会作为框架层系统提示注入所有 agent；`agents/main/memory/00_SYSTEM.md` 仅作为过渡兼容 fallback
- 默认的 per-agent memory 加载会跳过各 agent 自己目录下的 `00_SYSTEM.md`
- 因此普通 agent 自己的长期记忆应放在 `MEMORY.md` / `SOUL.md` / `USER.md` 或其他普通 `.md` 文件里，而不是依赖自定义 `00_SYSTEM.md`
- 普通 memory `.md` 可以在文件开头使用 YAML frontmatter：`include-session` / `exclude-session`（string 或 string[]）。glob 按 canonical session id 整串匹配，`exclude-session` 优先；省略 `include-session` 表示默认注入。frontmatter 解析失败会 warn，但仍注入正文；缺少 closing delimiter 时按普通 markdown 注入。

如果 session 设置了 `systemPromptFiles`，则只替换 memory 文件来源为该数组列出的文件；相对路径按 agent 工作目录解析，仍会应用 session-specific frontmatter。skills catalog、目录信息、压缩历史提示等非-memory 注入仍保留。

当 agent memory / inherit / skills 变化时，相关 session snapshot 会刷新。

如果你是**从别的会话/agent 侧**修改某个 agent 的 memory，并且希望一个已存在的 session 立刻吃到新内容，手动执行一次：

```bash
/session update-snapshot [session-id]
```

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

补充说明（agent 级隔离的实际边界）：

- isolated agent 通常用于把高风险任务或可能接触不可信内容（例如外部群聊/channel）的 agent 绑定到非 master node 上
- isolated agent 的运行时工具执行主要发生在其绑定 node 上
- isolated agent 不能把“切去别的 node”当成默认能力
- 在 `master` 上，它仍可做有限的本地操作，但范围应理解为自己的 memory 和自己 agent 目录内的文件
