# Unit: Automatic Session titles

Files: `dotnet/Foxwarm/Sessions/SessionAutoTitle.cs`, `dotnet/Foxwarm/Sessions/SessionManager.AutoTitle.cs`

Secondary files: `dotnet/Foxwarm.Tests/Sessions/SessionAutoTitleTests.cs`

## Contract

**User decision (2026-11-03): an unnamed Session receives a generated display name after its first completed user turn.** Main makes one short background model request from the first user message and the assistant reply and stores the result as the Session's display name. The request has no tools, does not use the Agent's memory or prompt, and is not recorded in Session history or model context. A display name set by the user, an Agent, Session creation or Agent creation is never replaced. The rejected alternative was asking the Agent to set its own name with a tool, which costs an extra tool round in the conversation and is unreliable. Expected cost is one short request per new Session.

- **Which Sessions qualify.** The Session has no display name, uses the Foxwarm runtime, and its first input row is a direct user message: the `<foxwarm-message type="channel">` wrapper that WebUI and external channels add. Children and other Sessions whose first input is an Agent handoff, Task message, timer, inter-Session message, MCP external input, event or unwrapped internal submission (such as a fork's initial message) are not titled even when unnamed: Agents already name the children they create, and the first exchange there is not a user request. Claude Code runtime Sessions are excluded because their selection is not a Foxwarm catalog model.
- **First completed turn.** The completed turn qualifies when the first model-visible assistant text after that first input was committed by this turn (its seq is at or after the turn-start seq recorded in `OnTurnStarting`). Rows before the first input, such as a prepared greeting assistant message, are ignored, so the default greeting Session is titled after the user's first turn like any other unnamed Session. Turns that failed earlier without assistant text do not disqualify a later first completion; a turn ending without assistant text (for example a wait) leaves the decision for the next completion. Once a Session has earlier assistant text, it never qualifies, so existing unnamed Sessions are not retitled after an upgrade.
- **Request.** It reuses the existing `background` purpose (`ConfiguredModelRequests` suppresses configured hosted search and image tools for it) through `ModelRequestOwner` with the Session's selected model or the catalog default, `low` effort when the selected model supports it, no tool definitions, fixed title instructions and one user message containing the clipped first user text and reply. Normal LLM request journaling applies under the Session ID. It makes a single provider attempt (`maxAttempts: 1`), has a two-minute local timeout, and is cancelled by Main shutdown.
- **Never blocks or repeats.** The completion callback decides synchronously from the committed snapshot and starts the request detached, joined to the manager's accepted-operation lifetime. Each owner lifetime attempts at most once; failures, empty output and shutdown are silent apart from journaling and a trace warning. They do not add notices, failure counts, retries or later attempts.
- **Commit.** The model text is reduced to one line, stripped of quotes, markdown markers, `Title:` prefixes and ending punctuation, and limited to 40 display columns with East Asian wide characters counted as two (truncated with an ellipsis). `SessionManager.RenameIfUnnamed` resolves the current canonical ID after the request and calls `SessionCatalog.RenameIfUnnamed`, which checks and writes under the catalog gate. A name set while the request was in flight therefore wins. The write then follows the ordinary rename publication: catalog `Changed` and the live owner's state change, so WebUI lists and Chats update without reload. A deleted Session is skipped.
- **Configuration.** No switch exists. The feature follows the existing model configuration; a Session that should keep its ID as its label can still be renamed or cleared manually, and a cleared label is not regenerated because the Session no longer qualifies.

## Stable methods and callers

`SessionManager.CreateOwner` calls `AutoTitleTurnStarting` from `OnTurnStarting` and `StartAutoTitle` from `OnTurnCompleted` (Foxwarm runtime only, before automatic compaction maintenance). `SessionAutoTitle.Select`, `Normalize`, `RequestMessage` and `AssistantText` are pure helpers. `SessionOwner.AutoTitle` holds the per-owner turn-start seq, the settled flag and the detached task for test observation.

## Open Questions

- A user who sets a label and clears it again while the title request is in flight receives the generated title, because the catalog keeps no record of an explicit clear.

## Tests

`SessionManager.AutoTitles` is an internal test seam, not configuration. `ExternalChannelFixture` and the awaited-compact admission test turn it off because they script exact provider request sequences; ordinary managers keep it on.

`SessionAutoTitleTests` covers normalization and width limits, qualification (prepared greeting, earlier failed turn, later turns, Task handoff and external input, wait without text), and real loopback-provider turns through `SessionManager`: the title request's instructions, empty tools and exchange text; the label in catalog/metadata and a state-change event; unchanged history; one `background` journal manifest; no request for named Sessions; a user rename during the request; and a silent single failed attempt that is not retried on the next turn.
