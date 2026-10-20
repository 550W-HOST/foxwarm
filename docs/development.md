# 开发指南

Foxwarm 开发指南，覆盖本地运行、目录结构、调试方式，以及扩展 agent / session / skill / channel 的常见入口。

## 开发环境

### 依赖

- Node.js 20.19+ (20.x) or 22.12+
- npm
- TypeScript 5.x
- （可选）Ollama，用于 embeddings
- （可选）Chromium，用于浏览器自动化

### 初始安装

```bash
npm ci
npm --prefix packages/webui ci
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

## Core delivery and retained backend lane

Default `npm run build` now builds the managed Main delivery graph: Shared, TS CLI Node, original WebUI, tracked Code extensions and Core resources. Install a net10.0-capable .NET SDK plus ASP.NET Core 10 runtime; no exact patch SDK is required. Fresh Monty acquisition uses Python 3. Linux source installation also needs make and GCC/G++ with libc/libutil development files (root node-pty still uses node-gyp). No optional image decoder or Desktop installer is required.

`node .`, `npm run start:notmux`, tmux start/restart and Windows start/status/restart/stop use managed Main with the same installation-relative data/config selection. Windows restart stops before rebuilding loaded native files. Main TUI is not implemented: `--tui` fails before startup, while persisted `bot.enableTUI` logs an ignored diagnostic. Worker/controller hosting remains excluded without deleting its records. This source candidate does not promote public Main or convert production/test Docker and default CI/test lanes. macOS Main is not qualified; other-platform TS Node clients remain supported.

Use `npm run build:reference` before retained TypeScript unit/app tests and differential fixtures; `npm run test:reference` runs the existing unit runner. Default builds no longer compile TypeScript Main. `npm run dev` watches that reference source, not managed Main. `build:node`, `node` and `cli-node` remain independent Shared/TS CLI builds without .NET.

`npm run publish:core -- -r linux-x64 -o /path/to/empty/output` creates a framework-dependent runtime directory. `build:assets` prepares independent inputs for direct `dotnet publish`; publishing rejects missing built resources. Plain backend build/test never invokes npm. The same graph feeds optional Windows Desktop without a second WebUI copy. See [host build and runtime prerequisites](../dotnet/README.md#build-publish-and-public-cli). The public `foxwarm` bin remains a one-shot CLI/help dispatcher, not a new Main start command.

## 代码结构

```text
foxwarm/
├── dotnet/Foxwarm/         # managed Main
├── src/                   # retained TypeScript reference
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
├── state/                  # 运行时状态与日志（含 token 文件）
│   ├── token
│   ├── node_token
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

- `state/config.yaml`：bot 配置、channel 配置、LLM 默认 URL/key、端口与开关
- `state/models.yaml`：模型列表与默认模型
- `agents/00_SYSTEM.md`：框架级系统提示（fresh init 从 `templates/agents/00_SYSTEM.md` 创建）
- `agents/<agent>/memory/`：agent 长期记忆
- `skills/<skill>/SKILL.md`：skill 入口文档；其它参考资料应由 `SKILL.md` 显式链接
- `templates/main/memory/`：main agent memory 首次初始化模板

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
    SKILL.md
    references/  # optional, linked explicitly from SKILL.md
      METHOD.md
```

skill 会自动出现在可见 skills catalog 中；需要完整说明时，使用 `/skill show <skill>` 或 `skill({ action: "load", skillName: "<skill>" })` 按需加载。
如果某个目录已经包含 `SKILL.md`，它就是一个 skill 边界；目录内部的 `references/`、`scripts/`、`assets/`、示例等都作为该 skill 的资源，不再继续扫描成独立 skill。`skill({ action: "load", ... })` 会返回入口文档，并在 header 中列出这些资源路径，agent 可按需读取。

## 调试

### 构建

```bash
npm run build
```

根目录构建依次执行 shared、sandbox runtime、CLI node 和 Main 的 TypeScript 编译；
sandbox runtime 和 CLI node 仍用 esbuild 生成各自的 bundle。此命令不构建 WebUI，
WebUI 使用独立的 `npm --prefix packages/webui run build`。

这四个 TypeScript 项目启用磁盘增量缓存，因此独立执行的 `npm run build` 也能复用
上次编译结果，不需要开启 watch。Main 的缓存位于 `lib/.tsbuildinfo`，其余三个
项目各自使用 `dist/.tsbuildinfo`；类型检查、declaration 和现有编译范围不变。
esbuild bundle 仍在每次构建时生成。

需要完整重建时，删除对应的整个 `lib/` 或 `dist/` 目录，让产物和缓存一起清理；
不要保留缓存而只删除部分产物。清理全部后重新构建：

```bash
rm -rf lib packages/shared/dist packages/cli-node/dist
npm run build
```

### 质量检查

```bash
npm run quality:unused
```

`quality:unused` 是只读 TypeScript 检查入口：root backend、`packages/shared`、`packages/cli-node` 会额外启用 `--noUnusedLocals --noUnusedParameters`；WebUI 使用自身 tsconfig 中已开启的 unused 检查。该命令不安装新依赖，也不生成构建产物。

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

当前默认测试服务名为 `foxwarm-dotnet-test`，监听宿主机的 `0.0.0.0:3003`。

### 测试环境登录

`test/docker-compose.yml` 不再通过 `.env` 注入登录 token。宿主机的 `test/state/` 挂载到容器的 `/data/state/`，因此登录 token 位于 `test/state/token`（容器内为 `/data/state/token`）。该文件缺失时，服务启动会生成一个 32 字节随机十六进制 token，并以仅所有者可读写的权限保存。

读取当前 token：

```bash
cat test/state/token
```

浏览器访问 `http://127.0.0.1:3003/`，在登录页粘贴该 token。修改 token 时替换该文件内容，然后重启服务使其生效。`FOXWARM_PUBLIC_BASE_URL` 仅在需要改变对外访问地址时设置，默认值为 `http://127.0.0.1:3003`；它不参与登录校验。
