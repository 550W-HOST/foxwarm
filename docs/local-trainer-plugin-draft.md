# 本地训练插件草案

本文档是一个依附于 `foxwarm` 现有架构的概念方案草案，目标是在**尽量不侵入主链路**的前提下，把用户日常使用闭源/远端模型产生的高质量交互，逐步沉淀为用户自己的本地模型能力。

核心思路不是“立刻替换 GPT / Claude”，而是：

1. 白天继续使用强教师模型承接复杂任务
2. 夜间或空闲时整理可训练数据并执行小步训练
3. 用真实会话回归测试本地模型
4. 仅把适合的部分请求灰度路由到本地模型
5. 在效果稳定后逐步扩大本地模型承担的流量

## 目标

- 作为 `foxwarm` 的一个**插件**存在，而不是把训练逻辑硬编码进核心会话流程
- 尽量复用现有基础设施：会话归档、后台队列、定时器、HTTP 路由、模型配置
- 优先支持 `7B/8B` 量级本地模型的小步微调，例如 `qwen3 8b`
- 第一阶段聚焦“高频、低风险、个人化”的任务，而不是试图全量替换远端模型

## 非目标

- 第一版不做全自动全参训练
- 第一版不直接篡改用户现有 `state/models.yaml` 的默认模型
- 第一版不承诺复杂编码、长链工具调用、深推理任务由本地模型稳定接管
- 第一版不把所有聊天记录直接作为训练语料

## 为什么适合放在 foxwarm 上

`foxwarm` 当前已经具备一批很适合做“离线蒸馏插件”的基础能力：

- 会话归档：每条消息已经被归档到 `state/logs/sessions/*.jsonl`
- 后台事件：支持把异步任务结果回投到 session 队列
- 持久化定时器：适合夜间触发数据整理、训练和评测任务
- 动态 HTTP 路由：可以给插件挂控制面板、状态接口、手动触发接口
- 模型路由集中：模型解析集中在 `llm` 层，适合加一个轻量 override hook

也就是说，这个能力更像是在 `foxwarm` 外围加一个“学习闭环”，而不是重写消息主链路。

## 产品定义

### 一句话描述

Foxwarm Local Trainer 是一个可选插件：它会在用户许可下，利用用户真实交互中沉淀出的高质量样本，在本地持续训练一个更懂用户偏好和高频任务的轻量模型，并把适合的请求逐步切到本地执行。

### 用户价值

- 降低长期推理成本
- 增强私有化与本地可控性
- 让模型随着使用逐渐学习用户的写作、格式、语言和工作习惯
- 在本地模型成熟后，减少对外部 API 的依赖

### 首版定位

首版目标不是“完全替换远端模型”，而是先实现：

- 让 `20% - 40%` 的高频个人任务可由本地模型完成
- 复杂请求继续走云端/教师模型
- 整个过程对现有 `foxwarm` 用户尽量无感，且可随时关闭

## 插件化原则

### 原则 1：不污染主消息链路

数据采集优先基于已有归档，而不是在 `MessageRouter` 中插入大量训练逻辑。

### 原则 2：核心只加薄钩子

建议核心只提供以下能力：

- 插件注册/加载机制
- 插件可注册 HTTP 路由
- 插件可注册定时任务
- 插件可查询 session / 归档 / 模型配置
- 插件可提供模型 override 决策

### 原则 3：训练逻辑全部在插件内

包括但不限于：

- 数据筛选
- 样本格式转换
- 脱敏
- 调用训练脚本
- 回归评测
- 灰度策略生成

### 原则 4：失败自动回退

插件只影响“是否优先尝试本地模型”，不影响 `foxwarm` 的基础可用性。

## 建议目录结构

```text
foxwarm/
├── src/
│   └── plugins/
│       ├── context.ts
│       ├── manager.ts
│       └── types.ts
├── plugins/
│   └── local-trainer/
│       ├── index.ts
│       ├── README.md
│       ├── scripts/
│       │   ├── collect.ts
│       │   ├── curate.ts
│       │   ├── train.ts
│       │   ├── regress.ts
│       │   └── route.ts
│       └── templates/
│           └── config.example.yaml
└── state/
    └── plugins/
        └── local-trainer/
            ├── config.yaml
            ├── cursor.json
            ├── datasets/
            ├── runs/
            ├── reports/
            └── policy.json
```

## 与 foxwarm 现有能力的映射

### 1. 数据来源

首选直接读取会话归档：

- `state/logs/sessions/*.jsonl`
- 图片等附件仍然保留为归档引用，不作为首版训练重点

优点：

- 不修改用户的实时聊天体验
- 可以做增量扫描
- 可以重复回放与复现实验

### 2. 调度方式

优先复用现有定时器/后台队列思路：

- 夜间 cron 触发 `collect -> curate -> train -> regress`
- 手动 API 触发一次完整 pipeline
- 训练完成后把摘要结果投递回指定 session

### 3. 模型接入方式

本地模型仍然通过 `state/models.yaml` 定义，插件只负责：

- 选择哪一个本地模型 key 作为 student model
- 生成是否命中本地模型的灰度策略
- 在运行时建议 override 到某个本地模型 key

### 4. 结果可见性

插件通过 HTTP 接口暴露：

- 当前数据量
- 最近一次训练状态
- 最近一次回归分数
- 当前灰度比例
- 最近回退原因统计

## 插件工作流

### 阶段 1：采集 `collect`

从会话归档中增量扫描新增消息，生成候选样本。

#### 采集对象

- 用户输入 + 教师模型高质量回复
- 明确完成的工具调用结果
- 用户偏好反馈（例如“这个风格更好”“不要这么写”）

#### 采集过滤

- 丢弃极短、无意义闲聊
- 丢弃明显失败的回合
- 丢弃包含高敏感信息但未被用户允许训练的内容
- 丢弃结构损坏或上下文过碎的样本

#### 输出

- `raw_candidates.jsonl`
- 更新 `cursor.json`，记录归档扫描进度

### 阶段 2：整理 `curate`

把候选样本整理成训练和评测数据。

#### 目标数据集

- `sft.jsonl`：指令-回答微调数据
- `preference.jsonl`：偏好对比数据（可选）
- `eval_holdout.jsonl`：固定回归测试集

#### 整理逻辑

- 脱敏（邮箱、手机号、路径、token、账号等）
- 去重
- 任务分类（翻译、改写、摘要、固定格式输出、简单 coding assist）
- 质量打分
- 将低质量样本隔离到 `rejected.jsonl`

### 阶段 3：训练 `train`

首版只建议做小步训练：

- `LoRA` / `QLoRA`
- 基座优先选择用户已有本地模型生态可承载的 `7B/8B`

#### 不建议首版做的事

- 全参训练
- 每次只有几个样本也触发训练
- 多模型并行训练编排

#### 训练触发条件

- 新增合格样本数达到阈值
- 距离上次训练超过冷却时间
- 机器当前满足最低空闲条件（可后续补充）

#### 输出

- adapter / checkpoint
- `train_report.json`
- 训练日志

### 阶段 4：回归 `regress`

对训练后的本地模型做固定评测。

#### 评测指标

- 任务成功率
- 格式遵循率
- 与教师模型输出的一致性/相似性
- 幻觉率
- 回答长度稳定性

#### 评测方式

- 固定 holdout 集离线跑一遍
- 必要时抽样请教师模型做 judge
- 对比上一个稳定版本，避免“越训越差”

#### 输出

- `eval_report.json`
- 结论：`promote` / `hold` / `rollback`

### 阶段 5：灰度路由 `route`

根据评测结果生成 `policy.json`。

#### 推荐策略

先按“任务类型 + 概率”联合控制：

- 改写：`20%`
- 摘要：`20%`
- 翻译：`10%`
- 固定格式化输出：`30%`

复杂编码、长链工具调用、深推理请求默认不进本地灰度。

#### 路由原则

- 命中灰度才尝试本地 student model
- 本地报错或置信度低则立即回退 teacher model
- 每个回退 case 重新进入候选数据池

## 路由与灰度策略设计

本地模型灰度不建议做成“随机抽样一些流量给 student model”，而应该做成一个可解释、可回退的**路由决策器**。

推荐决策顺序为：

1. 先判断这条请求是否**允许**走本地
2. 再判断这条请求是否**适合**走本地
3. 最后在适合的请求中再按策略执行灰度

### 决策总流程

建议插件内部按以下顺序做决策：

#### 第 1 层：硬过滤

命中以下条件时，直接不走本地模型：

- 请求需要联网搜索、浏览器或外部检索
- 请求强依赖复杂工具链或多步工具调用
- 请求包含图片、音频、文件附件等多模态输入
- 上下文过长，超过 student model 的安全上下文阈值
- 任务属于高风险领域，例如医疗、法律、财务或高权限操作
- 请求明显属于复杂编码、复杂调试、深推理场景

这一层的目标是先把“高风险、低胜率”的请求挡在本地模型之外。

#### 第 2 层：任务分类

对剩余请求做轻量任务分类。首版推荐任务标签如下：

- `rewrite`：润色、改写、换风格
- `summarize`：总结、提炼、压缩
- `translate`：翻译、双语转换
- `format`：结构整理、表格化、模板化输出
- `qa_simple`：简单问答
- `coding_simple`：简单代码解释或小改动
- `coding_complex`：复杂编码、调试、方案设计

首版建议优先用**规则 + 请求结构特征**做分类，而不是再引入一个重模型。

可以使用的特征包括：

- 关键词，例如“润色”“翻译”“总结”“整理成表格”
- 是否出现代码块
- 是否出现“运行”“调试”“测试”“联网查一下”等动作词
- 输入长度与历史上下文长度

#### 第 3 层：能力匹配

分类后，再结合 student model 的历史表现判断该类型是否允许进入灰度池。

例如：

- `rewrite`：允许
- `summarize`：允许
- `translate`：允许
- `format`：允许
- `coding_complex`：默认不允许

这里不只看“理论上能不能做”，而要看**最近回归测试与线上统计是否稳定**。

#### 第 4 层：灰度命中

即便任务适合本地模型，也不应全量切换。建议按任务类型单独设置灰度比例，例如：

- `rewrite`：20%
- `summarize`：10%
- `translate`：15%
- `format`：30%

这样可以做到：

- 某个类型表现好，就只提升该类型比例
- 某个类型表现差，就只回退该类型，不影响全局

#### 第 5 层：执行后回退

请求真正进入本地模型后，仍然必须保留自动 fallback：

- 本地推理超时
- 输出为空或结构损坏
- JSON / 格式不合法
- 任务置信度过低
- 插件检测到回答不满足最低质量要求

一旦触发以上条件，应立即回退到 teacher model，并记录回退原因。

### 适不适合走本地：推荐评分法

首版不需要复杂的“智能路由模型”，可以先用一个可解释分数：

```text
local_score = task_fit + historical_success + user_preference - risk_penalty - complexity_penalty
```

可以拆成以下维度：

- `task_fit`：这个任务类型是否属于 student model 擅长范围
- `historical_success`：本地模型最近在该类型任务上的成功率
- `user_preference`：该用户/agent 是否偏好本地回答风格
- `risk_penalty`：是否涉及高风险、高准确率要求场景
- `complexity_penalty`：是否有长上下文、代码块、多工具、多步骤推理

例如：

- `rewrite`：`+30`
- `summarize`：`+25`
- `translate`：`+25`
- `coding_complex`：`-40`
- 需要工具：`-50`
- 上下文过长：`-20`
- 最近该类任务胜率 > `85%`：`+20`
- 用户最近显式偏好本地回答：`+10`

然后定义一个阈值，例如：

- `score < 60`：直接走 teacher model
- `score >= 60`：允许进入灰度池

### 如何评价 student model 是否“能接这类请求”

建议同时结合**离线评测**与**在线反馈**。

#### 离线评测

每次训练后，对 `eval_holdout.jsonl` 按任务类型分别出分：

- 成功率
- 格式遵循率
- 教师对齐度
- 幻觉率

这些分数决定“这个任务类型有没有资格进入灰度”。

#### 在线反馈

线上反馈建议同时记录显式与隐式信号。

显式反馈：

- 用户点赞 / 点踩
- 用户通过命令或按钮标记“本地回答不错/不行”

隐式反馈：

- 用户短时间内重问同一问题
- 用户明确回复“不是这个意思”“重来”“错了”
- 本地回答后紧接着又回退老师模型
- 结构化输出校验失败
- 本地推理后工具阶段失败

可以给不同信号不同权重，例如：

- 显式差评：`-1.0`
- 显式好评：`+1.0`
- 自动 fallback：`-0.8`
- 短时间重问：`-0.6`
- 用户直接接受无修正：`+0.2`

插件持续滚动统计每个任务类型的 `winRate`、`fallbackRate`、`negativeFeedbackRate`。

### 推荐的灰度阶段

#### Stage 0：Shadow Mode

用户仍然看到 teacher model 的答案，插件只在后台偷偷跑 student model 并做离线比对。

用途：

- 不影响用户体验
- 快速积累“如果走本地会怎样”的评测数据
- 校验任务分类器和 fallback 规则是否合理

这是最推荐的首个灰度阶段。

#### Stage 1：低风险任务可见灰度

仅开放以下类型：

- `rewrite`
- `summarize`
- `translate`
- `format`

建议比例：`1% - 5%`。

#### Stage 2：按任务类型分别放量

每个类型单独调节，而不是全局统一升级：

- `rewrite` 可以先升到 `30%`
- `summarize` 可以保持 `15%`
- `translate` 可以升到 `25%`

#### Stage 3：按用户 / agent 差异化

某些 agent 适合本地模型，例如写作、文档整理、风格改写；某些 agent 不适合，例如复杂 coding agent。

### 什么时候应该停止放量

建议插件设置 stop-loss 规则：

- 最近 `100` 个本地请求失败率超过阈值，例如 `15%`
- 某个任务类型连续 `3` 次回归下降
- fallback 率短期快速上升
- 用户负反馈显著增加

一旦触发，则：

- 将该任务类型灰度比例降为 `0`，或
- 回退到上一个稳定比例

### 插件应维护的路由状态

建议 `state/plugins/local-trainer/` 下至少维护以下文件：

- `policy.json`：当前启用的任务类型、比例、阈值
- `metrics.json`：按任务类型统计的成功率、回退率、负反馈率
- `decisions.log`：每次请求为什么走本地、为什么回退

### 推荐的 `policy.json` 结构

```json
{
  "enabled": true,
  "studentModel": "local/qwen3-8b",
  "globalCanaryPercent": 5,
  "taskPolicies": {
    "rewrite": { "enabled": true, "percent": 20, "minWinRate": 0.85 },
    "summarize": { "enabled": true, "percent": 10, "minWinRate": 0.80 },
    "translate": { "enabled": true, "percent": 15, "minWinRate": 0.82 },
    "format": { "enabled": true, "percent": 30, "minWinRate": 0.90 },
    "coding_complex": { "enabled": false, "percent": 0, "minWinRate": 0.95 }
  }
}
```

### 推荐的路由伪代码

```ts
function decideModel(input) {
  if (matchesHardBlock(input)) {
    return { model: 'teacher', reason: 'hard-block' };
  }

  const taskType = classifyTask(input);
  const metrics = getTaskMetrics(taskType);
  const policy = getTaskPolicy(taskType);

  if (!policy.enabled) {
    return { model: 'teacher', reason: 'task-disabled' };
  }

  const score = computeLocalScore({ input, taskType, metrics });
  if (score < 60) {
    return { model: 'teacher', reason: 'score-too-low' };
  }

  if (metrics.winRate < policy.minWinRate) {
    return { model: 'teacher', reason: 'win-rate-too-low' };
  }

  if (!hitCanary(policy.percent)) {
    return { model: 'teacher', reason: 'canary-miss' };
  }

  return { model: 'student', modelKey: 'local/qwen3-8b', reason: 'canary-hit' };
}
```

### 建议的首版结论

首版最稳妥的做法是：

- 先做 `Shadow Mode`
- 再只放开低风险、高频任务
- 再依据任务类型单独放量
- 全程记录回退原因并保留 teacher model 兜底

换句话说，灰度不是“随机抽一部分请求给本地”，而是：

- 先做任务分类
- 再看 student model 在该类任务上的历史成绩
- 只对低风险、高胜率任务做按类放量
- 始终保留自动 fallback

## 为什么不能直接“全量聊天即训练”

聊天记录不等于训练数据。

原因包括：

- 闲聊噪音非常多
- 用户问题本身可能错误或情绪化
- 模型回复也会有错误，不能原样蒸馏
- 大量内容更适合做记忆/RAG，不适合写入参数

因此建议把“用户知识内化”拆成三层：

### 1. Memory 层

长期事实、偏好、项目背景、常用格式，优先进入记忆或检索。

### 2. Skill/Pattern 层

高频稳定任务，适合做 SFT / LoRA。

### 3. Preference 层

语气、格式、风格、输出习惯，适合做偏好优化或规则控制。

## 推荐的插件接口草案

下面是一个偏概念化的接口草案，重点是说明插件边界，而不是现在就要求完全照此实现。

```ts
export interface FoxwarmPlugin {
  name: string;
  setup(ctx: FoxwarmPluginContext): Promise<void>;
  dispose?(): Promise<void>;
}

export interface FoxwarmPluginContext {
  baseDir: string;
  stateDir: string;
  logger: Logger;
  http?: {
    addRoute(route: RouteHandler): void;
  };
  sessions: {
    queueSystemEvent(sessionId: string, message: string): Promise<void>;
    listSessions(): Array<{ id: string; model?: string; agent?: string }>;
  };
  timers: {
    registerCronJob(id: string, cron: string, handler: () => Promise<void>): Promise<void>;
  };
  routing: {
    registerModelOverride(fn: ModelOverrideHandler): void;
  };
}

export interface ModelOverrideHandler {
  (input: {
    sessionId: string;
    sessionModel?: string;
    latestUserText?: string;
  }): Promise<{ modelKey?: string; reason?: string } | null>;
}
```

## 本地训练插件配置草案

建议放在 `state/plugins/local-trainer/config.yaml`：

```yaml
enabled: false

teacherModel: openai/gpt-5.4
studentModel: local/qwen3-8b

schedule:
  collectCron: '0 */2 * * *'
  nightlyTrainCron: '30 2 * * *'

data:
  minSamplesToTrain: 300
  maxSamplesPerRun: 5000
  enableToolTraceSamples: true
  enablePreferenceSamples: false
  redactSensitiveData: true

training:
  mode: lora
  maxHours: 3
  batchSize: 8
  learningRate: 0.0002

routing:
  canaryPercent: 5
  allowedTaskTypes:
    - rewrite
    - summarize
    - translate
    - format
  fallbackOnError: true

trainingData:
  strategy: opt-in
  allowedAgents:
    - main
  allowedSessions: []
  maintainGoldenDataset: true
  goldenReplayRatio: 0.3

execution:
  mode: orchestrator
  trainerCommand: python scripts/train.py
  evaluatorCommand: python scripts/eval.py
  reportDir: state/plugins/local-trainer/reports

reporting:
  notifySessionId: main
```

## 推荐的首版实现范围

### MVP-0：只做离线闭环，不改线上路由

- 增量收集归档数据
- 生成训练/评测集
- 手动触发训练
- 产出评测报告

这是最稳的第一步，也最符合“低侵入”。

### MVP-1：加入受控灰度

- 插件生成 `policy.json`
- `llm` 层支持一个 model override hook
- 仅对少数任务类型按低比例路由到本地模型

### MVP-2：加入反馈闭环

- 统计本地命中率、失败率、回退率
- 把失败 case 自动回流到数据池
- 支持用户显式标注“这次本地回答不错/不行”

## 风险与约束

### 1. 隐私风险

用户必须明确授权哪些数据可用于训练。

建议至少提供：

- 全局开关
- agent 级开关
- session 级排除
- 敏感字段脱敏

### 2. 数据污染

如果把错误答案也作为标准答案学习，本地模型会越来越不稳定。

### 3. 模型退化

过于频繁的小批量增量训练，可能让模型越来越“像用户口头禅”，但基础能力下降。

### 4. 设备门槛

`8B` 级别更现实；`20B` 对普通个人设备、时长和显存都更有压力。

### 5. 评测失真

训练集和评测集如果混在一起，会让结果虚高。

## 架构落地的潜在风险与优化建议

以下问题建议在第一阶段就纳入设计，否则端到端跑通后很容易暴露出结构性瓶颈。

### 1. 灾难性遗忘与黄金数据集

如果每次夜间训练只依赖最近新增的增量会话样本，student model 很容易快速偏向最近几天的话题、语气和局部任务分布，导致旧任务能力和基础能力退化。

建议在 `curate` 阶段维护一个长期滚动的 `golden dataset`：

- 从历史高质量、高稳定性样本中定期筛选一批长期保留样本
- 每次训练时将黄金数据按固定比例混入当日增量数据
- 让训练批次形成 `新数据 + 历史高质量回放` 的结构

这本质上是一种 `experience replay`，可以显著降低灾难性遗忘风险。

建议首版就在插件状态中维护：

- `golden_sft.jsonl`
- `golden_eval.jsonl`
- `golden_manifest.json`

### 2. TS / Node 编排层与 Python / Rust 训练层的边界

`foxwarm` 的插件宿主适合做编排和状态管理，但不适合直接承载张量计算、数据密集清洗或模型格式转换。

因此建议明确：`local-trainer` 插件只做 Orchestrator，不做 Trainer 本体。

推荐边界如下：

- TypeScript / Node 插件负责扫描归档、整理目录、生成 JSONL、注册路由与任务、读取结果报告
- Python 训练脚本负责 SFT / DPO / 评测
- Rust 或原生工具链可负责 GGUF 转换、LoRA 融合、量化等底层任务

插件与外部训练栈之间通过以下方式解耦：

- 输入：写入规范化数据文件与任务配置文件
- 输出：读取标准化 `report.json`、`metrics.json`、`artifacts.json`
- 运行：通过子进程触发，而不是把训练逻辑嵌入 Node 运行时

这样可以让应用栈与训练栈独立迭代，也更符合低侵入原则。

### 3. SFT 与偏好对齐的节奏

首版如果目标是尽快跑通闭环，应坚持只做 SFT，不要一开始同时引入偏好优化。

但从中期来看，仅靠 SFT 学习“语气、格式、风格偏好”并不总是高效。对于这些偏好性很强的问题，`DPO` 一类方法往往更直接。

建议路线如下：

- `MVP-0`：只做 `SFT`
- `MVP-1`：加入灰度与反馈统计
- `路线 B`：在样本质量稳定后，再引入轻量级 `DPO`

可用的数据来源包括：

- 用户更偏爱的 teacher 回答
- 被判定为失败或低分的 student 回答
- `rejected.jsonl` 中可构造出的 rejected 侧样本

这样可以自然形成 `chosen / rejected` 对，为后续偏好对齐提供基础。

### 4. 样本质量与安全过滤

真实用户会话里可能包含：

- 测试模型底线的攻击性 prompt
- 越狱提示词
- teacher model 偶发的幻觉
- 明显断裂或无参考价值的上下文

如果这些样本被原样蒸馏，本地模型会继承错误模式或不良行为。

建议在 `curate` 阶段增加一层轻量级的安全与质量过滤：

- 规则过滤：剔除明显拒答模板、断裂文本、无效上下文
- 小模型过滤：用极小本地模型做粗分类，识别明显有毒或不适宜蒸馏的样本
- 结构过滤：剔除工具执行失败、输出损坏、上下文不闭合的记录

首版完全可以从规则过滤开始，不必立即引入额外模型。

## 建议的技术路线

### 路线 A：最稳妥

`记忆/RAG + 路由 + 小步 LoRA`

适合首版，因为收益/风险比最高。

### 路线 B：中期增强

`SFT + DPO / preference optimization + canary routing`

适合在收集到足够稳定的 `chosen / rejected` 偏好对之后再做。

### 路线 C：远期目标

让本地模型承担默认高频任务，教师模型只做复杂请求升级。

## 建议的落地顺序

1. 先做插件宿主和 `local-trainer` 空骨架
2. 只做增量采集与数据整理
3. 手动接训练脚本
4. 加回归评测
5. 再加模型 override 和灰度

## 建议决策（针对待确认问题）

### 1. 训练脚本边界

建议 `foxwarm` 只负责调度外部训练脚本，不直接维护训练内核。

原因：

- 训练栈与应用栈职责不同
- Python / PyTorch / llama.cpp 等生态更适合快速迭代训练逻辑
- 可以降低 `foxwarm` 主仓库的复杂度与依赖膨胀风险

插件应输出标准格式数据，例如 ShareGPT 风格或自定义 JSONL，再调用外部训练进程执行。

### 2. 首版只支持一个 student model

建议首版只支持一个固定配置的 student model，例如 `qwen3-8b`。

原因：

- 多模型会显著增加评测成本
- 会增加 VRAM 与资源调度复杂度
- 会让路由与回归矩阵迅速膨胀

等单模型闭环跑通后，再通过 `state/models.yaml` 开放替换或扩展候选基座。

### 3. 灰度依据采用综合评分法

建议首版不要只看任务类型，也暂不强依赖实时置信度，而是采用文中定义的综合评分法：

- 任务类型
- 历史成功率
- 风险惩罚
- 复杂度惩罚
- 用户或 agent 偏好

其中实时置信度如果依赖本地模型额外推理，会增加延迟和成本；首版可以先主要依赖离线统计得到的历史成功率。

### 4. 反馈采集以隐式为主，显式为辅

建议把隐式反馈作为保底主渠道，显式反馈作为轻量补充。

原因：

- 用户通常不会持续给每条回答点踩或点赞
- 隐式信号更接近日常真实行为

推荐优先使用的隐式信号包括：

- 短时间内重问同一问题
- 用户明确表示“错了”“重来”“不是这个意思”
- 本地回答后马上触发老师模型兜底
- 结构化输出校验失败

如果需要显式反馈，建议只提供非常轻量的单按钮或简短命令，例如“此回答未达预期”。

### 5. 训练数据访问采用 Opt-in 白名单

建议插件不能默认读取全量 session archive，而应采用 `opt-in` 白名单机制。

建议的粒度包括：

- agent 级允许训练
- session 级允许训练
- 对私人闲聊、敏感 agent 默认关闭
- 对低隐私、工具型 agent 可以单独开启

这有助于在产品层面建立用户信任，也能降低隐私风险。

## 总结

对于 `foxwarm` 来说，这个方向最合理的实现方式不是“把训练系统写进聊天主循环”，而是：

- 让核心提供极少量插件挂载点
- 让 `local-trainer` 插件复用归档、后台队列、定时器和模型配置
- 先完成“离线学习闭环”，再逐步进入线上灰度

这样既能保住 `foxwarm` 当前代码体量和清晰度，也能给后续真正的本地替代路线留下空间。
