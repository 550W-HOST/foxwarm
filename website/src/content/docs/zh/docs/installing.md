---
title: 安装 Foxwarm
description: 在 Linux、WSL、Windows 或 Docker 上安装 Foxwarm，以及启动、停止和定位实例。
---

Foxwarm 服务器支持 **Linux x64**（包括 x64 WSL）和 **Windows x64**，也可以在 Linux x64 上用 Docker 运行。Foxwarm 服务器不支持 macOS，但 Mac 可以作为[节点](/zh/docs/nodes/)接入。

| 平台 | 命令 |
| --- | --- |
| Linux x64 或 x64 WSL | `curl -fsSL https://foxwarm.net/install-foxwarm.sh \| bash` |
| Windows x64（PowerShell） | `irm https://foxwarm.net/install-foxwarm.ps1 \| iex` |
| Docker Compose | 见 [Docker Compose](#docker-compose) |

在你想安装 Foxwarm 的目录下运行命令。安装脚本会创建 `./foxwarm` 存放程序，`./foxwarm-data` 存放配置、对话和 Agent 文件，然后构建并启动应用，输出 WebUI 登录链接。程序目录里的 `data_dir` 文件会记住数据位置，之后启动或重新运行安装脚本都会沿用。

安装脚本从源码构建，缺少下面任何一项时会给出明确提示并停止。它不会替你安装系统软件包。

已有的 TypeScript 版安装请参考[迁移指南](/zh/docs/typescript-migration/)（英文）。

## 环境要求

| | Linux x64 / WSL | Windows x64 |
| --- | --- | --- |
| Git | ✓ | ✓ |
| Node.js 20.19+（20.x）或 22.12+，含 npm | ✓ | ✓ |
| 支持 `net10.0` 的 .NET SDK，含 ASP.NET Core 10 运行时 | ✓ | ✓ |
| Python 3 | ✓ | ✓ |
| tmux、make、GCC/G++、libc/libutil 开发文件 | ✓ | — |

需要联网下载锁定版本的 npm 和 NuGet 依赖，以及原生 worker。

检查 .NET：运行 `dotnet --version` 和 `dotnet --list-runtimes`，运行时列表里需要有 `Microsoft.AspNetCore.App 10.x`。SDK 补丁版本不限。SDK 和编译器只在构建时需要；Foxwarm 本身运行在 ASP.NET Core 运行时上。

## Linux x64 或 x64 WSL

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
```

自定义目录：

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash -s -- \
  --dir "$PWD/foxwarm" \
  --data-dir "$PWD/foxwarm-data"
```

运行前可以先阅读 [Bash 安装脚本](https://github.com/550W-HOST/foxwarm/blob/main/install-foxwarm.sh)。下载脚本后用 `--help` 查看其他选项。

## Windows PowerShell

Windows 不需要 tmux 或 WSL。

```powershell
irm https://foxwarm.net/install-foxwarm.ps1 | iex
```

安装脚本会在后台启动 Foxwarm，就绪后自动打开 WebUI。

如果想先阅读脚本或自定义安装路径，先下载：

```powershell
Invoke-WebRequest https://foxwarm.net/install-foxwarm.ps1 -OutFile install-foxwarm.ps1
.\install-foxwarm.ps1 -InstallDir .\foxwarm -DataDir .\foxwarm-data
```

如果脚本执行被策略阻止，可以只对这次运行放开：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1
```

重新运行安装脚本前，先在程序目录里用 `npm run stop:windows` 停止现有实例，避免替换正在加载的原生依赖。

## 打开 WebUI

使用启动时输出的登录链接，通常是：

```text
http://localhost:3001/#token=...
```

如果找不到了，读取数据目录里的 `state/token`。默认安装下，在 `foxwarm` 的上级目录执行：

```bash
cat foxwarm-data/state/token
```

Windows 上用 `Get-Content .\foxwarm-data\state\token`。令牌和登录链接都要像密码一样保管。

新安装的实例会打开 **Setup → Models**。按照[配置第一个模型](/zh/docs/model-setup/)接入服务商。

## 启动、停止和查看

在程序目录里运行：

| 操作 | Linux x64、WSL | Windows |
| --- | --- | --- |
| 后台启动 | `npm start` | `npm run start:windows` |
| 重启 | `npm run restart` | `npm run restart:windows` |
| 停止 | `npm run stop` | `npm run stop:windows` |
| 查看运行中的进程 | `tmux attach -t foxwarm` | `npm run status:windows` |

要离开 tmux 而不停止 Foxwarm，按 <kbd>Ctrl</kbd>+<kbd>b</kbd>，再按 <kbd>d</kbd>。如果你自定义了 tmux 会话名，attach 时用你的名字。

日志在数据目录的 `state/logs/` 下。启动失败时，先查看这些日志和进程输出再重试。修改数据路径、升级和保护实例，见[数据、升级与备份](/zh/docs/data-upgrades-backups/)（英文）。

## Docker Compose

Linux x64 镜像包含 ASP.NET Core 运行时、Node.js 和 Chromium。主机上需要 Docker 和 Compose；构建镜像时会自动获取源码构建工具链和依赖。

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
mkdir -p foxwarm-data/state foxwarm-data/agents
docker compose up -d --build foxwarm
```

用 `foxwarm-data/state/token` 里的令牌打开 `http://localhost:3001/`。这里 Compose 把程序目录下的 `foxwarm-data` 挂载到容器内的 `/data`。首次的模型配置和本地安装一样。

这条命令只启动 `foxwarm` 服务。可选的配套沙箱客户端不是使用 WebUI 的必要条件。

查看容器日志和停止：

```bash
docker compose logs -f foxwarm
docker compose down
```

如果修改了 `bot.httpPort`，也要同步修改 Compose 的端口映射和健康检查。如果模型或 embedding 服务运行在 Docker 主机上，请使用主机可达的地址；在 Foxwarm 容器里，`localhost` 指的是容器本身。

## 可选组件

- **语义历史检索**：默认关闭，需要兼容的原生 Vector 库和 embedding 服务，见[检索要求](/zh/docs/history-search/#enable-semantic-search)（英文）。
- **代码工作台**：体积较大的编辑器资源不包含在普通源码构建或 Docker 构建里，见[工作台配置](https://github.com/550W-HOST/foxwarm/blob/main/packages/vscode-web/README.md)。
- **HEIC/HEIF 图片**：需要额外的原生解码器，见[图片依赖](https://github.com/550W-HOST/foxwarm/blob/main/docs/native-image-prerequisites.md)。PNG/JPEG 使用内置支持。

## 手动检出

开发或手动在 Linux x64/WSL 上安装时，环境要求与安装脚本相同：

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
mkdir -p ../foxwarm-data
printf "%s\n" "$PWD/../foxwarm-data" > data_dir
npm start
```

`data_dir` 指针让构建和之后的启动都指向同一个数据目录。修改源码和运行测试，见仓库里的[开发指南](https://github.com/550W-HOST/foxwarm/blob/main/docs/development.md)。
