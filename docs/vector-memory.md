# Vector 记忆

Foxwarm 使用 LanceDB 实现长期记忆与检索增强（RAG）。

## 作用

Vector memory 主要用于：

- 为后续对话提供长期上下文
- 让模型检索过去的重要消息
- 支持跨时间的项目回顾、历史查询、上下文恢复

## 数据位置

```text
state/db/
```

## 基本流程

1. 从 session history 中提取可索引文本
2. 过滤系统噪声 / 不适合索引的内容
3. 分块（chunk）
4. 生成 embedding
5. 写入 LanceDB

## 索引命令

```bash
/session index
```

如果 session 尚有未索引消息，会把新增内容写入向量数据库。

## 检索工具

### 搜索记忆

```ts
search_vector({
  query: 'project progress',
  limit: 5,
})
```

### 获取时间附近上下文

```ts
get_memory_context({
  timestamp: Date.now(),
  limit: 10,
})
```

## 索引安全性

Foxwarm 会记录一些状态来避免索引过程与历史变更互相冲突：

- `vectorIndexPosition`
- `indexingState`
- `historyVersion`

这让中断恢复、重复启动、历史压缩后的重建更可控。

## Embedding 配置

默认使用 Ollama：

```bash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=nomic-embed-text
```

示例：

```bash
ollama pull qwen3-embedding:0.6b
```

## 相关参数

```bash
CHUNK_SIZE=8000
OVERLAP_PERCENT=0.1
EMBEDDING_MAX_LENGTH=4000
```

## 说明

Vector memory 是长期检索层，不等同于 agent memory 文件：

- `agents/<agent>/memory/`：人工维护的长期指令 / 背景知识
- `state/db/`：从历史消息索引出的检索库
