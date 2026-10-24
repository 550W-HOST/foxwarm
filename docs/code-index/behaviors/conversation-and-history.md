# Behavior: conversation and history

For developers and Agents changing history, working instructions, or Chat. This page owns the observable distinction between the current conversation, model context, historical originals, and durable Agent memory, including when instruction changes reach the model. It is not a transcript format specification. [Sessions and Agents](sessions-and-agents.md) owns choosing, creating, and reorganizing the lifetime that uses this context.

## Four things that are not interchangeable

| Surface | What it represents | What reading it changes |
| --- | --- | --- |
| Active history | The Session's current ordered messages, including retained raw rows, CTX summaries, and display-only notices. Model requests use its model-visible content, together with the system prompt and other request inputs. | Inspection does not restore older originals into context. |
| Chat in Conversation view | A readable, active-backed projection: current ordinary rows plus originals represented by surviving CTX blocks, within the loaded history. | Loading, scrolling, and expanding Activity change presentation, not active history. |
| Archive / independent History viewer | Immutable originals and block records, with effective alias and fork lineage. They remain available after active deletion or clear. | Browser inspection is read-only. Agent recall returns selected evidence as a tool result; it does not restore the archived rows as active messages. |
| Agent memory | Files selected for the Session's system-prompt snapshot, potentially inherited from other Agents. This is durable guidance, not a second conversation log. | Reading a file, changing it, and [adopting changed instructions](#when-do-changed-instructions-reach-the-model) are different actions. |

Active history is not the entire provider request, and not every active row is model-visible. Display-only notices can be visible to a human without entering provider replay, compaction summaries, or embeddings. Temporary streams, optimistic sends, and queued previews are not committed history; [messages and turns](./messages-and-turns.md) owns when admitted input becomes canonical and can affect a request.

Archive is not a fallback for repairing active history. Compaction summarizes the active payload, including already-pruned tool results or edited wording, rather than silently substituting the original bytes. Technical authority and fail-closed persistence rules remain in [active-history authority](../threads/context-compaction-and-recall.md#d-context-active-history-authority).

## Which instructions are in the working context?

A memory-backed Session uses a retained system-prompt snapshot, not a fresh scan of every instruction file on every request. Its selected memory sources, skill catalog, and ordinary loaded tool results have different lifetimes:

| Source/action | What the model can receive | What it does not do |
| --- | --- | --- |
| Default memory selection | Framework guidance followed by inherited/current Agent memory, with applicable Session/model filtering. | Does not insert another Agent's conversation or copy its whole workspace. |
| Explicit `systemPromptFiles` | Replaces default memory-file selection in listed order. An explicit empty list selects no memory files; omission keeps defaults. Catalog and generated directory/recall guidance remain. | Not an extra-file append to default memory, or a bypass of target-Agent path restrictions. |
| Skill catalog in the snapshot | Names, descriptions, and winning sources so the Agent can choose relevant instructions. | Not the full skill bodies, an eager read of resources, or a grant of tool capabilities. |
| `skill` with `action: "load"` | The resolved entry document and a bounded listing of supporting resource paths, through the ordinary tool-result path. | Does not automatically load those resources or attach the full skill permanently to every future prompt. |
| Read a resource or historical evidence | The selected content returned by that authorized operation. | Not a memory-file write or reinsertion of archived messages into active history. |

Ongoing Agent inheritance selects reusable sources for later snapshots. One-time memory copying initializes independent files and does not keep them synchronized. Ongoing inheritance rejects self/cyclic relationships and isolated source Agents; copying is a separate choice, not an implicit inheritance relationship or permission grant. Skill resolution uses local over inherited over global sources, with the first matching name winning. A directory containing `SKILL.md` is a skill boundary; nested documents are resources, not automatically additional catalog entries. Exact source order, filtering, and resource bounds remain in [prompt assembly](../units/src-session-prompt.md#source-assembly) and [skills](../units/src-skills.md#behavior).

### When do changed instructions reach the model?

[2026-09-08; selective inheritance refresh clarified 2026-09-09] A file edit, knowledge of that edit in the current conversation, and rebuilding the system-prompt prefix are distinct effects. Rebuilding needlessly can lose prompt-cache reuse. Ordinary edits therefore do not require an immediate snapshot refresh: current edit context can already convey the change; another Session can receive a concise change message. Use an authorized explicit target refresh when its prompt must be rebuilt now, for a snapshot test, or when explicitly requested.

| Supported change or boundary | Adoption consequence |
| --- | --- |
| Edit a memory file or add/change a skill | Does not watch/rewrite every retained snapshot. A direct skill load reads current resolved instructions; a retained catalog may still reflect its earlier snapshot. |
| `refresh_session_snapshot`, optionally naming an existing target | Rebuilds that target's snapshot without an inactivity gate. Omission selects the caller; this is not an all-Agent refresh or creation of a missing Session. |
| Change Agent inheritance | Metadata-only by default. Opted-in `refreshSnapshots` rebuilds the Agent's and transitive inheritors' recently active snapshots; those idle for more than one hour are left for normal next-turn refresh. Isolation changes retain their separate affected-Session/Node update behavior. |
| Start a turn after more than one hour since the last message | Attempts a snapshot refresh. This is last-activity age, not snapshot age; a recent explicit refresh does not change that activity test. Failure on this best-effort path logs and continues. |
| Prepare an attempt for a different concrete model identity | Rebuilds the model-appropriate snapshot before send. A matching recorded identity reuses retained bytes without rereading files. A required authoritative rebuild must persist successfully before send. |
| Commit compaction | Retains its existing memory reread boundary when a truthful snapshot identity exists. It does not copy the detached planner's prompt over the live owner. |

Fresh concrete Sessions can materialize immediately. A never-run virtual selection has no actual concrete identity yet and defers materialization until leaf selection. Forks retain the copied snapshot until actual-use correction; explicit/lifecycle refresh reuses a recorded concrete identity rather than inventing a virtual leaf. The first-line matching, detached ownership, target path checks, and persistence boundaries remain at [conditional snapshots](../threads/conditional-memory-snapshots.md).

Refreshing available instructions does not retarget an already-dispatched provider request or rewrite old messages. Model-setting adoption is separately owned by [models and requests](models-and-requests.md#switching-takes-effect-at-an-adoption-boundary). An identity/Agent move is not by itself a snapshot refresh; [lifetime changes](sessions-and-agents.md#change-a-label-an-identity-or-a-relationship) retain that distinction.

## Source selection and display are independent

The source/render split established on 2026-10-17 maps the current Chat setting as follows:

| Timeline view | Selected history source | Visible treatment of compacted history |
| --- | --- | --- |
| Detailed | Active | CTX cards; expand one layer at a time. |
| Grouped | Active | The same active source, with technical grouping and disclosure. |
| Conversation | Continuous, projected through active authority | Original represented messages without generated CTX summary cards or recursive block disclosures. |

Internally `historyMode` selects the data source and `timelineView` selects rendering. Keep them decoupled so changing a renderer does not implicitly change retrieval; there is no separate user-facing history-source switch today.

Conversation normally leaves ordinary assistant text visible and collapses technical work into Activity. Commentary and inter-agent-message preferences can change what is folded. Those render-only details, Search disclosure, and per-request statistics belong to the [Timeline contract](../modules/webui-timeline.md#d-webui-timeline-view); they do not change which history is authoritative. An expanded Activity is not proof that the current turn completed.

## Conversation is an active-backed projection

The projection contract clarified on 2026-10-21 follows representation, not the smallest or largest retained sequence number:

1. A retained ordinary active row supplies its current payload, overriding the loaded Archive original of the same sequence once.
2. A raw row absent from active history can appear only if a surviving CTX represents it.
3. A message-backed CTX represents its recorded raw members. A higher-level CTX represents the actual members of its children, recursively, not every sequence inside its broad minimum/maximum envelope. Gaps between children remain gaps.
4. Removing one representation does not remove another surviving representation of the same original.

This makes current deletion and pruning visible while preserving continuous reading across compaction. It does not require Archive deletion or persistent per-message exclusion records.

### Actions and consequences

`/delete-messages N` removes up to N entries from the beginning of active history; a negative N removes that many from its end. Counts are active entries, not rendered bubbles, original Archive rows, or CTX descendants. A CTX is one active entry. The command is not permanent erasure of historical originals.

A clear request against a busy Session can request interruption and return `cleared:false` with a retry requirement instead of completing the reset below. Main-local preparation can drop queued input before that retry; Worker preparation has its own owner boundary. Neither a stop acknowledgement nor dropped input proves active history was cleared. The command reports the actual outcome; [runtime history mutation](../units/src-session-runtime.md) locates these paths.

| Action | Active/model-context consequence | Conversation consequence | Archive consequence |
| --- | --- | --- | --- |
| Prune a retained tool result | The active result becomes the bounded/pruned payload. | Shows that active payload, not the old full result. | Original remains independently inspectable. |
| Compact a range | Summaries replace selected active entries; explicitly preserved raw rows may remain. | Shows loaded originals represented by surviving summaries, with retained raw overrides. | Original messages and generated block records remain traceable. |
| Delete an ordinary active row with no surviving CTX representation | Removes that current entry. | The row disappears, including after reload or paging. | Original remains. |
| Delete a separately preserved row still represented by a CTX | Removes the independent current entry/override. | The original can still appear through that CTX. | Original remains; no exclusion is written. |
| Delete a CTX | Removes that summary from current context. | Its originals disappear unless another surviving CTX or ordinary active row still represents them. | Block and original records remain. |
| Successful `/session clear` | Clears active history and queued input, removes the armed wait, discards pending compact work, and rotates prompt-cache lineage. It is not Agent-memory deletion. | Becomes empty; later input starts a new visible conversation. Reload does not reconnect the old conversation. | Originals remain available through independent History/recall. Block identities are not reused. |

For example, suppose active history is `CTX A (raw 1–4), retained raw 3, raw 5`. Conversation displays represented originals 1–4 with current raw 3 replacing its original, followed by raw 5, when those rows are loaded. `/delete-messages -2` leaves only CTX A: raw 5 disappears, but original raw 3 is still represented by A. Deleting A as well empties this conversation without deleting the Archive.

Compaction replaces selected older context, retaining the compatible recent tail and concurrently appended suffix. Display-only notices retained in that suffix stay visible without becoming provider input. Quoting a lifecycle marker inside ordinary content does not turn that content into a lifecycle event. Completion identifies the Session's actual parent and names recognized skill loads consumed with the old context, so the Agent can reload instructions still needed; it does not reload skills automatically. The [compaction owner](../threads/context-compaction.md#d-context-compact-completion) owns marker recognition and skill-load forms, while [snapshot refresh](../threads/conditional-memory-snapshots.md#lifecycle-refresh) remains separate.

History mutation remains subject to existing command/access authorization and exact-Session ownership. These actions are not Session deletion. [Retiring a lifetime](sessions-and-agents.md#put-work-aside-clear-the-conversation-or-retire-the-lifetime) is separate from clearing it, archiving its list entry, or closing Chat. Successful deletion does not recreate an empty live Session through an old alias; exact retained identity and fork lineage rules remain in [Session lifecycle](../threads/session-lifecycle.md#archive-and-deletion).

## Historical reading is bounded and has a different scope from context

Conversation starts with a recent page, not a whole-Archive scan. Earlier/later requests return at most 100 raw records each. Chat mounts a moving window normally containing 200 source messages, preserving the reader and nearby surfaces; a large folded process can require a larger protected source extent. A cached or searchable loaded message need not currently have mounted DOM.

Scrolling loads history on demand. Returning to latest across an unloaded gap fetches a recent page rather than draining the missing interval. Reading positions are independent for active and continuous history and retained in memory across Chat remounts; restoring a continuous anchor uses bounded neighboring pages, not persisted page copies. Loading older rows or receiving a delayed page must preserve the reader's current position, not an obsolete request-time position. Failed history or CTX-membership reads expose Retry; they must not guess membership or resurrect rows from incomplete active authority. The synchronization and viewport mechanisms are in [continuous retrieval](../threads/archive-and-recall.md#d-webui-continuous-chat-history) and [Chat](../units/webui-chat.md#viewport-behavior).

### Search, recall, and statistics

- **Find in chat** searches already-loaded committed text under the selected projection. It does not fetch older pages or expand CTX to find more matches. Conversation excludes manually expanded Activity and nested historical detail from this corpus; Detailed/Grouped retain technical-text Search. Exact disclosure/highlighting behavior stays in [pane-local Search](../modules/webui-timeline.md#d-webui-chat-session-search).
- **Independent History** browses Archive outside the current conversation. Its semantic search requires Vector; exact and adjacent historical reads remain available without Vector. It does not invoke a model or create a Session. Retaining Archive does not widen runtime-Agent access: an isolated caller's Archive inspection remains limited to its own Agent, including after active clear or live Session deletion. Administrator viewer access is separate, not a runtime grant. Actual retained-target membership and absent-target resolution remain at the [Archive access guard](../units/src-isolated-check.md#behavior).
- **Agent historical tools** distinguish `view_session` live reading from `recall` Archive evidence. Live reading defaults to the newest 10 eligible source records, including count-only calls. Structural `parts` projection happens before counting records; literal/regex filters narrow that selected page, so an empty filtered page does not establish absence elsewhere. Canonical seq/time and CTX block identities locate content; raw active indices and `historyVersion` support forward/backward navigation. Default tool summaries count logical calls once and correlate results for errors, without generated call-ID labels. Exact Archive drill-down identifies folded/truncated material and can differ from the current pruned payload. `recall.text_query` performs a bounded case-insensitive literal lookup in one Session without Vector, reports examined seq extent and an older continuation, and does not claim whole-history absence from an unfinished empty range. Exact `target` and semantic `vector_query` remain separate modes. See [recall mechanisms](../units/session-compaction.md#recall-and-lineage-contract).
- **Reading is not reinsertion.** UI reads change no model context. Recall contributes its returned evidence through the ordinary tool-result path, not by replacing the active timeline with old rows; it is not a memory-file write.
- **Current-context accounting** continues to use active messages. Continue availability, current retry/error authority, Debug and ASR context also use active state, not the continuous display cache. A minimap can navigate loaded displayed history while its usage total still describes current context. Activity tokens describe recorded requests in that display range, not an expanded current-context budget; missing usage is not estimated as zero. Detailed accounting belongs to [Timeline usage](../modules/webui-timeline.md#d-webui-timeline-view).

Continuous pages reuse current Session/alias/access-identity authorization and effective fork caps. Historical images require proof in the specific accessible Archive message; having a blob ID does not grant arbitrary image access. Forked Sessions cannot read their parent's post-fork archive through inherited lineage. Storage, image signatures, and paging-frontier invariants remain in [archive and recall](../threads/archive-and-recall.md) and [image lifecycle](../threads/image-blob-lifecycle.md).

## Change and test entry points

- `src/session/promptSnapshot.ts`, `src/session/agentSettings.ts`, `src/session/snapshotRefresh.ts`, and `src/toolsSessionAgent/skills.ts` connect source selection, catalog/load, and refresh to actual requests. `src/session/sessionSystemPromptFiles.test.ts`, `src/skillCatalogSnapshot.test.ts`, `src/session/sessionSnapshotAutoRefresh.test.ts`, and `src/conditionalMemoryRuntime.test.ts` cover those distinct consumers, including concrete snapshot reuse and required-persistence failure.
- [History/compaction flow](../threads/context-compaction-and-recall.md), [history mutation unit](../units/src-session-history.md), and [Archive retrieval](../threads/archive-and-recall.md) locate the backend owners.
- [Chat synchronization and viewport](../units/webui-chat.md) and [Timeline](../modules/webui-timeline.md) locate the separate source and renderer responsibilities.
- `packages/webui/test/continuousHistory.test.mjs` covers projection, preserved-row overrides, and true CTX membership; `test/app-e2e/conversationHistory.e2e.mjs` covers the real command-to-Chat path, paging, clear/delete, and reading-position behavior.
- `src/channels/webuiContinuousHistory.test.ts` covers bounded route reads, access, aliases/fork caps, and historical image access. `src/session/historyCompactPlanRetry.test.ts` covers active-authoritative compaction, clear, and block-ID continuity. Use these entry points for the relevant behavior regressions.
