---
title: 安装 Foxwarm
description: 在 Linux、WSL、macOS、Windows 或 Docker 上安装 Foxwarm，以及启动、停止、更新和定位实例。
---

Foxwarm 服务器支持 **Linux x64**（包括 x64 WSL）、**macOS arm64**（Apple Silicon）和 **Windows x64**，也可以在 Linux x64 上用 Docker 运行。Windows 上还可以使用[桌面版](#windows-桌面版)。

| 平台 | 命令 |
| --- | --- |
| Linux x64 或 x64 WSL | `curl -fsSL https://foxwarm.net/install-foxwarm.sh \| bash` |
| macOS（Apple Silicon） | `curl -fsSL https://foxwarm.net/install-foxwarm.sh \| bash` |
| Windows x64（PowerShell） | `irm https://foxwarm.net/install-foxwarm.ps1 \| iex` |
| Docker | 见 [Docker](#docker) |

在你想安装 Foxwarm 的目录下运行命令。安装脚本会下载最新的预编译版本，创建 `./foxwarm` 存放程序、`./foxwarm-data` 存放配置、对话和 Agent 文件，然后启动 Foxwarm 并输出 WebUI 登录链接。程序目录里的 `data_dir` 文件会记住数据位置。

安装过程不编译任何东西。已有的 TypeScript 版安装请参考[迁移指南](/zh/docs/typescript-migration/)（英文）。

## 安装包

每个 [Release](https://github.com/550W-HOST/foxwarm/releases/latest) 提供：

| 安装包 | 用途 |
| --- | --- |
| `foxwarm-linux-x64.tar.gz` | Linux 服务器，使用系统已安装的 ASP.NET Core 10 运行时 |
| `foxwarm-linux-x64-self-contained.tar.gz` | Linux 服务器，自带 .NET 运行时 |
| `foxwarm-osx-arm64.tar.gz` | Apple Silicon Mac 服务器，使用系统已安装的 ASP.NET Core 10 运行时 |
| `foxwarm-osx-arm64-self-contained.tar.gz` | Apple Silicon Mac 服务器，自带 .NET 运行时 |
| `foxwarm-win-x64.zip` | Windows 服务器，使用系统已安装的 ASP.NET Core 10 运行时 |
| `foxwarm-win-x64-self-contained.zip` | Windows 服务器，自带 .NET 运行时 |
| `foxwarm-desktop-win-x64.zip` | Windows 桌面版，自带 .NET 运行时 |
| `SHA256SUMS` | 以上文件的校验和 |

如果 `dotnet --list-runtimes` 里有 `Microsoft.AspNetCore.App 10.x`，安装脚本会选较小的安装包，否则选自带运行时的版本。也可以用 `--self-contained` / `--framework-dependent`（Linux/macOS）或 `-SelfContained` / `-FrameworkDependent`（Windows）自己指定。

## 环境要求

| | Linux x64 / WSL | macOS arm64 | Windows x64 |
| --- | --- | --- | --- |
| tmux（可选，后台启动时优先使用） | ✓ | ✓ | — |
| curl 或 wget、tar | ✓ | 系统自带 | — |
| sha256sum 或 shasum | ✓ | 系统自带 shasum | — |
| ICU 和 OpenSSL 库（多数 Linux 系统已自带） | ✓ | 使用 macOS 系统库 | — |
| ASP.NET Core 10 运行时 | 仅较小的安装包需要 | 仅较小的安装包需要 | 仅较小的安装包需要 |

Linux 安装包需要 glibc 2.34 或更新版本（例如 Ubuntu 22.04、Debian 12、RHEL 9）；语义历史检索需要 glibc 2.39。

部分功能会用到的可选工具：

- `PATH` 上的 **Node.js**：用于准备 Agent 在 WebUI 中展示的图表、图片和 React artifact，也用于运行 `browser_*` 工具，其他功能不需要它。
- **Chromium 或 Chrome**：`browser_*` 工具需要它；只有 Node.js 与浏览器都已安装时，该机器才提供这些工具。可通过 `PUPPETEER_EXECUTABLE_PATH` 指定浏览器。Foxwarm 保持浏览器自身的沙箱开启；在 Chromium 无法创建沙箱的环境（以 root 运行、受限容器）中，请让 `PUPPETEER_EXECUTABLE_PATH` 指向适合该环境的启动脚本。
- **Git**：Code 工作台的源代码管理视图。

## Linux x64 或 x64 WSL

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
```

指定目录或版本：

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash -s -- \
  --dir "$PWD/foxwarm" \
  --data-dir "$PWD/foxwarm-data" \
  --version 0.9.0
```

`--package FILE` 安装已下载的安装包，`--no-start` 只安装不启动。运行前可以先阅读[安装脚本](https://github.com/550W-HOST/foxwarm/blob/main/install-foxwarm.sh)。

## macOS（Apple Silicon）

需要 **macOS 15 或更新版本**，与 [.NET 10 支持范围](https://github.com/dotnet/core/blob/main/release-notes/10.0/supported-os.md)一致。不支持 Intel Mac，也不提供 macOS 桌面版。

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
```

目录、版本和安装包参数与 Linux 相同。安装脚本会自动选择依赖已安装运行时或自带运行时的 arm64 安装包，不需要通过 Homebrew 安装 ICU 或 OpenSSL。需要可连接的控制台时可安装 tmux；没有 tmux 时，Foxwarm 会在后台启动并写入文件日志。

安装包已在 Apple Silicon 的 macOS 15 上测试。语义历史检索和浏览器工具已包含在内，但尚未在 macOS 上验证。

安装包未做发行签名或公证。curl 安装脚本不会添加隔离标记；浏览器下载的归档可能带有 Gatekeeper 隔离标记。先用 Release 的 `SHA256SUMS` 校验归档，确认信任后，仅移除该归档的隔离标记再安装：

```bash
xattr -d com.apple.quarantine foxwarm-osx-arm64-self-contained.tar.gz
curl -fsSLO https://foxwarm.net/install-foxwarm.sh
bash install-foxwarm.sh --package foxwarm-osx-arm64-self-contained.tar.gz
```

如果已经解压且 Gatekeeper 阻止运行，可以对该解压目录执行 `xattr -dr com.apple.quarantine /path/to/extracted-package`。不要关闭系统全局的 Gatekeeper。

## Windows PowerShell

```powershell
irm https://foxwarm.net/install-foxwarm.ps1 | iex
```

安装脚本会在后台启动 Foxwarm，就绪后打开 WebUI。如果想先阅读脚本或指定选项，先下载：

```powershell
Invoke-WebRequest https://foxwarm.net/install-foxwarm.ps1 -OutFile install-foxwarm.ps1
.\install-foxwarm.ps1 -InstallDir .\foxwarm -DataDir .\foxwarm-data
```

脚本还支持 `-Version`、`-Package FILE` 和 `-NoStart`。如果系统禁止运行脚本，用 `powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1` 运行下载的文件。

## Windows 桌面版

从[最新 Release](https://github.com/550W-HOST/foxwarm/releases/latest)下载 [`foxwarm-desktop-win-x64.zip`](https://github.com/550W-HOST/foxwarm/releases/latest/download/foxwarm-desktop-win-x64.zip)，解压后打开 **Foxwarm.Desktop.exe**。它在窗口中运行 Foxwarm，带托盘图标，数据保存在 `%LOCALAPPDATA%\Foxwarm\Desktop`。需要 Microsoft Edge WebView2 Runtime，Windows 10 和 11 通常已自带。桌面版只在本机监听；需要其他设备访问时请安装服务器版。

## 打开 WebUI

使用安装脚本输出的登录链接，通常是：

```text
http://localhost:3001/#token=...
```

如果找不到链接，读取数据目录下的 `state/token`，例如 `cat foxwarm-data/state/token` 或 `Get-Content .\foxwarm-data\state\token`。请像对待密码一样保管 token 和链接。

新安装的 Foxwarm 会打开 **Setup → Models**。按照[配置第一个模型](/zh/docs/model-setup/)连接模型服务商。

## 启动、停止、更新和查看

安装脚本会把 `foxwarmctl` 放在程序目录：

| 操作 | Linux、WSL、macOS | Windows |
| --- | --- | --- |
| 后台启动 | `./foxwarm/foxwarmctl start` | `.\foxwarm\foxwarmctl.cmd start` |
| 停止 | `./foxwarm/foxwarmctl stop` | `.\foxwarm\foxwarmctl.cmd stop` |
| 重启 | `./foxwarm/foxwarmctl restart` | `.\foxwarm\foxwarmctl.cmd restart` |
| 查看状态 | `./foxwarm/foxwarmctl status` | `.\foxwarm\foxwarmctl.cmd status` |
| 更新到最新版本 | `./foxwarm/foxwarmctl update` | `.\foxwarm\foxwarmctl.cmd update` |
| 查看控制台 | `./foxwarm/foxwarmctl attach` | 日志在 `state\logs` |
| 前台运行 | `./foxwarm/foxwarmctl run` | `.\foxwarm\foxwarmctl.cmd run` |

在 Linux 和 macOS 上，安装了 tmux 时会在 tmux 会话 `foxwarm` 中启动（可用 `FOXWARM_TMUX_SESSION` 改名）；按 <kbd>Ctrl</kbd>+<kbd>b</kbd> 再按 <kbd>d</kbd> 可以退出而不停止。没有 tmux 时会自动在后台启动，关闭终端或 SSH 连接后继续运行。此时 `attach` 会显示数据目录下 `state/logs/foxwarm.stdout.log` 和 `foxwarm.stderr.log` 的路径。`status` 会报告 PID 和启动方式。两种方式都会在程序目录写入 `foxwarm.pid`，过期的 PID 文件会被忽略。停止时最多等待 60 秒让正在进行的工作结束，之后结束进程。

`update` 会在旧版本继续运行时下载并检查新版本，然后停止 Foxwarm、切换到新版本、如果之前在运行就重新启动，并删除旧版本。`update 0.9.1` 安装指定版本。对已有安装重新运行安装脚本效果相同。升级重要数据前请阅读[数据、更新与备份](/zh/docs/data-upgrades-backups/)。

日志在数据目录的 `state/logs/` 下。

## Docker

镜像内含 ASP.NET Core 运行时、Node.js 和 Chromium：

```bash
mkdir -p foxwarm-data
curl -fsSLO https://raw.githubusercontent.com/550W-HOST/foxwarm/main/docker/seccomp-chromium.json
docker run -d --name foxwarm --init -p 3001:3001 \
  --security-opt seccomp=seccomp-chromium.json --shm-size 1g \
  -v "$PWD/foxwarm-data:/data" ghcr.io/550w-host/foxwarm:latest
```

容器以非 root 的 `node` 用户（uid 1000）运行 Foxwarm，并提供免密 `sudo`，因此 Agent 仍可安装软件包。首次启动时，会把早期以 root 运行的镜像写入的数据目录改为该用户所有。seccomp 配置文件是 Docker 默认配置加上 Chromium 沙箱所需的命名空间调用，因此浏览器工具可在保持沙箱开启、无需额外权限的情况下工作。缺少该配置时，第一次调用浏览器工具会报沙箱错误。

使用 `foxwarm-data/state/token` 中的 token 打开 `http://localhost:3001/`。镜像标签跟随版本，例如 `0.9.0`、`0.9` 和 `latest`；更新时拉取新镜像并重新创建容器。首次配置模型的方式与本地安装相同。

仓库里的 `docker-compose.yml` 运行同一个镜像并带有健康检查，另有一个可选的配套沙箱节点（从仓库构建）：

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
mkdir -p foxwarm-data/state foxwarm-data/agents
docker compose up -d foxwarm
```

如果修改了 `bot.httpPort`，也要同步修改端口映射和健康检查。要访问 Docker 宿主机上的模型或 embedding 服务，请使用宿主机可达的地址；容器内的 `localhost` 指的是 Foxwarm 容器本身。

## 可选组件

- **语义历史检索**：默认关闭，需要 embedding 服务，见[检索要求](/zh/docs/history-search/#enable-semantic-search)（英文）。
- **Code 工作台**：体积较大的编辑器资源不包含在安装包和镜像中，见[工作台配置说明](https://github.com/550W-HOST/foxwarm/blob/main/packages/vscode-web/README.md)。
- **HEIC/HEIF 图片**：需要额外的原生解码库，见[图片依赖说明](https://github.com/550W-HOST/foxwarm/blob/main/docs/native-image-prerequisites.md)。PNG/JPEG 使用内置的图片支持。

## 从源码运行

开发时可以直接运行源码 checkout。需要 Git、Node.js 20.19+（20.x）或 22.12+ 及 npm、支持 `net10.0` 的 .NET SDK、Python 3，Linux 上还需要 tmux、make、GCC/G++ 以及 libc/libutil 开发文件：

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
mkdir -p ../foxwarm-data
printf "%s\n" "$PWD/../foxwarm-data" > data_dir
npm start
```

`npm start` 会构建并在 tmux 中启动；`npm run restart` 重新构建并重启，`npm run stop` 停止。Windows 上使用 `npm run start:windows`、`restart:windows`、`stop:windows` 和 `status:windows`。修改源码和运行测试请看仓库的[开发指南](https://github.com/550W-HOST/foxwarm/blob/main/docs/development.md)。
