# Vector 记忆

Foxwarm 使用 LanceDB 实现长期记忆与检索增强（RAG）。

> 相关归档/lineage 迁移说明见：`docs/archive-store.md`

## 作用

Vector memory 主要用于：

- 为后续对话提供长期上下文
- 让模型检索过去的重要消息
- 支持跨时间的项目回顾、历史查询、上下文恢复

## 数据位置

```text
state/db/
```

当前 vector 索引的上游归档主读取层已经切到：

```text
state/archive-store.sqlite
```

legacy JSONL archives 仍保留，用于兼容、双写与 bootstrap 导入。

## 基本流程

1. 从 archive store 读取 raw messages / layered blocks
2. 过滤系统噪声 / 不适合索引的内容
3. 分段 / 分块（segment + chunk）
4. 生成 embedding
5. 写入 LanceDB

## 索引命令

```bash
/session index
```

如果 session 尚有未索引 raw messages 或 new blocks，会把新增内容写入向量数据库。

## 检索工具

### 搜索记忆

```ts
recall({
  vector_query: 'project progress',
  limit: 5,
})
```

现在 `recall({ vector_query })` 会混合检索：

- raw archive chunks
- layered compact blocks

命中后会先根据 vector row 元数据回查原始 archived message/block 范围，再走 recall 的统一 preview renderer（总 `previewLength` 预算、tool 折叠、query/includeRegex/excludeRegex 过滤）。旧的 `search_vector` / `search_memory` 工具已删除。

### 获取时间附近上下文

```ts
get_memory_context({
  timestamp: Date.now(),
  limit: 10,
})
```

`get_memory_context` 仍保持 **raw-only**，不返回 block 摘要结果。

## mixed row / checkpoint 变化

当前 LanceDB 表使用 `messages_v7`，会同时存两类 row：

- `memory_kind = 'raw'`
- `memory_kind = 'block'`

block rows 除了文本和向量外，还会带：

- `block_id`
- `block_level`
- `raw_start_seq`
- `raw_end_seq`
- `source_kind / source_start / source_end`

vector checkpoint 现在主要记录在 SQLite archive store 的 `archive_checkpoints` 中。
legacy `vector-index-checkpoints-v2.json` 仍可兼容读取并迁移。

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
- `state/archive-store.sqlite`：归档、lineage、checkpoint 主读取层
- `state/logs/sessions/*.jsonl`：legacy 兼容 / 双写 / bootstrap 来源
- `state/db/`：LanceDB 向量检索库
