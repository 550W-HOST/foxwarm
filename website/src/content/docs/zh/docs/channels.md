---
title: 渠道与群聊
description: 在 Telegram、Matrix、QQ、微信或企业微信里访问会话，把会话带进团队群聊，并控制谁能和它对话。
---

渠道（Channel）在聊天软件和 Foxwarm 会话之间传递消息。内置的适配器有 Telegram、Matrix、企业微信（WeWork）、微信（Weixin）和 QQ 机器人，每种都可以配置多个实例。

任何聊天会话都可以接到任何 Foxwarm 会话上。WebUI 和聊天软件共用同一个会话、同一份历史：你可以在电脑前把事情理清楚，再用手机接着聊，或者把它带进群里让其他人提问。

## 把会话带进群聊

假设你上午在 WebUI 里和 Agent 一起改完了计费逻辑，现在团队想知道改了什么。

1. 在聊天软件里把你的 Foxwarm 机器人拉进团队群。
2. 在群里把这个群聊接到那个会话上：

   ```text
   /attach tidepool/proration
   ```

3. 请 Agent 解释，例如 *"@foxwarm 用两句话跟大家说一下这次改动。"* 它的回答基于整个会话的历史。
4. 群里的其他人可以直接追问。每条消息都会带着发送者的名字交给 Agent，它知道是谁在问。

`/attach` 会先把群聊从之前接入的会话上断开，所以之后也可以把同一个群改接到别的会话。

群成员的消息会进入会话，Agent 可能会用工具来回答。把会话开放给群之前，先确认这个 Agent 能做什么、能看到什么。面向其他人的会话，适合交给一个[规则](/zh/docs/access-control/)更严格的专用 Agent。

## 谁能和 Agent 对话

每个渠道都有一个 `allowedUsers` 列表，填写平台用户 ID。其他人发来的消息会收到一条简短回复，里面有他们的用户 ID，以及想授权时需要加到 `config.yaml` 的配置片段。任何人都可以用 `/whoami` 查看自己的 ID。

如果想让某个群里的所有人都能和 Agent 对话，在那个群里运行：

```text
/channel dangerously-allow-all-users yes
```

这只对当前这个聊天生效。不在允许列表里的人可以在这里聊天提问，但 `/attach`、`/channel` 等命令仍然只有允许列表里的用户能用。用 `no` 关闭。

## 添加渠道

打开 **Setup → Config**，在 `state/config.yaml` 的 `channels` 下添加一项。键名就是实例 ID，`type` 选择适配器。下面每个示例都是独立的起点；配置多个渠道时，把它们放在同一个 `channels` 映射下。

`allowedUsers` 里填平台用户 ID，不是显示名称。把权限给应该能向 Agent 派活的人，然后确认这个聊天接到了哪个会话。机器人已连接、发送者已授权，并不等于确定了 Agent 的工具权限。

保存 Config 会用新设置重启各渠道连接。可以在 Setup 里查看状态，或运行：

```text
/channel status
```

## Telegram

```yaml
channels:
  telegram:
    type: telegram
    enabled: true
    botToken: "replace-with-your-bot-token"
    mainAttachUser: "your-telegram-user-id"
    allowedUsers:
      - "your-telegram-user-id"
```

填写这个 Telegram 机器人的 token，用户 ID 用字符串形式的数字。`mainAttachUser` 会把该用户的私聊接到 main 会话，并把他加入允许列表。其他用户放进 `allowedUsers`，他们的会话接入需要另外配置。

## Matrix

```yaml
channels:
  matrix:
    type: matrix
    enabled: true
    homeserver: "https://matrix.example.com"
    accessToken: "replace-with-the-bot-access-token"
    botUserId: "@foxwarm:matrix.example.com"
    allowedUsers:
      - "@your-user:matrix.example.com"
```

access token 和 `botUserId` 必须属于同一个机器人账号。允许列表里填完整的 Matrix 用户 ID。聊天目标是房间 ID，和发送者的用户 ID 不是一回事。

## 微信

在 **Setup → Config** 底部点击 **Start Weixin login**，扫描二维码或打开配对链接，然后点击 **Check login**。成功后 Foxwarm 会保存凭据并刷新渠道。

使用前检查生成的渠道配置和访问设置。把 `allowedUsers` 限制在预期的用户；只有确实想接受所有能联系到这个机器人的人的消息时，才开启 `allowAllUsers`。不要把登录 token 复制到公开示例或仓库里。

重启后，可能需要对方先发来一条消息，Foxwarm 才能再次给该用户发消息，因为回复上下文只保存在内存中。

## QQ 机器人

```yaml
channels:
  qq-primary:
    type: qqbot
    enabled: true
    appId: "replace-with-your-app-id"
    clientSecret: "replace-with-your-client-secret"
    allowedUsers:
      - "allowed-user-openid"
    requireMention: true
```

填写 QQ 机器人应用的凭据，以及平台实际下发的允许用户 OpenID。应用需要在 QQ 一侧拥有对应聊天和消息事件的权限。

默认情况下，群消息需要 @机器人 才会触发回复。Foxwarm 会保留一定量的此前群聊内容作为这次 @ 的上下文。如果想让普通群消息也被处理，设置 `requireMention: false`；普通文字会在固定时间窗口内合并处理，默认 5 秒，`groupBatchWindowMs: 0` 关闭合并。@ 消息和媒体会立即处理。

单聊（C2C）和群聊支持文字以及受支持的图片、文件附件。频道和频道私信不支持媒体。聊天 ID 的形式为 `c2c:<openid>`、`group:<group-openid>`、`guild:<channel-id>` 和 `dm:<guild-id>`；它们标识的是目的地，不是 `allowedUsers` 里的用户。

## 企业微信

使用 WebSocket 连接的智能机器人：

```yaml
channels:
  wework:
    type: wework
    enabled: true
    allowedUsers:
      - "allowed-user-id"
    aibot:
      stream: true
      websocket:
        enabled: true
        botId: "replace-with-your-bot-id"
        secret: "replace-with-your-bot-secret"
```

这种模式不需要公网回调地址就能收消息。`stream: true` 会把回复和工具进度显示在流式卡片里。

如果改用 HTTP 回调，配置 `token`、`encodingAESKey`、`listenPort` 和 `listenPath`，并在平台的机器人配置里填写相同的值和可访问的回调地址，同时保持 `aibot.websocket.enabled` 关闭。`webhookUrl` 是另一种群机器人发送方式，仅接收智能机器人回调时不需要它。

同时配置了 WebSocket 和 webhook 时，普通的主动发送走已启用的 WebSocket 连接。WebSocket 发送失败不会自动改用 webhook 重发。

## 会话接入

会话接入把某个渠道里的某个聊天连接到一个会话。实例 ID（如 `qq-primary`）、聊天 ID（如 `group:<group-openid>`）和发送者的 OpenID 是三种不同的值。在聊天里运行 `/channel info` 可以查看这些 ID。

可以请 Agent 检查并把目标聊天接到目标会话。不应共享对话历史或工具权限的不同用户、不同用途，要分开接入。Agent 的 `send_to_channel` 工具用 `<channel-instance-id>:<conversation-id>` 指定明确的目的地。

普通回复会自动发到已接入的聊天。仅发送（send-only）的接入需要显式发送。把群开放给更多发送者，也意味着接收消息的 Agent 会看到他们的文字和文件；请使用权限合适的 Agent 和节点。

## 可选的进度消息

对使用普通文字回复的渠道，在它的配置项里加上：

```yaml
channelProgress:
  intervalMs: 60000
```

之后在较长的任务中，Foxwarm 会定期发送简短的工具进度。间隔单位是毫秒，范围 30,000 到 1,800,000。不写或设为 `false` 即关闭。WebUI 和企业微信流式卡片有各自的进度显示。

## 检查连接

1. 查看 Setup 里的渠道状态，以及保存或重载时的错误。
2. 让允许的用户在目标聊天里发一条短消息。
3. 确认这个聊天接到了预期的会话。
4. 如果消息能收到但回复失败，在 `state/logs/` 里检查平台凭据、目的地和发送权限。

手动控制可以用 `/channel start <channel-id>`、`/channel stop <channel-id>` 或 `/channel restart <channel-id>`。这里用的是配置里的实例 ID，而不是适配器类型（除非两者同名）。
