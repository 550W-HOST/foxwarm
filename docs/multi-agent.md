# 多 Agent / 多会话协作

Foxwarm 把 **agent**、**session**、**child session** 明确区分开来，这也是并行协作能力的基础。

## 核心概念

### Agent
- 长期存在的工作区与 memory 容器
- 例如：`agents/main`、`agents/researcher`
- 可以通过 `agent.inherit` 共享 memory

### Session
- 绑定到某个 agent 的运行时会话线程
- 例如：`main`、`researcher/main`、`main_analysis`
- 同一个 agent 可以有多个 session

### Child Session
- 一种有父会话关系的 session
- 用于并行分析、测试、审阅、任务拆分
- 完成任务后会自动通知父会话

> 注意：`agent.inherit` 是 memory 继承链，不是 child session 的汇报关系。

## 典型协作方式

### 1. 并行分析

主会话拆分多个子任务：

```ts
create_child_session({
  suffix: 'analysis',
  fork: true,
  message: 'Review the latest diff and summarize risks.'
})

create_child_session({
  suffix: 'test',
  fork: true,
  message: 'Run smoke tests in the test environment.'
})
```

### 2. 父会话向子会话派单

```ts
send_to_session({
  sessionId: 'main_analysis',
  message: 'Check README and docs for outdated branding.'
})
```

### 3. 复用已有子会话

如果一个 child session 已经专门负责某类工作，可以继续复用，而不是无限制创建新 child。

## 常用工具

### `create_child_session`

常见参数：

```ts
{
  suffix: string,
  fork?: boolean,
  message?: string,
  node?: string,
  isolated?: boolean,
}
```

说明：
- `fork: true` 会继承当前上下文
- `message` 可用于直接下发第一条任务
- `node` / `isolated` 可让 child session 绑定到特定 node

### `send_to_session`

```ts
{
  sessionId: string,
  message: string,
}
```

用于跨 session 协作、测试交接、结果回报等。

## 常用命令

```bash
/session list
/session create <agent> <session>
/session fork
/session parent <parent-session-id> [child-session-id]
/session unparent [child-session-id]
/session isolated [on|off] [node]
/agent list
/agent create <name> [--no-main]
/agent inherit <agent> <parent-agent|none>
/skill attach <agent> <skill>
```

## 推荐模式

### Agent 负责长期身份
把长期知识、角色设定、项目背景放在 agent memory 中。

### Session 负责具体线程
一个项目可以有多个 session：开发、测试、审阅、实验等。

### Child Session 负责并行执行
把明确、可独立验证的任务交给 child session。

## 注意事项

1. child session 是 session，不是独立 agent
2. `agent.inherit` 只影响 memory 组合，不影响消息汇报关系
3. isolated session 会限制跨 session / 跨 node 操作
4. child session 会自动通知父会话，但父会话仍应做最终协调
5. attached skills 会进入 prompt，但不会沿 `agent.inherit` 自动传播
