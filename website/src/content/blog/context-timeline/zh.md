---
title: 近的清楚，远的模糊，原话找得回：Foxwarm 怎样压缩长会话
description: 一个会话跑了几个月、压缩了几百次之后，上下文里应该留下什么？我们从记忆研究和流式数据结构里找到了答案，并用真实会话验证了它。
date: 2026-11-15
series: Agent 设计笔记
version: Foxwarm 0.9.5
---

模型的上下文窗口是有限的，agent 的工作不是。会话一长，总要有人决定哪些内容留在窗口里，哪些压成摘要，哪些干脆不要。

对一次几小时的编码会话，这个问题不难：把较早的对话压成一份摘要，留下最近的原文，接着干活。但 Foxwarm 的会话常常一跑就是几周甚至几个月。一个负责协调开发的会话，可能经历几百次压缩。到了这个量级，"摘要"本身就成了需要管理的东西。

这篇讲 Foxwarm 0.9.5 的做法：上下文按时间分层，越近越细，越远越粗，总量随历史长度对数增长；原始消息全部留在归档里，模型和人都能顺着摘要找回原话。

## 常见做法：一份滚动摘要 + 最近的原文

先看几个大家熟悉的 agent 是怎么做的。它们的选择都很合理，只是针对的场景不同。

- **Claude Code**：接近上限时自动压缩，也可以手动 `/compact`，把对话换成一份结构化摘要。压缩后会从磁盘重新注入 CLAUDE.md、auto memory 和 Skills，并重读这次会话读过或改过的文件里最近修改的至多 5 个。官方文档也直说了：较早的详细指令可能在压缩中丢失，需要长期保留的规则应该写进 CLAUDE.md。用户可以给 `/compact` 指定重点，也可以用 `/rewind` 只压缩一部分对话。
- **Pi**：上下文超过阈值时触发，保留最近约 20k token 的原文，把更早的部分交给模型总结，并把上一份摘要作为输入，生成新的摘要。原始记录留在 JSONL 会话文件里；切换分支时另有 branch summary；extension 可以接管压缩过程。
- **DeepSeek Harness**：压缩是一个可替换的插件接口。默认的 basic 后端把最老的一段历史压成摘要、保留近期消息，可以先裁掉过大的工具输出，上下文溢出时压缩后重试。事件日志只追加不修改，压缩事件也记录在里面；另有一个需要显式挂载的实验性插件，让模型检索会话、读取精确事件。

共同点是：工作上下文里只有**一份**代表过去的摘要，每次压缩都在上一份的基础上重写。会话短的时候，这样最简单，也足够好。

会话足够长时，这种结构有两种走向：要么每次都把旧摘要再压一遍，越早的事被转述的次数越多，细节一层层流失；要么新摘要不断叠加，越积越多，最后又把窗口塞满。

## 我们碰到的问题

Foxwarm 很早就不用单份摘要，而是把过去切成一个个摘要块（CTX-BLOCK）。块有层级：新压缩产生 1 级块，几个同级块合并成更高一级。这个方向是对的，但早期的合并规则是经验性的，比如"每一级最老的 40% 可以合并"。

一个持续运行了约半年的真实会话暴露了问题。它的上下文里积了 70 个摘要块，约 50k token。从老到新，块的层级是这样的：

```
8 7 5 4 1 4 2 7 4 2 6 5 3 7 1 5 4 2 6 4 3 1 …
```

高低交错，几个月前的 1 级小块夹在 4 级、5 级块中间，再也找不到同级的邻居合并；某一级可以无限堆积（这个会话里有 17 个 4 级块）；最新的几个 1 级摘要每个有七千到一万两千字符。没有任何一条规则在约束总量。

## 从记忆研究里找答案

与其继续调百分比，不如先问：一段历史值得保留多少细节？

心理学和数据结构两边给出的答案出奇地一致。

- **需要的概率随时间按幂律衰减。** Anderson 和 Schooler（1991）发现，人的遗忘曲线和环境的统计规律吻合：一条信息被再次用到的概率，大致按距上次使用时间的幂律下降。对 agent 来说，一段历史值得的细节量应当大致与它的"年龄"成反比。
- **时间轴应该是对数刻度的。** Shankar 和 Howard（2012）的尺度不变时间表征模型认为，大脑表示过去的分辨率与距今时间成反比：最近一分钟一个槽，最近一小时一个槽，最近一天一个槽，槽的数量只随时间的对数增长。
- **算法里早有现成的结构。** 指数直方图（Datar 等，2002）每个尺度最多保留 k 个桶，某一尺度溢出时，把最老的两个合并成上一尺度的一个桶，长度为 N 的数据流只需要 O(k log N) 个桶。LSM 树、汉诺塔式的备份轮换也是同一个思路。
- **先忘细节，后忘大意。** 模糊痕迹理论（Brainerd 和 Reyna）区分逐字记忆与要点记忆，前者消退得更快。所以越高层的摘要越应该只保留要点、仍然有效的决定和未完成事项。
- **稳定的知识会转移出去。** 互补学习系统理论描述了情景记忆如何逐渐巩固为语义记忆。对应到 Foxwarm：原始消息和摘要块是"情景"，Agent memory、Task、文档是"语义"。已经写进 memory 或 Task 的事实，摘要里留一个指针就够了。
- **遗忘只是取不到，不是没有。** Tulving 区分了"存着"和"取得到"。Foxwarm 的归档保存全部原始消息，recall 就是按线索提取。所以真正要优化的是：工作上下文占用的 token，加上每段内容被需要的概率乘以把它找回来的成本。很少被用到、又随时能找回的东西，不必占着窗口。

回头看，原来的"同级合并升一级"已经是指数直方图的雏形，只是缺了三条不变量：层级要从老到新单调不增；每一级块数有上限；每个块的大小有上限。

## 0.9.5 的规则

于是规则变得很短。

- **每次压缩**，从最新摘要块之后的原始消息写一个新的 1 级块。
- **每一级最多 3 个块。** 超出时，该级最老的两个合并成上一级的一个块，依次向上进位。从老到新，层级只降不升。一个 j 级块大约覆盖 2^(j−1) 次压缩的内容。
- **由引擎决定做哪些合并，模型只负责写摘要。** 以前模型可以在候选范围里自己挑，现在每次压缩要做的操作是确定的。
- **每个块有预算。** 新的 1 级块约 3,000 token，合并块约 1,500 token（都是估算值）。明显超出时退回给模型缩短，最多两次。整个摘要区超过 24,000 token 时，最老的块吸收相邻的块。
- **最近的原文按 token 保留**，默认是压缩阈值的 30%，而不是按消息条数算。条数会把一条 100 字的通知和一条 2 万字的工具输出算成一样。

画出来，工作上下文大概是这样：

```
[系统提示与 memory] [L6][L5][L5][L4][L3][L3][L2][L2][L2][L1][L1][L1] [最近的原文……]
                     ←── 越早越粗 ──────────────────────── 越近越细 ──→
```

历史每翻一倍，大约多两个块。

自动压缩真正开始前，Foxwarm 还会先试一步不调用模型的处理：把历史中过大的工具输出裁掉，只有省下的空间足够多才提交，否则再进入上面的分层压缩。

## 摘要里写什么

预算之外，更重要的是内容。合并摘要被要求写成一份"接手说明"：当前状态、做过的决定及理由（附原始消息编号）、未完成事项（附 Task ID）、关键标识符。中间的排查步骤最先删掉；已经在 Agent memory、Task 或文档里的内容，只写指针。

几条细节规则都是在真实会话上踩出来的：

- 摘要使用源消息的主要语言，代码、标识符和术语保持原样。
- 规划摘要时，模型能看到历史里提到的 Task 的**当前**状态（只有状态，不含标题和内容），已经完成的 Task 不会在一次次合并中一直被写成"未完成"。
- 合并时，源块附带的 memory facts 会随源块离开工作上下文，所以合并摘要要把仍然重要的决定写进正文并标出处，而不是写一句"已记录在别处"。

## 原话随时找得回

压缩只改变工作上下文，不删除任何东西。

每条原始消息、每个摘要块都写入不可变的归档，并记录谱系：一个高层块由哪些块合并而来，最终覆盖哪一段原始消息。于是：

- **模型**可以用 `recall` 工具按块编号（如 `B#126`）或消息范围（如 `msg#10637-10680`）精确读取原文，也可以在会话里字面搜索。启用 Vector 后还能按语义检索，结果会回到归档里读出原文再呈现。精确读取不依赖 embedding 服务。
- **人**可以在 WebUI 里把摘要块一层层展开，一直看到原始消息。
- 模型想原样保留的个别消息（比如一段关键报错），可以在压缩时标记保留；等它所在的块后来被合并，这条消息会离开工作上下文，但仍在归档里。

所以在 Foxwarm 里，"遗忘"的意思是工作上下文里的分辨率降低了，不是信息没了。摘要没写下的那句话，只要模型意识到需要，就能找回来。

## 用真实数据验证

改规则之前，我们先离线回放了 222 个真实会话的摘要块结构。回放只用块的层级、大小、范围和时间，不读任何消息内容。

在历史较长的 41 个会话（至少 64 次压缩）里：

| | 旧规则 | 新规则 |
|---|---|---|
| 摘要块数，中位数 | 25–35 | 15 |
| 摘要块数，最大值 | 72–75 | 25 |
| 摘要区 token，中位数 | 约 16–18k | 约 8k |
| 两周前的块覆盖其年龄的比例 | 3–8% | 约 25% |

前三行两列都是同一个回放模型下的模拟值（旧规则按模型的不同合并倾向给出范围；真实快照里最多的一个会话有 102 个块）。最后一行旧规则取自真实快照。

最后一行说的是分辨率：旧规则下，两周前的历史反而保留得太细；新规则下，每个块大约覆盖它自身年龄的四分之一，不论新旧，这正是对数时间轴的形状。前面那个 70 块的会话，摘要区连同夹在块之间的保留消息约 63k token，模拟结果是 21 块、约 17k token。

也有没变好的地方：在摘要区里，压缩后还能原样复用的请求前缀比例，新旧规则都在 0.7 左右。合并必然改写它所在位置之后的内容，新规则的收益在于总量有界，不在缓存。

接着，我们复制了 4 个真实会话，在隔离环境里用会话原本的模型跑了几轮真正的压缩。三个中等长度的会话，摘要区从 15.0k、17.1k、17.3k 降到 9.5k、9.7k、7.3k token。那个 70 块的老会话每次最多做 3 次合并，逐步迁移：3 轮后是 51 块，按投影再过十来次压缩会降到 24k 以下，之后稳定在 19–23k、20 块左右。

更有价值的是看摘要写得怎么样。我们逐个对照了合并结果和它们的来源，发现了几个问题：

- 合并时会把来源里"截至此时尚未完成"的事项当作历史略掉，哪怕它今天仍然没完成；
- 来源块的 memory facts 不再重复后，模型会写"已记录在 Agent memory"之类的指针，可实际上并没有；
- 一个以中文为主的会话，有一轮生成的摘要全变成了英文；
- 后来的结果偶尔会被写进更早的合并块里。

前三个在发布前都调整了提示和规则。改完第一个之后的第二轮验证里，合并摘要基本都保住了带 Task ID 的未完成事项和带消息编号的决定。最后一个，提示里本来就明确禁止，模型偶尔仍会这样写，好在影响很小。

还有一个想法暂时没做：最近被 recall 过的块多保留一级细节，类似间隔重复。没有数据证明它值得，先加统计再说。

## 取舍与边界

- 摘要是有损的。模型手里的是摘要，要用到原话时得自己去 recall。它不会自动知道漏了什么。
- 每次压缩要一次额外的模型调用；每次合并都会改写摘要区里它之后的部分。
- 预算是估算值，不是硬上限；旧会话要经过几次压缩才会整理成新的形状。
- 这不是"无限上下文"。它解决的是长期运行的会话里，过去该以什么分辨率留在窗口里。

如果你的会话通常几小时就结束，一份滚动摘要已经够用，也更简单。等会话开始以周计，摘要本身需要被管理时，这套结构才显出价值。

## 试一试

Foxwarm 0.9.5 起，新会话直接使用这套规则，已有会话会在后续压缩中逐步整理。`/compact` 可以手动触发；`llm.compactThresholdPercent` 和 `llm.compactKeepPercent` 调整触发点和保留的原文量，见[长对话与历史检索](/zh/docs/history-search/)。

想先看看效果，可以打开[演示工作区](/demo/#session/tidepool%2Fsupport)，里面有一个经过压缩的会话。把视图切换到 Grouped 或 Detailed，就能看到摘要块，以及模型用 recall 找回原文的两次调用。

## 参考

- J. R. Anderson, L. J. Schooler. Reflections of the environment in memory. *Psychological Science*, 1991.
- K. H. Shankar, M. W. Howard. A scale-invariant internal representation of time. *Neural Computation*, 2012.
- M. Datar, A. Gionis, P. Indyk, R. Motwani. Maintaining stream statistics over sliding windows. *SIAM Journal on Computing*, 2002.
- C. J. Brainerd, V. F. Reyna. Fuzzy-trace theory（逐字痕迹与要点痕迹）。
- J. L. McClelland, B. L. McNaughton, R. C. O'Reilly. Why there are complementary learning systems in the hippocampus and neocortex. *Psychological Review*, 1995.
- E. Tulving, Z. Pearlstone. Availability versus accessibility of information in memory for words. *Journal of Verbal Learning and Verbal Behavior*, 1966.
- Claude Code 文档：[Context window](https://code.claude.com/docs/en/context-window)、[How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)（2026-11 读取，v2.1.325）。
- Pi 文档：[Compaction](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/compaction.md)、[Sessions](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/sessions.md)（earendil-works/pi，2026-11 读取，v1.5.2）。
- DeepSeek Harness 文档：[Compaction 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/docs/subsystems/compaction.md)、[compaction-basic](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/compaction/compaction-basic/README.md)、[tool-session-query](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/experimental/tool-session-query/README.md)（dsh-v0.2.2-rc.3）。
- Foxwarm：[0.9.5 release notes](https://github.com/550W-HOST/foxwarm/blob/main/docs/release-notes/v0.9.5.md)；Code Index [`threads/context-compaction.md`](https://github.com/550W-HOST/foxwarm/blob/main/docs/code-index/threads/context-compaction.md)（[D-context-log-retention](https://github.com/550W-HOST/foxwarm/blob/main/docs/code-index/threads/context-compaction.md#d-context-log-retention)）、[`threads/archive-and-recall.md`](https://github.com/550W-HOST/foxwarm/blob/main/docs/code-index/threads/archive-and-recall.md)。
