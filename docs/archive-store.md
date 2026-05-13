# Archive Store / Lineage Migration

Foxwarm 现在同时维护两层归档存储：

1. **legacy JSONL archives**
   - `state/logs/sessions/<session>.jsonl`
   - `state/logs/sessions/<session>.blocks.jsonl`
2. **new SQLite archive store**
   - `state/archive-store.sqlite`

## 新 archive store 的角色

SQLite archive store 是新的**主读取层 / lineage 感知层**，负责：

- 归档消息读取
- layered block 读取
- fork lineage / parent-child 继承关系
- archive-based vector checkpoint
- inherited / local 区分

当前 schema 以务实可迁移为主，核心表包括：

- `archive_branches`
- `archive_messages`
- `archive_blocks`
- `archive_checkpoints`

## legacy JSONL 的当前地位

legacy JSONL **没有立刻废弃**，目前仍然承担三种角色：

- 兼容旧数据
- 双写回退层
- bootstrap / migration 导入来源

也就是说：

- 新写入会同时写 JSONL + SQLite
- 新读路径优先走 SQLite
- 启动/初始化时，如果 SQLite 缺数据，可以从 JSONL 补导

## 初始化迁移 / bootstrap 行为

系统现在采用：

- **startup bootstrap import + lazy fallback**

### startup bootstrap import

archive store 初始化时会：

1. 扫描 sessions metadata
2. 扫描 legacy archive / block log 文件
3. 为已知 session 建立 `archive_branches`
4. 从 legacy JSONL / `.blocks.jsonl` 导入 raw messages / blocks 到 SQLite

导入是 **幂等** 的：

- SQLite 侧使用主键 + `INSERT OR IGNORE` / `INSERT OR REPLACE`
- 重启后重复 bootstrap 不会无限重复灌入相同记录

### lazy fallback

如果后续发现某个 session 在启动扫描里没覆盖到，读取时仍会触发按 session 的导入补齐。

## fork lineage 语义

### 新语义

fork child session 不再复制 parent 的 archive 文件；而是：

- child branch 记录 `parent_session_id`
- 记录 fork point：
  - `fork_message_seq`
  - `fork_block_id`
- child 本地只保留自己的 local archive
- inherited 历史通过 lineage 读取拼接出来

### legacy fork 数据如何迁移

旧版本 fork session 常常会把 parent archive **直接复制**到 child 的 archive 文件里。

迁移时，系统会优先通过这类 legacy child archive 中“仍然带着 parent `sessionId` 的归档行”来推断 fork point：

- raw message fork point：child legacy raw archive 中，`sessionId == parentSessionId` 的最大 `seq`
- block fork point：child legacy block archive 中，`sessionId == parentSessionId` 的最大 `id`

这类情况可以较可靠地恢复 inherited/local 边界。

如果 child legacy archive 中已经没有 copied parent rows，但仍有 child 本地 rows，当前实现会做一个务实 fallback：

- raw：`fork_message_seq ≈ min(child-local-seq) - 1`
- block：`fork_block_id ≈ min(child-local-id) - 1`

这适合“已切到新语义、child 只保留 local rows，但 DB 丢失后需要重建”的场景。

## lineage 推断边界

当前推断主要依赖：

- sessions metadata 里的 `parentSessionId`
- legacy child archive 中是否还保留 parent sessionId 的 copied rows

因此有一个明确边界：

- 如果某个 legacy child session 只有 parent relationship metadata，**但 child archive 文件里已经不再保留 copied parent rows**，系统只能恢复“它有 parent”这一事实，不能总是精确恢复旧 fork boundary

这时会退化为：

- lineage relationship 保留
- 但 inherited/local 的历史边界可能只能部分推断

对于典型旧 fork（直接复制 archive 文件）的数据，这个推断通常是可恢复的。

## vector memory 的变化

vector memory 现在不再只索引 raw archive segments。

### mixed vector rows

LanceDB `messages_v7` 同时存：

- `memory_kind = 'raw'`
- `memory_kind = 'block'`

block rows 带有：

- `block_id`
- `block_level`
- `raw_start_seq`
- `raw_end_seq`
- `source_kind/source_start/source_end`

### 搜索语义

`search_vector` / `search_memory` 现在可以混搜：

- 原始 raw chunks
- layered compact blocks

而 `get_memory_context` 仍保持 **raw-only**，避免时间附近上下文被摘要块污染。

### checkpoint

archive-based vector checkpoint 现在以 SQLite `archive_checkpoints` 为主。
legacy `vector-index-checkpoints-v2.json` 仍可读，并会在初始化/访问时迁移到新 store。

## 迁移后的运维含义

当前建议把 SQLite archive store 看作：

- **主读取层 / 主 lineage 层 / 主 checkpoint 层**

把 JSONL 看作：

- **兼容写层 / bootstrap 来源 / 回退与审计材料**

后续如果再做第二阶段 object/blob 重构，可以继续在 SQLite 层往更规范的 object model 演进，而不需要再回到纯 JSONL 读取路径。
