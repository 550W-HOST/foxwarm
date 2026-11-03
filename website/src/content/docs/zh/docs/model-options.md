---
title: 模型选项与路由
description: 配置多个服务商，按会话切换模型，设置推理强度和上下文上限，用别名和故障切换路由，以及开启托管搜索和图像生成。
---

所有模型配置都在 `state/models.yaml` 里，可以在 **Setup → Models** 中编辑。编辑器会校验 YAML，并在输入时提示字段名。保存后从下一次请求开始生效，不需要重启；正在进行的请求会用它开始时的设置完成。

先按[配置第一个模型](/zh/docs/model-setup/)接通一个服务商，这一页介绍之后还能加什么。示例里的模型名都是占位符，请换成你的端点提供的 ID。

## 一份更完整的示例

```yaml
default: daily                       # 会话没有自选模型时使用

providers:
  gateway:                           # OpenAI 兼容端点
    providerType: openai-responses
    baseUrl: https://api.example.com/v1
    apiKey: replace-with-your-key
    effort:
      allowed: [low, medium, high]
      default: medium
    models:
      - fast-model                   # 直接写模型 ID
      - id: big-model                # 或写成对象，附带单模型设置
        contextLimit: 400000
        pricing: { cached: 0.5, input: 2, output: 8 }

  claude:                            # Anthropic 兼容端点
    providerType: anthropic
    baseUrl: https://anthropic.example.com
    apiKey: replace-with-your-key
    models: [writer-model]

  daily: gateway/fast-model          # 简短别名

  resilient:                         # 先用 big-model，失败时换 writer-model
    providerType: failover
    targets: [gateway/big-model, claude/writer-model]
```

模型用 `provider/model` 的形式引用，例如 `gateway/big-model`，也可以用 `daily` 这样的别名。

## 切换模型

每个会话有自己的模型。可以在输入框旁边的模型菜单里选择，也可以输入：

```text
/model                          查看当前模型和可选项
/model writer                   切换模型，写部分名称即可
/model big-model --effort high  同时切换模型和推理强度
/model --effort low             只改推理强度
/model default                  恢复为配置的默认模型
```

换模型不会丢失对话，下一次请求会把同样的历史发给新模型。Agent 也可以让[子会话](/zh/docs/delegation/)使用别的模型，比如让日常检查用更便宜的模型。

## API 格式

| `providerType` | 适用于 |
| --- | --- |
| `openai-completions` | OpenAI 兼容的 Chat Completions 端点，包括大多数本地服务和网关 |
| `openai-responses` | OpenAI 兼容的 Responses 端点 |
| `openai-ws` | 同时支持 WebSocket 传输的 Responses 端点 |
| `anthropic` | Anthropic 兼容端点 |

`openai` 也可以用来表示 Responses 格式。兼容某种格式不代表网关支持全部可选功能，所以先确认普通对话可用，再开启托管工具或 WebSocket 传输。

WebSocket 传输会在后续请求中复用已打开的连接。完整对话仍由 Foxwarm 自己保存，重启后连接缓存会重新建立。

## 推理强度

Foxwarm 支持 `none`、`low`、`medium`、`high`、`xhigh` 和 `max`。声明端点接受哪些档位，以及默认用哪一档：

```yaml
effort:
  allowed: [low, medium, high]
  default: medium
```

这段可以写在服务商上，也可以写在单个模型对象上覆盖服务商的设置。模型的 `allowed` 会整体替换服务商的列表，没写的字段沿用服务商的。如果完全不写 `effort`，六个档位都允许，默认是 `high`；如果你的端点不接受某些档位，请收窄列表。

输入框旁的推理强度菜单会显示当前模型允许的档位。如果路由选中的模型不接受所选档位，Foxwarm 会改用该模型的默认档位。

## 单模型设置

下面这些字段写在模型对象（`- id: ...`）上；写在服务商上时，对它的所有模型生效：

| 字段 | 作用 |
| --- | --- |
| `contextLimit` | 模型的上下文窗口（token 数），自动压缩按它的比例触发。默认 200,000。 |
| `maxOutput` | 请求的输出 token 上限。默认 32,768。 |
| `upstreamModelId` | 实际发给端点的模型名，用于它和你在 Foxwarm 里使用的 ID 不同的情况（仅限模型对象）。 |
| `pricing` | `{ cached, input, output }`，单位为每百万 token 的美元价格。设置后，Foxwarm 会在每条回复的 token 用量旁保存估算费用（仅限模型对象）。 |
| `extraFields`、`extraHeaders` | 端点需要的额外请求体字段或 HTTP 头。 |
| `providerImageOutputFormat` | Foxwarm 发送前优化图片时使用的格式：`webp`（默认）或 `jpeg`。 |
| `imageInput` | 纯文本模型设为 `false`。图片仍保存在会话中，但发给该模型的请求只带一句“未发送图片”的简短说明；切回支持图片的模型后会重新发送。默认 `true`。 |

要统一修改所有模型，使用根级的 `defaults`。它只接受 `contextLimit`、`maxOutput`、`providerImageOutputFormat` 和 `imageInput`：

```yaml
defaults:
  contextLimit: 200000
  maxOutput: 32768
```

优先级从高到低：模型自己的值、服务商的值、`defaults`。

## 别名、固定分流与故障切换

除了具体的服务商，`models.yaml` 还可以定义指向具体模型的路由：

- **别名**：`daily: gateway/fast-model`。一个简短、稳定的名字。以后改它指向的模型，使用它的会话不用动。
- **故障切换**（`providerType: failover`）：按顺序尝试 `targets`。持续失败的目标会被暂时跳过（默认连续失败 5 次后跳过 10 分钟，可用 `failureThreshold` 和 `cooldownMs` 调整）。至少需要两个目标。
- **固定分流**（`providerType: session-hash`）：把会话分散到几个等价的 `targets` 上，但同一段对话始终落在同一个目标，保持服务商的提示词缓存命中。

目标必须是同一文件里的具体模型，路由不能指向另一个路由。路由可以像普通模型一样选择，它的上下文上限取所有目标中最小的那个。历史里的每条回复都会记录实际回答的具体模型。全部选项见仓库里的[虚拟模型参考](https://github.com/550W-HOST/foxwarm/blob/main/docs/virtual-models.md)。

## 托管搜索与图像生成

提供托管工具的 Responses 端点，可以在 Foxwarm 自己的工具之外再提供网页搜索和图像生成。在 Responses 服务商或模型对象上开启：

```yaml
webSearch: true
imageGeneration: true
```

只开启端点实际支持的功能。在其他类型的服务商上开启图像生成会被拒绝。这些是服务商自带的工具，和 MCP 服务器无关，也不在节点上运行。

两者都可以写成对象做更细的控制：

```yaml
webSearch:
  enabled: true
  toolChoice: auto              # 或 required
  searchContextSize: medium

imageGeneration:
  enabled: true
  outputFormat: png             # png、jpeg 或 webp
  background: transparent
```

其他图像选项有 `action`、`model`、`size`、`quality` 和 `outputCompression`（0–100，用于 JPEG 或 WebP）。具体支持哪些值由端点决定。

搜索结果和引用来源会显示在时间线里。生成的图片重新加载会话后仍然保留；要继续编辑同一张图，请保持同一个模型，因为换了模型就拿不到原来的生成结果。压缩时不会使用托管工具。模型级设置会覆盖服务商设置，设为 `false` 即关闭。

## 兼容性设置

大多数端点用不到这些，只在某个网关表现特殊时使用。

- **`historyReasoningField: reasoning`**（仅 Chat Completions）：有的端点在 `reasoning_content` 里返回思考内容，却要求后续请求把之前的思考放在 `reasoning` 里。默认值是 `reasoning_content`。
- **`disallowEmptyResponse: true`**：默认情况下，没有文字也没有工具调用的完整回复会正常结束这一轮。如果某个端点偶尔会错误地返回空回复，开启它让 Foxwarm 重试。
- **`sameModelAs` / `sameProviderAs`**：告诉 Foxwarm 两个配置项其实是同一个模型，比如通过两个网关访问同一模型。这样在它们之间切换时，会保留思考过程等服务商特有的历史；否则换模型时这部分会被丢弃。

压缩阈值不在这里设置，见[长对话与历史检索](/zh/docs/history-search/#compaction)（英文）。
