# WebUI 使用

Foxwarm WebUI 提供浏览器界面，支持多 session 管理、实时消息推送、文件上传与常见会话操作。

## 启动

```bash
# 后台 tmux 运行
npm start

# 或前台运行
npm run start:notmux
```

## 访问地址

默认地址：

```text
http://localhost:3001
```

也可以通过 `HTTP_PORT` 修改端口。

## 登录

WebUI 使用本地 token 登录：

```bash
cat state/token
```

登录步骤：

1. 打开 WebUI 页面
2. 输入 token
3. 点击登录

## 主要界面

### 桌面布局

```text
Sidebar（会话列表） | Chat（聊天区域）
```

### 移动布局

```text
Session List
Chat
```

## Session 操作

### 会话列表

- 按最后消息时间排序
- 显示消息数量、子会话、busy / queue 状态
- 可切换当前 session

### 创建 / 切换

- 点击 `+` 创建新 session
- 点击列表项切换当前 session
- URL hash 会反映当前 session

### 常见操作

- Archive
- Fork
- Delete
- Rename

具体可用项取决于当前 WebUI 版本。

## 聊天功能

### 发送消息

1. 输入消息
2. 按 Enter 发送
3. 实时查看模型回复

### 文件上传

- 通过上传按钮选择文件
- 图片会被编码后随消息一起发送

### 实时推送

- 使用 SSE 推送新消息和 session 列表更新
- 通常无需手动刷新页面

## 相关命令

在 WebUI 中也可以直接使用：

```bash
/session list
/model
/node
/status
```
