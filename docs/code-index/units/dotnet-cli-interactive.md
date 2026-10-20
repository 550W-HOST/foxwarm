# Unit: Native CLI interactive entry

Files: `dotnet/Foxwarm.CliNode/ConsoleNode.cs`, `dotnet/Foxwarm.CliNode/InteractiveNode.cs`, `dotnet/Foxwarm.CliNode/NodeApproval.cs`, `dotnet/Foxwarm.Tests/Tools/CliNodeInteractiveTests.cs`, `packages/webui/test/cliNodeConsoleFixture.mjs`, `packages/webui/test/dotnetCliNodeInteractive.e2e.mjs`, `packages/webui/test/dotnetCliNodeInteractiveMain.e2e.mjs`

## Purpose and integration

The explicit `--interactive` branch of the [.NET CLI executable](./dotnet-cli-node.md) uses its actual `NodeClient` for pairing/status, bound Session list/history/send and ordinary model-tool approval. It has no Main executable reference, UI package, Node helper or remote-PTY-service prerequisite. The native default remains headless; TypeScript bins/bootstrap and Main TUI are unchanged.

Main remains the Session admission/history/assignment owner. The UI directly calls `ListBoundSessions`, `GetSessionHistory(id,30)` and `SendSessionMessage`; success means accepted ingress, not completed model work. Sends capture the selected ID and original trimmed draft, clear it before the request, and never replay or restore failed sends. No Session creation, assignment authority, outbox or persistent approval is added.

## Stable symbols

| Symbol | Responsibility |
|---|---|
| `ConsoleNode.Run`, `Draw`, `Text` | BCL input/render loop, changed-console-state cleanup and escaped, surrogate-safe terminal text. |
| `InteractiveNode.Status`, `Refresh`, `RefreshLoop`, `RefreshOnce` | Status, coalesced three-second/explicit refresh and exact current selection/connection response checks. |
| `InteractiveNode.Input`, `Send`, `View` | Draft/navigation/decision intent, captured send target and bounded visible list/history. |
| `InteractiveNode.Intercept`, `Decide`, `Dispose` | Live policy, one manual slot, deadline/cancellation identity and shutdown settlement. |
| `NodeClient.Approve`, `NodeToolCall`, `ToolApproval` | Optional ordinary-call interceptor and independent cancellation race before effect. |

The existing Program/client/capability/external/exec partials are integration references owned by the CLI Node unit. Early helper dispatch still precedes argument parsing and the interactive branch.

## Approval and lifetime

Only ordinary Session `tool_call` reaches approval, before lookup/effect. Fixed services, transfers, triggers and client RPCs bypass it. Installing the interceptor suppresses external-owner advertisement and rejects external tool calls even under auto-all; headless external behavior is unchanged.

Auto-all or a matching tool-name pattern admits future calls without consuming the manual slot. A changes only future policy, never the displayed request. A further manual call receives a definite busy rejection; there is no FIFO or hidden displaced wait. The pending record retains its originating request and completion. Its own decision, timeout, cancellation, connection loss or shutdown clears only that record.

Approval uses the nonzero server timeout first, otherwise CLI `--timeout` seconds, with `max(1000,effectiveMilliseconds-2000)` for positive effective deadlines and no timer otherwise. It is not an override of the server deadline and is separate from exec's foreground wait. Rejection/expiry/cancellation cannot authorize launch. The client races even an uncooperative interceptor against the exact pre-registered exec Stop and originating connection lifetime, checks cancellation again after approval, and retains the final adjacent native-launch fence. Disconnect/shutdown only settle not-yet-approved requests; already-approved effects retain their original execution lifetime and replies. Stop after launch still ends the foreground wait without killing independent work.

## Design decisions

### D-native-cli-console-scope

Confirmed October 20, 2026: the small CLI-owned controller intentionally retains selection by Session ID across refresh/reorder, keeps an eight-row window containing later selections, and rejects stale history responses by selection and connection identity. History requests retain 30 messages; the display uses the last twelve, bounded message/argument previews and a separate original draft payload.

The pattern option is explicitly an interpreted BCL `ECMAScript | IgnoreCase | CultureInvariant` regular expression over tool names only. Empty means manual and invalid syntax fails startup. It is not arbitrary JavaScript RegExp equivalence: Unicode property patterns and inline option groups can differ. No compiled engine, regex timeout policy or match-all fallback is added.

Input drains currently available `Console.ReadKey` values into text-versus-single-key events, not an arbitrary debounce or a promise of atomic paste transactions. A text batch cannot become per-character quit/send/approval shortcuts. Draft deletion uses Unicode text elements and display clipping never splits a surrogate pair. Terminal payload controls are escaped; original message/argument values are not rewritten. The adapter does not add a clipboard, cursor editor, terminal-cell-width engine or raw-terminal framework. Console input is required; output redirection is not categorically forbidden. Console modes and encodings actually changed are restored, without introducing an alternate screen or hidden cursor.

## Tests and qualification boundaries

The PTY fixture drives the real entry, with captured wire RPCs, file/process effects and shell-mode comparisons. Protocol fixtures own the short/no-timeout, out-of-order history, reorder/removal, cancellation, reconnect, busy-slot and policy cases. The normal Source/C# Main fixture owns actual pairing/status, list/history/send admission, model-driven decisions, Main Stop before/after launch, completion ACK and one normal server-derived approval expiry. Focused client tests also retain the ignored-interceptor cancellation and final native-prelaunch fence.

The expanded Linux x64 Native AOT console has actual PTY coverage of direct list/history/send, manual/pattern/all/cancel paths and shell restoration in a no-CLR Linux environment, including operation without the optional remote terminal library. It remains dynamically linked. A headless trigger run alone does not qualify the interactive APIs. Console/no-CLR evidence is separate from the [browser adapter's host qualification and visible upstream diagnostics](./dotnet-cli-browser.md). No Windows console, static-link, Main TUI, packaging/default-entry or container-browser qualification is implied.
