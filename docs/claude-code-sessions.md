# Claude Code Sessions

A Session can use either Foxwarm's model loop or the installed Claude Code CLI. Select `runtime: "claude-code"` when creating a Session through `create_session`, `create_child_session`, or the WebUI creation dialog. Omission selects `foxwarm`, including children created by a Claude Code Session. The runtime cannot be changed after creation.

Claude Code Sessions remain ordinary internal Sessions: Main owns their queue, history, Agent membership, tool attribution, reporting receipts, and lifecycle. Claude Code owns the model loop, account authentication, model selection, and its local transcript. Foxwarm does not supply a model name, API key, subscription credentials, or an LLM proxy to the CLI.

## Trusted installation prerequisites

The current launcher requires Linux, `setsid`, and an installed `claude` executable supporting the streaming flags used by `ClaudeSessionDriver.Command`. It runs on Main, even when business tools target a remote Node. Its host account, executable, and effective administrator-controlled configuration are trusted prerequisites. This hosting mode is not an OS or account sandbox.

Foxwarm launches with native tools removed, a strict single-server MCP configuration, disabled slash commands, and a run-owned settings overlay. That overlay disables hooks only within Claude Code's documented user/project/local/plugin scope. Administrator-managed hooks and force-enabled managed plugin hooks can remain active. Configured automatic effects outside the bridge are not controlled by Foxwarm tool policy. Foxwarm does not modify administrator policy or replace the account's authentication directory.

The driver refuses observable initialization mismatches in the tool set, connected MCP servers, plugins, and permission mode. Successful initialization does not prove that no managed hooks ran: initialization occurs after startup and does not include an effective managed-policy inventory. Qualify the intended installation and account before enabling this runtime. Automated regression tests use a controlled NDJSON process and real MCP SDK clients; they do not exercise a Claude model or subscription account.

## Configuration

The optional startup configuration section is:

```yaml
claudeCode:
  executable: claude
  # workingDirectory: /srv/foxwarm/claude-work
  credentialLifetimeSeconds: 3600
```

`executable` is a trusted executable name or path on Main. `workingDirectory`, when supplied, is an absolute Main-local directory. Otherwise each new external context starts in its owning Agent's Main directory. These settings take effect when Main starts. They do not select a Claude model or authentication method.

The working directory is independent of the Session's business-tool Node and tool working directory. An existing external context keeps its recorded CLI working directory and transcript reference across identity moves and restarts. The transcript must remain available on Main under the CLI account's configuration directory. Changing the business-tool Node does not transfer a Claude process or transcript.

## Input, history, and tools

Main commits one queued input unit before starting one CLI invocation. Input arriving while Claude runs stays in Main's queue until that invocation finishes. Later invocations resume the recorded external Session ID and send only unsubmitted Main input; Main does not replay its complete history into a second model loop.

The instruction snapshot does not stamp a Foxwarm current-model identity. Creation has no observed CLI model yet; a later explicit snapshot refresh can filter model-conditional memory using the last observed CLI model. The CLI receives the Session's committed instruction snapshot and communicates with a dedicated runtime MCP endpoint. That endpoint exposes the canonical `search_tools` and `call_tool` wrappers. Its ephemeral credential binds one internal owner and run; tool arguments cannot select the caller's Session or Agent. The credential renews while that exact run is current, and expires by default after one hour without renewal. Ordinary inbound MCP identities cannot use this endpoint or acquire internal Session authority.

Concrete calls use normal tool resolution, current Agent/ancestor policy, Node authorization, output guards, image handling, canonical call/result history, and reporting receipts. Authorization and runtime support are checked before concrete effects, including calls resolved from `argsJson`. CLI tool-use/result echoes are observations; they never execute the same business call again. Claude Code's `EndConversation` control may appear in its reported native tool set; it is not a Foxwarm business tool.

Full assistant messages and already observed partial text on interruption are committed to Main history. Streaming drafts are transient. Runtime streams do not create Foxwarm LLM journal requests. CLI compaction is recorded as an observation without changing Main's history version or Archive contents.

Usage comes from the latest completed CLI result, separately labeled `claude-code`. The CLI's cost is an estimate and may already be cumulative across resumes. Foxwarm preserves that reported estimate instead of adding it repeatedly to its API-model cost totals.

## Stop, failures, recovery, and Clear

Stop fences runtime tool admission before cancelling the CLI. The processor joins already admitted tool settlement, interrupts the owned process group, escalates to termination when needed, removes the temporary credential files, and releases the foreground owner before another run starts. Identity moves, deletion, failure, and Main shutdown also revoke the run's credentials. Independent Main-owned background Exec and ToolScript work keeps its existing lifecycle.

Main records the input frontier before writing the input to the CLI. If delivery or the result acknowledgement is lost, that input is not replayed automatically. A known failure before input submission retains the previous context/frontier so an explicit retry can use the unsent Main input. A failed or interrupted run retains its external checkpoint and any canonical tool effects already committed. Startup recovery keeps a valid pre-first-launch checkpoint new and marks an initialized unfinished run interrupted. Both wait for explicit continuation without a synthetic replay trigger. Known queued input remains available through Continue.

Continue is an explicit subsequent input into the existing Claude conversation, or sends known unsubmitted Main input. It never resubmits an unknown-outcome input. A missing transcript is an error: restore the recorded Main-local transcript or Clear the Session. The driver does not silently start a fresh Claude conversation and replay old work.

Clear uses the normal stop/drain/retry lifecycle and starts a new external context. It discards the Session's external checkpoint along with its Main history; it does not delete the CLI account's transcript files. Authority files for Claude Code Sessions use Session state version 2. Foxwarm Sessions continue to use version 1. Earlier readers that support only version 1 refuse external authority rather than treating it as a Foxwarm-model Session.

## Unsupported operations

Claude Code Sessions reject Foxwarm context compaction, model/effort changes for the current Session, BTW side requests, forks, and cross-Node external-process resume. The bridge also refuses `wait`, ToolScript run/resume controls, response-wide batch cancellation, `afterSend: wait/finish`, and current-Session identity/Stop controls whose semantics require the Foxwarm model batch owner. Supported sends use `afterSend: continue` or omit that field. External child creation and missing-report reminders use that same supported guidance, including confirmation-enabled examples. An empty EndConversation does not satisfy a required child report; existing Task completion, send receipts and `[NO_ACTION]` decisions still govern reporting. Tool discovery narrows the applicable schemas, while execution checks remain authoritative.

Administrators can still Stop, Clear, move, and delete through ordinary trusted Main interfaces. Child model defaults apply to future Foxwarm children; the CLI's reported model is not a Foxwarm model binding.
