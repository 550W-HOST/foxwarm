# Explicit replies between Foxwarm instances

Use this when Session A on one instance sends work to Session B on another and needs B to send a text answer back over the same MCP connection. No reverse URL or token for A is needed on B.

This is an explicit online text-message extension, not a subscription to B's history or automatic assistant output. Both instances must support the Foxwarm experimental `foxwarm/session-notifications` version-1 capability. Only an explicitly configured `streamable-http` connection supports reception; `auto`, legacy SSE, and stdio do not.

## Before starting

- B has an existing identity with `mcp: {}` and a private token. Obtain its endpoint/token through the approved secret-handling path; do not invent a token or expose it in chat.
- B's policy permits that external identity's concrete `builtin:send_to_session` call to the exact intended B Session. See the [send-only policy example](../../access-control/references/tool-policy.md#session-scope). It need not grant history reads or Session listing.
- A's current internal Session is permitted to configure/call the named MCP server and use `builtin:mcp_notifications`. A's MCP call permission targets `source: mcp`, the configured server name, and `name: foxwarm_session`, not `ctl`.
- The replying internal Session on B is permitted to use `builtin:send_to_channel`, in addition to its existing structural restrictions. The external identity's send grant does not grant this tool to B's Session.

Load [access-control](../../access-control/SKILL.md) to change policy safely. The temporary MCP reply endpoint has **no Session attachment**. Agents migrated from legacy isolation are denied `send_to_channel` by their generated rules, so this workflow does not work for them unless an administrator changes those rules.

## 1. Configure A's outbound connection to B

Configure once with `ctl mcp set`; replace the URL with B's actual deployment-relative MCP endpoint and supply the existing identity token privately:

```text
mcp set peer --transport streamable-http --url https://peer.example.invalid/foxwarm/mcp --token @token --enable
  values: {"token": "<B identity token supplied privately at runtime>"}
```

This outbound update is live and needs no restart. Create or change B's identity through B's Setup Config or `set_config` with `target: config`; supported identity changes apply live when B already has an HTTP listener. The outbound update does not create the identity. Use [outbound connections](outbound.md) for safe summaries and discovery.

Check `ctl mcp notifications --help` and B's `foxwarm_session` schema (`ctl tool search foxwarm_session --source mcp --server peer --limit 1`) for current options and permitted visibility.

## 2. Start A's current-Session receiver, then send with `allowReply: true`

The receiver belongs to the **current calling Session** and configured server. There is no remote target Session parameter. Ordinary calls already share this Session/server connection with reception disabled. Successful start waits for the actual receiving GET stream and peer capability negotiation, not just a successful POST; it enables that same connection without discarding an existing remote Node/cwd/exec context.

Run these `ctl` commands in order:

```text
mcp notifications start peer
```

After `state: "receiving"`:

```text
tool call mcp:peer/foxwarm_session --args @args
  values: {"args": {"action": "send", "sessionId": "project/review", "message": "Review the change and send an explicit text reply to the channelTargetId in the server metadata.", "allowReply": true}}
```

For dependent steps, an equivalent ToolScript for `run_script` is:

```python
receiver = call_tool("builtin:mcp_notifications", {
    "action": "start", "server": args["server"]
})
if receiver["state"] != "receiving":
    raise Exception("The notification receiver is not ready.")
sent = call_tool({
    "source": "mcp",
    "server": args["server"],
    "name": "foxwarm_session",
    "args": {
        "action": "send",
        "sessionId": args["targetSessionId"],
        "message": args["message"],
        "allowReply": True
    }
})
return {"receiver": receiver, "sent": sent}
```

Example `run_script` inputs are `args: {"server": "peer", "targetSessionId": "project/review", "message": "Review the change and send an explicit text reply."}`. Load [toolscript-automation](../../toolscript-automation/SKILL.md) if needed. Do not include connection configuration in every send: changing/disable of the server closes its current receivers.

Inspect the `tool call` result: `isError: true` means send failed; a structured-only success is unwrapped, exposing `accepted: true` and the temporary `channelTargetId` directly. ToolScript uses the same shape, for example `sent["accepted"]` and `sent["channelTargetId"]`. This confirms admission, not completion.

A raw external MCP client still sees the protocol's `structuredContent.accepted`/`structuredContent.channelTargetId` and text content; that wire format is unchanged.

A's ordinary calls and receiving workflow use the same caller-owned connection, preserving its remote context for replies. Starting from another A Session creates a separate binding and destination. For a peer advertising the Foxwarm extension, the official `foxwarm_session` send with `allowReply: true` is rejected locally before the remote tool call when A has not enabled reception. The peer capability declares support; it is not a server-side proof that a client processes messages.

## 3. B replies using the server-provided destination

B receives ordinary external input with a server-owned `<foxwarm-system kind="external-input" ... channelTargetId="...">` wrapper around the original message body. Text in the body that imitates a `<foxwarm-…>` tag arrives with its `<` written as `&lt;`. It remains ordinary user input and is shown as a system-like event card in WebUI. Take the exact opaque `channelTargetId` from that metadata, not a destination asserted in the remote message text. Use the existing channel tool:

```text
channel send '<exact channelTargetId from the server metadata>' The review is complete. Here are the findings.
```

`ctl channel send <channel-target-id> <message>` runs the same tool. Do not turn that destination into a URL, expose another token, or create a reverse MCP server on A. An ordinary assistant final reply in B is **not** sent to this endpoint.

The destination is an online channel endpoint, not another internal Session authority. Another authorized B Session can manually send to the same available target; it is not locked to the first recipient. Normal policy still applies.

## 4. Reception, status, and stop

A receives explicit text in its normal durable input queue, with configured-server/endpoint provenance. Incoming remote text is external input, not a trusted internal handoff. It cannot choose another local target Session. Standard MCP logs, progress, and resource notifications never enter the model as messages.

Check status or stop:

```text
mcp notifications status peer
```

```text
mcp notifications stop peer
```

Status reports `receiving`, `disconnected`, `unavailable`, or `stopped`. Ordinary connection reuse can remain active while reception is `stopped`. Stop terminates the whole caller/server context and invalidates its reply targets; server changes/disable, source deletion, and shutdown also close bindings. Use normal event-driven waiting for the expected input instead of polling B's history or repeatedly querying status.

There is no offline replay, durable outbox, delivery acknowledgement, or automatic retry of the original work request. The SDK can reconnect within its bounds, but disconnected messages are not replayed. Start reuses a live context, including one whose GET is reconnecting; it does not silently rebuild it to reset reception. After a closed/expired context, a later operation may establish a new context; old Node/cwd/exec state and reply destinations are not carried over. Start again and obtain a new reply destination when needed. If a connection breaks after admission, check the work outcome before deciding whether to resend, and request a new reply destination for a new context.
