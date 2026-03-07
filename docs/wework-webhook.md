# 企业微信 Webhook 集成指南

Foxwarm 支持通过企业微信群机器人 Webhook 发送消息，并与其他 channel 共用同一个 backend。

## 配置步骤

### 1. 创建企业微信群机器人

1. 在企业微信中创建群聊
2. 点击群设置 → 群机器人 → 添加机器人
3. 配置机器人名称和头像
4. 复制 Webhook 地址，例如：

```text
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 2. 配置 Foxwarm

在 `.env` 中加入：

```bash
WEWORK_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=your_key_here

# 如果需要接收回调（可选）
# WEWORK_LISTEN_PORT=3002
# WEWORK_LISTEN_PATH=/wework/webhook
```

### 3. 启动 Foxwarm

```bash
npm start
```

启动后，Foxwarm 会自动连接并向企业微信群发送回复。

## 使用方式

### 文本消息

默认会发送文本回复。

### Markdown 消息

```ts
await weworkChannel.sendMarkdown('# 标题\n**粗体** *斜体*')
```

### @ 提醒

```ts
await weworkChannel.sendTextWithMentions(
  '请注意这条消息',
  ['userid1', 'userid2'],
  ['13800000000']
)
```

### 图片消息

```ts
await weworkChannel.sendImage(base64Data, md5Hash)
```

### 图文消息

```ts
await weworkChannel.sendNews([
  {
    title: '标题',
    description: '描述',
    url: 'https://example.com',
    picurl: 'https://example.com/image.jpg'
  }
])
```

## 限制说明

1. **频率限制**：每个机器人每分钟最多发送 20 条消息
2. **消息长度**：文本消息最长 2048 字节
3. **接收能力有限**：企业微信群机器人主要用于发送，接收侧能力较弱

## 与其他 Channel 共存

Foxwarm 支持同时启用多个 channel：

```bash
TELEGRAM_BOT_TOKEN=your_token
WEWORK_WEBHOOK_URL=your_webhook_url
ENABLE_WEBUI=true
```

## Session 路由

默认情况下，企业微信消息会路由到 `main` session。需要更复杂的路由时，可以在 backend 中自定义规则。
