# 开发指南

Foxwarm 开发指南，覆盖本地运行、目录结构、调试方式，以及扩展 agent / session / skill / channel 的常见入口。

## 开发环境

### 依赖

- Node.js 20+
- npm
- TypeScript 5.x
- （可选）Ollama，用于 embeddings
- （可选）Chromium，用于浏览器自动化

### 初始安装

```bash
npm install
npm run build
```

### 常用运行方式

```bash
# 前台运行
npm run start:notmux

# 后台 tmux 运行
npm start

# 开发监听
npm run dev

# 安装并构建 backend + WebUI
npm run build-all
```

## 代码结构

```text
foxwarm/
├── src/
│   ├── index.ts            # 启动入口
│   ├── commands.ts         # 用户命令定义
│   ├── commandHandler.ts   # 命令分发
│   ├── config.ts           # 配置常量与 models config 加载
│   ├── messageRouter.ts    # session queue 与消息路由
│   ├── sessionManager.ts   # session 持久化与生命周期
│   ├── sessionAgentOps.ts  # agent/session 重命名与迁移等操作
│   ├── llm.ts              # LLM 请求与 tool-calling 主循环
│   ├── tools.ts            # 通用工具实现
│   ├── toolsSessionAgent.ts# session / agent 工具
│   ├── nodesManager.ts     # 可选 remote node 管理
│   ├── vector.ts           # LanceDB 向量记忆
│   └── channels/           # 各 channel 实现
├── agents/                 # Agent 工作区与长期记忆
├── skills/                 # Skill 定义（可选）
├── state/                  # 运行时状态与日志
│   ├── logs/
│   ├── db/
│   ├── sessions/
│   └── models.yaml
├── templates/              # 初始 memory / models 模板
├── packages/webui/         # WebUI 前端
├── test/                   # 本地测试环境
└── docs/
```

## 本地配置入口

- `.env`：密钥、端口、provider 默认 URL、功能开关
- `state/models.yaml`：模型列表与默认模型
- `agents/<agent>/memory/`：agent 长期记忆
- `skills/<skill>/memory/`：附加给 agent 的 skill 文档
- `templates/main/memory/`：首次初始化模板

## 常见开发任务

### 新增命令

命令定义位于 `src/commands.ts`。

```ts
'/mycommand': {
  description: 'Do something',
  requiresSession: true,
  handler: async (ctx, args) => {
    ctx.reply('done')
  }
}
```

### 新增 Channel

在 `src/channels/` 中实现 `Channel` 接口，并在 `src/index.ts` 中接入启动流程。

### 新增 Tool

优先放到：
- `src/tools.ts`（通用工具）
- `src/toolsSessionAgent.ts`（session / agent / child-session 工具）

### 新增 Skill

```text
skills/
  my-skill/
    skill.json
    memory/
      README.md
      METHOD.md
```

然后通过 `/skill attach <agent> <skill>` 或对应 tool 附加到 agent。

## 调试

### 构建

```bash
npm run build
```

### 日志

```bash
tail -f state/logs/foxwarm.log
```

### Session / model 调试

常用命令：

```bash
/session list
/model
/node
/status
/messages -20
```

## 测试环境提示

仓库自带 `test/` 目录作为本地集成测试环境。

```bash
cd test
sudo docker compose up -d
```

如果你修改了 `test/docker-compose.yml` 的 service / project 配置，推荐使用：

```bash
sudo docker compose down
sudo docker compose up -d
```

当前默认测试服务名为 `foxwarm-test`。
