# Thread: Context, Archive, and compaction

## Producer to consumer path

```text
SessionOwner active JSON/history + AgentMemory selection
  -> SessionCompactor plan/candidate selection
  -> SessionSaveLane.CommitCompactionAsync
  -> Archive blocks/messages/lineage (immutable)
  -> atomic active Session JSON/history publication
  -> next SessionChatService prompt or Archive recall/context tools
```

- **Producer:** `SessionOwner` and `ContextPreviewRenderer` provide the current active history, Agent/conditional memory, prompt budget, and candidate ranges. `ArchiveControlTools`/manual compact routes request a plan; they do not write Archive directly.
- **Owner:** `SessionCompactor` validates/repairs plans; `SessionSaveLane` serializes the compaction safe point; `PersistentSessionAuthorityStore.CommitCompactionAsync` owns Archive-first plus JSON publication ordering.
- **Durable boundary:** `SqliteArchiveMessageStore`, `SqliteArchiveBlocks`, and branch/reservation stores write immutable message/block/lineage records. `LinuxAtomicJsonFile` publishes the replacement active JSON history. Archive is not a rebuild source for missing active JSON.
- **Consumers:** next-turn `ConcreteRequestHistory`/`SessionChatService`, `ArchiveContextReader`, `ArchiveRecallTool`, WebUI history/context views, and bounded prompt-preview endpoints.

## Active history versus immutable Archive

Per-Session JSON/history is the only active source used to construct the next live prompt. Compaction may replace or prune that active history and queue-related prompt state. It does not delete/rewrite immutable Archive rows, and Archive readers do not rebuild a missing JSON authority. `ArchiveContextReader` applies cumulative branch/fork caps so parent rows beyond the child fork point cannot leak into effective context.

## Commit ordering and errors

`CompactPlan`/repair helpers validate candidate ranges and data budget before admission. `CommitCompactionAsync` writes exact block/message rows first, writes active JSON second, rolls back only rows inserted by the failed pre-rename attempt, and raises `AuthorityCommittedException` after rename. A cancelled/failed plan leaves the prior active history unless the JSON rename already happened. Ready/standalone compact wake state is a save-lane marker, not a new history authority.

## Memory and compatibility

`ConditionalMemory` and `AgentMemory.Selected` influence prompt construction but do not mutate active history. Vector admission/search is not part of the current .NET chain: `WebUIChannel.History` returns `VECTOR_DISABLED`, and identity/configuration paths do not imply Vector runtime support. TypeScript archive/vector readers remain compatibility references only.

## Canonical units and tests

- [Compaction unit](../units/session-compaction.md)
- [Archive message store](../units/archive-message-store.md)
- [Archive branches/lineage](../units/archive-branch-lineage.md)
- [Session authority JSON](../units/session-authority-json.md)
- `CompactLifecycleTests`, `CommittedArchiveBoundaryTests`, `ArchiveLineageTests`, `SelectedPromptTests`, and message JSON tests.
