---
title: "Recent in focus, older in outline, every word on file: how Foxwarm compacts long conversations"
description: "What should stay in context after a Session has run for months and been compacted hundreds of times? We found the answer in memory research and streaming data structures, then tested it on real Sessions."
date: 2026-11-15
series: Agent Design Notes
version: Foxwarm 0.9.5
---

A model's context window is finite; an agent's work is not. Once a conversation runs long, something has to decide what stays in the window, what gets condensed into a summary, and what is dropped altogether.

For a coding session of a few hours, this isn't hard: summarize the earlier conversation, keep the recent messages verbatim, and carry on. But Foxwarm Sessions often run for weeks or even months. A Session that coordinates development work can go through hundreds of compactions. At that scale, the summary itself becomes something that needs managing.

This post describes how Foxwarm 0.9.5 does it. Context is layered by time: the more recent, the finer the detail; the older, the coarser. The total grows logarithmically with the length of the history. Every original message stays in the archive, and both the model and people can follow a summary back to the original words.

## The usual approach: one rolling summary plus recent messages

First, a look at how some familiar agents handle this. Their choices are all reasonable; they are aimed at different situations.

- **Claude Code** compacts automatically as it approaches the limit, or manually with `/compact`, replacing the conversation with a structured summary. After compacting, it reloads CLAUDE.md, auto memory and skills from disk, and rereads up to 5 of the most recently modified files the session had read or edited. Its documentation says plainly that detailed instructions from early in the conversation can be lost in compaction, and that rules meant to last belong in CLAUDE.md. Users can give `/compact` a focus, or use `/rewind` to compact only part of the conversation.
- **Pi** compacts when the context crosses a threshold. It keeps roughly the most recent 20k tokens verbatim and has the model summarize everything older, passing in the previous summary as input to the new one. The original record stays in the JSONL session file; switching branches produces a separate branch summary; and extensions can take over the compaction process.
- **DeepSeek Harness** makes compaction a replaceable plugin interface. The default basic backend condenses the oldest stretch of history into a summary and keeps recent messages. It can trim oversized tool outputs first, and when the context overflows it compacts and retries. The event log is append-only, and compaction events are recorded in it as well. A separate experimental plugin, which has to be mounted explicitly, lets the model search the session and read exact events.

What they have in common: the working context holds **one** summary standing in for the past, and each compaction rewrites it on top of the previous one. For short sessions, that is the simplest design, and good enough.

Once sessions get long enough, this structure goes one of two ways. Either the old summary is compressed again every time, so the older an event, the more times it has been paraphrased, and detail erodes layer by layer. Or new summaries keep piling up until they fill the window again.

## The problem we ran into

Foxwarm moved away from a single summary early on and split the past into summary blocks (CTX-BLOCKs). Blocks have levels: each compaction produces a level-1 block, and several blocks of the same level merge into one block a level higher. The direction was right, but the early merge rules were rules of thumb, such as "the oldest 40% of each level may be merged."

A real Session that had been running for about six months exposed the problem. Its context had accumulated 70 summary blocks, about 50k tokens. From oldest to newest, their levels looked like this:

```
8 7 5 4 1 4 2 7 4 2 6 5 3 7 1 5 4 2 6 4 3 1 …
```

High and low levels were interleaved. Level-1 blocks from months earlier sat between level-4 and level-5 blocks, with no same-level neighbor left to merge with. A single level could grow without limit (this Session had 17 level-4 blocks). The newest level-1 summaries ran 7,000 to 12,000 characters each. Nothing constrained the total.

## What memory research says

Rather than keep tuning percentages, we first asked a different question: how much detail does a stretch of history deserve to keep?

Psychology and data structures give surprisingly consistent answers.

- **The chance of needing something decays as a power law.** Anderson and Schooler (1991) found that human forgetting curves match the statistics of the environment: the probability that a piece of information is needed again falls roughly as a power law of the time since it was last used. For an agent, the detail a stretch of history deserves should be roughly inversely proportional to its age.
- **The timeline should be logarithmic.** In Shankar and Howard's (2012) model of temporal context, the brain represents the past at a resolution inversely proportional to how long ago it was: one slot for the last minute, one for the last hour, one for the last day, so the number of slots grows only with the logarithm of time.
- **Algorithms already have this structure.** An exponential histogram (Datar et al., 2002) keeps at most k buckets at each scale. When a scale overflows, its two oldest buckets merge into one bucket at the next scale, so a stream of length N needs only O(k log N) buckets. LSM trees and Tower of Hanoi backup rotation follow the same idea.
- **Detail fades before gist.** Fuzzy-trace theory (Brainerd and Reyna) distinguishes verbatim memory from gist memory, and verbatim memory fades faster. So the higher a summary's level, the more it should keep only the gist, the decisions still in force and the unfinished work.
- **Stable knowledge moves out.** Complementary learning systems theory describes how episodic memory is gradually consolidated into semantic memory. In Foxwarm, the original messages and summary blocks are the episodes; Agent memory, Tasks and documents are the semantic store. A fact already written into memory or a Task needs only a pointer in a summary.
- **Forgotten means out of reach, not gone.** Tulving distinguished information that is available in memory from information that is accessible. Foxwarm's archive keeps every original message, and recall is retrieval by cue. So the real quantity to minimize is the tokens the working context occupies, plus, for each piece of content, the probability it is needed times the cost of retrieving it. Something rarely needed that can be retrieved at any time doesn't need to occupy the window.

In hindsight, the original "merge same-level blocks into the next level" was already a rough exponential histogram. It lacked three invariants: levels never increase from oldest to newest; each level has a cap on its number of blocks; and each block has a cap on its size.

## The rules in 0.9.5

So the rules became short.

- **Each compaction** writes a new level-1 block from the original messages after the newest summary block.
- **Each level holds at most 3 blocks.** When a level overflows, its two oldest blocks merge into one block at the next level, and the carry can ripple upward. From oldest to newest, levels only go down. A level-j block covers roughly 2^(j−1) compactions' worth of history.
- **The engine decides which merges happen; the model only writes the summaries.** The model used to choose from a range of candidates; now each compaction's operations are deterministic.
- **Every block has a budget.** A new level-1 block gets about 3,000 tokens and a merged block about 1,500 (both estimates). A summary well over budget goes back to the model to be shortened, at most twice. When the whole summary region exceeds 24,000 tokens, the oldest block absorbs its neighbors.
- **Recent original messages are kept by tokens**, 30% of the compaction threshold by default, not by message count. A count treats a 100-character notification and a 20,000-character tool output as equal.

Drawn out, the working context looks roughly like this:

```
[system prompt and memory] [L6][L5][L5][L4][L3][L3][L2][L2][L2][L1][L1][L1] [recent messages …]
                           ←── older, coarser ──────────── newer, finer ──→
```

Each doubling of the history adds about two blocks.

Before an automatic compaction starts, Foxwarm first tries a step that doesn't call the model: it trims oversized tool outputs from the history, and commits the result only if that frees enough space. Otherwise it goes on to the layered compaction above.

## What goes into a summary

Beyond the budget, what matters more is content. A merged summary is asked to read like a handover note: the current state, the decisions made and why (with original message numbers), unfinished work (with Task IDs), and the identifiers that matter. Intermediate debugging steps are the first to go. Anything already in Agent memory, a Task or a document gets only a pointer.

A few finer rules each came from a mistake on a real Session:

- A summary is written in the main language of its source messages, with code, identifiers and terms left as they are.
- While planning a summary, the model sees the **current** status of Tasks mentioned in the history (the status only, not titles or content), so a Task that has been completed doesn't keep being described as unfinished merge after merge.
- When blocks merge, the memory facts attached to the source blocks leave the working context with them. So a merged summary has to carry any decision that still matters in its own text, with its source, rather than saying "recorded elsewhere."

## The original words are always within reach

Compaction changes only the working context. It deletes nothing.

Every original message and every summary block is written to an immutable archive along with its lineage: which blocks a higher-level block was merged from, and which range of original messages it ultimately covers. So:

- **The model** can use the `recall` tool to read original text exactly, by block number (such as `B#126`) or message range (such as `msg#10637-10680`), or search the Session literally. With Vector enabled, it can also search by meaning; results are read back from the archive before they are shown. Exact reads don't depend on the embedding service.
- **People** can expand summary blocks level by level in the WebUI, all the way down to the original messages.
- During compaction, the model can mark individual messages to keep verbatim, such as an important error message. When the block holding such a message is merged later, the message leaves the working context but stays in the archive.

So in Foxwarm, forgetting means the working context holds the past at a lower resolution, not that the information is gone. A sentence the summary left out can be retrieved as soon as the model realizes it needs it.

## Testing on real data

Before changing the rules, we replayed the summary block structure of 222 real Sessions offline. The replay used only block levels, sizes, ranges and times, and read no message content.

Among the 41 Sessions with longer histories (at least 64 compactions):

| | Old rules | New rules |
|---|---|---|
| Summary blocks, median | 25–35 | 15 |
| Summary blocks, maximum | 72–75 | 25 |
| Summary region tokens, median | about 16–18k | about 8k |
| Share of its age covered by a two-week-old block | 3–8% | about 25% |

Both columns of the first three rows are simulated with the same replay model (the old-rule ranges reflect different merge tendencies of the model; the largest Session in the real snapshots had 102 blocks). The old-rule value in the last row comes from real snapshots.

The last row is about resolution. Under the old rules, history from two weeks ago was kept in too much detail. Under the new rules, each block covers about a quarter of its own age, however old it is, which is exactly the shape of a logarithmic timeline. For the 70-block Session above, the summary region, together with the retained messages between blocks, came to about 63k tokens; the simulation gives 21 blocks and about 17k tokens.

Some things didn't improve. Within the summary region, the share of the request prefix that can be reused unchanged after a compaction stays around 0.7 under both rule sets. A merge necessarily rewrites everything after its position. The new rules pay off in bounded size, not in caching.

Next, we copied 4 real Sessions and ran several rounds of real compaction in an isolated environment, using each Session's own model. For three medium-length Sessions, the summary region went from 15.0k, 17.1k and 17.3k tokens to 9.5k, 9.7k and 7.3k. The old 70-block Session migrates gradually, with at most 3 merges per compaction: after 3 rounds it had 51 blocks. By projection, it drops below 24k after another ten or so compactions and then settles at about 20 blocks and 19–23k.

More useful was checking how well the summaries were written. We compared each merge result with its sources, one by one, and found several problems:

- When merging, items that a source listed as still open at that point were dropped as history, even when they were still open today.
- Once the source blocks' memory facts were no longer repeated, the model wrote pointers such as "recorded in Agent memory" when nothing had been recorded.
- In a Session written mostly in Chinese, one round produced summaries entirely in English.
- Later results were occasionally written into an earlier merged block.

We adjusted the prompts and rules for the first three before release. In a second validation round, run after the first fix, the merged summaries generally kept unfinished items with their Task IDs and decisions with their message numbers. The prompt already explicitly forbade the last problem. The model still does it occasionally, but the effect is small.

One idea is on hold: keeping recently recalled blocks one level more detailed, similar to spaced repetition. No data yet shows it is worth it, so we'll collect statistics first.

## Trade-offs and limits

- Summaries are lossy. The model works from the summary, and when it needs the original words, it has to recall them itself. It doesn't automatically know what was left out.
- Each compaction costs an extra model call, and each merge rewrites the part of the summary region after it.
- Budgets are estimates, not hard limits. An existing Session takes several compactions to settle into the new shape.
- This isn't infinite context. It answers a narrower question: in a long-running Session, at what resolution should the past stay in the window?

If your sessions usually end within a few hours, a rolling summary is enough, and simpler. This structure starts to pay off once sessions are measured in weeks and the summaries themselves need managing.

## Try it

Starting with Foxwarm 0.9.5, new Sessions use these rules directly, and existing Sessions are reorganized gradually by later compactions. `/compact` starts one manually; `llm.compactThresholdPercent` and `llm.compactKeepPercent` adjust the trigger point and how much recent history is kept verbatim. See [Long conversations and history search](/docs/history-search/).

To see it first, open the [demo workspace](/demo/#session/tidepool%2Fsupport), which includes a compacted Session. Switch the timeline view to Grouped or Detailed to see the summary blocks and the two calls in which the model uses recall to retrieve the original text.

## References

- J. R. Anderson, L. J. Schooler. Reflections of the environment in memory. *Psychological Science*, 1991.
- K. H. Shankar, M. W. Howard. A scale-invariant internal representation of time. *Neural Computation*, 2012.
- M. Datar, A. Gionis, P. Indyk, R. Motwani. Maintaining stream statistics over sliding windows. *SIAM Journal on Computing*, 2002.
- C. J. Brainerd, V. F. Reyna. Fuzzy-trace theory (verbatim and gist traces).
- J. L. McClelland, B. L. McNaughton, R. C. O'Reilly. Why there are complementary learning systems in the hippocampus and neocortex. *Psychological Review*, 1995.
- E. Tulving, Z. Pearlstone. Availability versus accessibility of information in memory for words. *Journal of Verbal Learning and Verbal Behavior*, 1966.
- Claude Code documentation: [Context window](https://code.claude.com/docs/en/context-window), [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works) (read November 2026, v2.1.325).
- Pi documentation: [Compaction](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/compaction.md), [Sessions](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/sessions.md) (earendil-works/pi, read November 2026, v1.5.2).
- DeepSeek Harness documentation: [Compaction subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/docs/subsystems/compaction.md), [compaction-basic](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/compaction/compaction-basic/README.md), [tool-session-query](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/experimental/tool-session-query/README.md) (dsh-v0.2.2-rc.3).
- Foxwarm: [0.9.5 release notes](https://github.com/550W-HOST/foxwarm/blob/main/docs/release-notes/v0.9.5.md); Code Index [`threads/context-compaction.md`](https://github.com/550W-HOST/foxwarm/blob/main/docs/code-index/threads/context-compaction.md) ([D-context-log-retention](https://github.com/550W-HOST/foxwarm/blob/main/docs/code-index/threads/context-compaction.md#d-context-log-retention)), [`threads/archive-and-recall.md`](https://github.com/550W-HOST/foxwarm/blob/main/docs/code-index/threads/archive-and-recall.md).
