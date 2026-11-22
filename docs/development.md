# 开发指南

Foxwarm 开发指南，覆盖本地运行、目录结构、调试方式，以及扩展 agent / session / skill / channel 的常见入口。

## 开发环境

### 依赖

- Node.js 20.19+ (20.x) or 22.12+
- npm
- .NET 10 SDK and ASP.NET Core 10 runtime
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

# 安装并构建 backend + WebUI
npm run build-all
```

## Core delivery

Default `npm run build` now builds the managed Main delivery graph: Shared, TS CLI Node, original WebUI, tracked Code extensions and Core resources. Install a net10.0-capable .NET SDK plus ASP.NET Core 10 runtime; no exact patch SDK is required. Fresh Monty acquisition uses Python 3. Linux source installation also needs make and GCC/G++ with libc/libutil development files (root node-pty still uses node-gyp). No optional image decoder or Desktop installer is required.

`node .`, `npm run start:notmux`, tmux start/restart and Windows start/status/restart/stop use managed Main with the same installation-relative data/config selection. Windows restart stops before rebuilding loaded native files. Main TUI is not implemented: `--tui` fails before startup, while persisted `bot.enableTUI` logs an ignored diagnostic. This candidate does not promote public Main or replace live installations. The root Docker recipe and production/test Compose consumers use the same managed delivery; default CI tests the managed host. macOS Main is not qualified; other-platform TS Node clients remain supported.

The Bash source controls keep an interactive shell in the dedicated tmux pane. `scripts/stop.sh` and `scripts/restart.sh` validate Main's PID from the checkout-root `foxwarm.pid`, send SIGTERM, and wait for Main and its launcher; after 60 seconds they force termination with SIGKILL. Restart builds in staging before stopping and promotes only after stop completes. The first restart of an older PID-less launch discovers Main in the exact pane's foreground group. See the [source update procedure](../skills/foxwarm-maintenance/references/SOURCE-UPDATES.md).

`test:unit` runs the managed suite together with the maintained component groups. `build:node`, `node` and `cli-node` remain independent Shared/TS CLI Node builds without .NET. The TypeScript Main backend was removed; an existing TypeScript installation upgrades in place by following the [TypeScript migration guide](../website/src/content/docs/docs/typescript-migration.md).

`npm run publish:core -- -r linux-x64 -o /path/to/empty/output` creates a framework-dependent runtime directory. `build:assets` prepares independent inputs for direct `dotnet publish`; publishing rejects missing built resources. Plain backend build/test never invokes npm. The same graph feeds optional Windows Desktop without a second WebUI copy. The source-built image preserves Node 24 / Debian 13 and operator tools, adds the official ASP.NET Core 10 runtime, and uses distro Chromium; see [Docker delivery](../test/README.md). See [host build and runtime prerequisites](../dotnet/README.md#build-publish-and-public-cli). The public `foxwarm` bin remains a one-shot CLI/help dispatcher, not a new Main start command.

## 代码结构

```text
foxwarm/
├── dotnet/
│   ├── Foxwarm/            # managed Main（入口 MainHost.cs）
│   │   ├── Channels/       # 外部 channel 与 WebUI channel
│   │   ├── Sessions/       # Session 持久化、生命周期与 turn
│   │   ├── Models/         # 模型配置与 provider 协议
│   │   ├── Tools/          # 工具定义、执行与授权
│   │   ├── Nodes/          # remote Node 与 Provider
│   │   └── Vector/         # LanceDB 向量记忆
│   ├── Foxwarm.CliNode/    # managed CLI Node
│   └── Foxwarm.Tests/      # managed 测试
├── packages/shared/        # Main 与 Node 客户端共享的 TypeScript 代码
├── packages/cli-node/      # TypeScript CLI Node
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

命令解析与分发位于 `dotnet/Foxwarm/MessageRouter.Commands.cs`；公开管理命令见 [command administration](code-index/units/dotnet-command-administration.md)。

### 新增 Channel

在 `dotnet/Foxwarm/Channels/` 中实现 managed channel，并按 [shared external channels](code-index/units/dotnet-external-channels.md) 的约定接入注册与重载。

### 新增 Tool

工具定义与执行位于 `dotnet/Foxwarm/Tools/`；注册、发现与执行约定见 [unified tool registry](code-index/units/tools-registry.md)，授权声明见 [tool operation catalog](code-index/units/tool-operation-catalog.md)。

### 新增 Skill

```text
skills/
  my-skill/
    SKILL.md
    references/  # optional, linked explicitly from SKILL.md
      METHOD.md
```

skill 会自动出现在可见 skills catalog 中；需要完整说明时，使用 `/skill load <skill>` 或 `ctl skill load <skill>` 按需加载。
如果某个目录已经包含 `SKILL.md`，它就是一个 skill 边界；目录内部的 `references/`、`scripts/`、`assets/`、示例等都作为该 skill 的资源，不再继续扫描成独立 skill。`skill({ action: "load", ... })` 会返回入口文档，并在 header 中列出这些资源路径，agent 可按需读取。

## 调试

### 构建

```bash
npm run build
```

默认构建准备完整的 managed Main 交付：Shared、TS CLI Node、原始 WebUI、Code 扩展与 Core 资源。
只构建后端时使用 `dotnet build dotnet/Foxwarm.sln`，它不准备前端资源。

需要完整重建 TypeScript 包时，删除对应的整个 `dist/` 目录，让产物和增量缓存一起清理：

```bash
rm -rf packages/shared/dist packages/cli-node/dist packages/artifact-runtime/dist
npm run build
```

### 质量检查

```bash
npm run quality:unused
```

`quality:unused` 是只读 TypeScript 检查入口：`packages/shared`、`packages/artifact-runtime`、`packages/cli-node` 会额外启用 `--noUnusedLocals --noUnusedParameters`；WebUI 使用自身 tsconfig 中已开启的 unused 检查。该命令不安装新依赖，也不生成构建产物。

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
/session messages -20
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

当前默认测试项目和服务名为 `foxwarm-test`，监听宿主机的 `0.0.0.0:3002`。测试配置使用根目录的托管 Main Docker 构建方案，并为正常停止预留 30 秒。

`test/agents/` 挂载到 `/data/agents/`，其中包含 `main/`、其他 Agent 目录及全局 `00_SYSTEM.md`。

### 测试环境登录

`test/docker-compose.yml` 不再通过 `.env` 注入登录 token。宿主机的 `test/state/` 挂载到容器的 `/data/state/`，因此登录 token 位于 `test/state/token`（容器内为 `/data/state/token`）。该文件缺失时，服务启动会生成一个 32 字节随机十六进制 token，并以仅所有者可读写的权限保存。

读取当前 token：

```bash
cat test/state/token
```

浏览器访问 `http://127.0.0.1:3002/`，在登录页粘贴该 token。修改 token 时替换该文件内容，然后重启服务使其生效。在挂载的 `state/config.yaml` 中设置 `url: http://127.0.0.1:3002`（或实际对外地址）及 `bot.httpPort: 3001`；对外 URL 不参与登录校验。
