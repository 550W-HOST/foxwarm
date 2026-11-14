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
/session fork [suffix] [message] [--attach]
/session rename <name>
/session move [<session-id>] --new-session-id <new-session-id> [--new-agent-name <agent>] [--parent-session-id <parent-session-id>]
/session clear
/session delete <sessionId>
/session archive [session-id]
/session unarchive [session-id]
/session set-parent <parent-session-id> [--session-id <child-session-id>]
/session clear-parent [--session-id <child-session-id>]
/session index
```

### 其他常用命令

```bash
/status
/session messages <count>
/model [name|default]
/node list
/node select <node-id>
/node pair-approve <pending-id> [--node-id <node-id>]
/node pair-reject <pending-id>
/node bootstrap-info
/agent list
/agent create <name> [--no-create-main-session]
/agent delete <name> [--confirm]
/agent inherit <agent> [parent-agent]
/skill list
```

`/session move` 说明：

- `/session move --new-session-id my-project`：在当前 agent 内重命名当前 session
- `/session move --new-agent-name my-agent --new-session-id main`：把当前 session 移动到**已存在的** agent `my-agent` 下，并改名为 `main`
- 默认保留当前 `parentSessionId`，并自动把直接 child 的 parent 引用改成移动后的新 ID；迁移一棵 session tree 时无需逐项重建已有关系
- `/session move --new-agent-name my-agent --new-session-id task --parent-session-id my-agent/main`：移动后明确把该 session 设为 `my-agent/main` 的 child
- 移除 parent 关系继续使用 `/session clear-parent`，不通过 `/session move` 隐式完成
- 目标 agent 不存在时，加 `--create-agent` 创建，或先用 `/agent create`
- 该命令也**不会重命名 agent 本身**；agent 级别变更更适合走新建/迁移/清理流程

创建或移动 Session 时，新名称只允许 ASCII 字母、数字、`_`、`-`；fork/child 的 suffix 也遵循该规则。已有包含其他字符的 Session 不会批量改名，仍可读取并移动到合法名称。`displayName` 不受此限制。

## 持久化结构

Foxwarm 主要使用以下路径保存 session 与 agent 状态：

- `state/catalog.sqlite` - Main-owned session identity/topology/list catalog
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
- `model`：session 层覆盖的模型 key
- `parentSessionId`：child session 的父会话

## Prompt Snapshot

Foxwarm 会把当前 session 可见的长期记忆预组装成 `persistentMemorySnapshot`。
其来源通常是：

1. 框架级系统提示：内置的 `templates/agents/00_SYSTEM.md`，加上可选的安装级追加文件 `agents/00_SYSTEM.local.md`
2. inherited agent memory
3. 当前 agent 自身 memory
4. visible skills catalog（技能目录摘要，不是完整技能文档）

补充说明：

- 安装级的通用指令写在 `agents/00_SYSTEM.local.md`。旧版遗留且被修改过的 `agents/00_SYSTEM.md` 会替换内置框架提示，导致不再获得框架更新；未修改的旧副本会在启动时自动删除
- 默认的 per-agent memory 加载会跳过各 agent 自己目录下的 `00_SYSTEM.md`
- 因此普通 agent 自己的长期记忆应放在 `MEMORY.md` / `SOUL.md` / `USER.md` 或其他普通 `.md` 文件里，而不是依赖自定义 `00_SYSTEM.md`
- 普通 memory `.md` 可以在文件开头使用 YAML frontmatter：`include-session` / `exclude-session`（string 或 string[]）。glob 按 canonical session id 整串匹配，`exclude-session` 优先；省略 `include-session` 表示默认注入。frontmatter 解析失败会 warn，但仍注入正文；缺少 closing delimiter 时按普通 markdown 注入。

如果 session 设置了 `systemPromptFiles`，则只替换 memory 文件来源为该数组列出的文件；相对路径按 agent 工作目录解析，仍会应用 session-specific frontmatter。skills catalog、目录信息、压缩历史提示等非-memory 注入仍保留。

动态注入的 `EARLIER CONTEXT RECALL` 会简要说明 layered context / CTX-BLOCK：长会话的早期内容会被归档并 compact 成分层摘要，可用 `recall` 逐层展开；这套机制是可追溯的会话历史，不等同于 agent memory。普通过程信息、临时进展、已完成细节不需要为了“保留上下文”写进 memory；memory 应只保存长期稳定规则、偏好、环境事实和已确认设计决策。

当 agent memory / inherit / skills 变化时，新 session 和之后正常刷新 snapshot 的 session 会使用新内容。`set_agent_inherit` 默认不会批量刷新既有 session；显式批量刷新会跳过已超过一小时没有消息的 session，由它们在下一次普通 turn 开始时自动刷新。

如果你是**从别的会话/agent 侧**修改某个 agent 的 memory，并且希望一个已存在的 session 立刻吃到新内容，手动执行一次：

```bash
/session refresh-snapshot [session-id]
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
- `trigger`：外部事件触发，包括已验证的 webhook 投递（`/webhooks/<id>`）和已弃用的管理员 `/trigger`
- `onboot`：为队列/历史兼容保留的旧版持久化启动事件类型

## 模型选择

- 如果 `session.model` 为空，则使用 `state/models.yaml` 中的默认模型
- `/model` 可以查看可用模型或切换当前 session 模型

## Node 与权限

- `/node` 查看或切换当前执行 node
- Agent 的 `defaultNode` / `defaultCwd` 决定新 session 的初始 node 与工作目录；这只是放置位置，不授予任何权限
- 工具权限由全局 `state/tool-authorization.yaml` 与 agent 本地规则层（`create_agent` 的 `rules`、`set_agent_rules`）共同决定；本地规则作用于该 agent 以及由它创建的 agent，只能进一步收紧
- 真正的隔离来自 node 所在的环境（容器、虚拟机或独立机器）；`node-setup` 技能提供一次性容器 Provider 的参考实现
- 旧的 agent 级隔离已移除：启动时，仍标记为 isolated 的 agent 会自动迁移为生成的本地规则层，并以原绑定 node 作为 `defaultNode`。详见 `agent-management` 技能
