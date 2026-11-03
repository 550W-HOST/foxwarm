---
title: 配置第一个模型
description: 在 Foxwarm 首次设置中配置 OpenAI 兼容或 Anthropic 模型服务商。
---

当前数据目录里没有 `state/models.yaml` 时，Foxwarm 会打开首次设置，直到你保存一份有效的模型配置为止。

用安装脚本输出的登录链接打开 WebUI。如果找不到链接，见[打开 WebUI](/zh/docs/installing/)。

## 添加服务商

打开 **Setup → Models**，为一个支持的服务商填写 YAML。**Save models** 会校验 YAML 并解析其中的模型条目，但不会真正请求服务商。配置需要包含：

- 服务商类型
- 服务商的 API 基础地址
- 一个或多个准确的模型 ID
- API Key（如果端点需要）
- `provider/model` 形式的默认模型

下面是一份最小的 OpenAI 兼容 Chat Completions 配置：

```yaml
default: my-provider/my-model
providers:
  my-provider:
    providerType: openai-completions
    baseUrl: https://api.example.com/v1
    apiKey: replace-with-your-key
    models:
      - my-model
```

实现 Responses API 的端点用 `openai-responses`，Anthropic 兼容端点用 `anthropic`。本地的 OpenAI 兼容网关如果不需要密钥，`apiKey` 可以留空。

:::caution
真实的 API Key 只放在你自己的 `foxwarm-data/state/models.yaml` 里。不要提交这个文件，也不要把凭据贴到公开 issue、文档或截图里。
:::

## Setup 用到的文件

- 模型配置：`foxwarm-data/state/models.yaml`
- 应用和渠道配置：`foxwarm-data/state/config.yaml`
- WebUI 访问令牌：`foxwarm-data/state/token`

如果你选择了自定义数据目录，这些路径也随之变化。

在新安装中，首次 Setup 保存模型时还会创建 `state/config.yaml`，其中包含 `sessionAutoTitle: true`，即在每个新会话第一次回复后自动为它命名。已有的 `config.yaml` 不会被修改，包括你事先创建的文件（例如为了设置 `httpPort`）。如果你自己创建 `models.yaml` 跳过了首次 Setup，就不会创建这个文件；在 `config.yaml` 中加入 `sessionAutoTitle: true` 即可开启自动标题。没有这一项时，会话会一直显示 ID，直到你重命名。

## 第一次对话

保存模型配置后，打开默认会话，先问一个不需要工具的小问题。这次回复同时也是对服务商连接的简单实测。之后可以在你放心让 Agent 访问的目录里，试一个文件或命令相关的小任务。

模型配置完成后，内置的 `about-foxwarm` Skill 可以讲解各项概念，并指引你了解更深入的功能。

## 排查问题

- 第一条消息失败时，检查服务商类型、API 基础地址、模型 ID 和凭据。
- 在 Docker 里，`localhost` 指的是容器本身。请使用主机可达的地址，例如在支持的环境中使用 `host.docker.internal`。
- 如果手动编辑的配置导致无法完成设置，修正或删除数据目录里的 `state/models.yaml`，即可回到首次设置。
- 如果 WebUI 没有任何回复，查看 `foxwarm-data/state/logs/`。

基本对话正常后，可以参考[模型选项与路由](/zh/docs/model-options/)（英文），了解推理强度、别名、故障切换、托管搜索和图像生成。
