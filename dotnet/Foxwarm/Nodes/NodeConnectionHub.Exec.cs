using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class NodeConnectionHub
{
    internal RemoteExecAuthority ExecClaims { get; }
    internal Func<SessionOwner, string, bool>? LocalExecActive { get; set; }
    internal Func<string, JsonObject, Task>? SessionEvent { get; set; }
    internal Func<string, JsonObject, Task>? BackgroundRegistration { get; set; }

    private sealed class NodeToolException(JsonNode? error, bool? started)
        : InvalidOperationException(
            "Node tool failed: "
                + (
                    SessionWait.Text(error)
                    ?? (error is JsonObject ? SessionWait.Text(error["message"]) : null)
                    ?? "unspecified error"
                )
        )
    {
        internal readonly string? Code =
            error is JsonObject ? SessionWait.Text(error["code"]) : null;
        internal readonly string? Detail =
            SessionWait.Text(error)
            ?? (error is JsonObject ? SessionWait.Text(error["message"]) : null);
        internal readonly bool? Started = started;

        internal bool PreStart(string id) =>
            Started == false || Started is null && KnownRejection(id);

        internal bool KnownRejection(string id) =>
            Code == "PERSISTENT_EXEC_ID_COLLISION"
            || Detail == "Persistent exec ID is invalid."
            || Detail == $"Persistent exec `{id}` already exists.";

        internal bool RetryCollision(string id, bool legacy) =>
            Started != true
            && (
                legacy
                    ? Detail == $"Persistent exec `{id}` already exists."
                    : Code == "PERSISTENT_EXEC_ID_COLLISION"
            );
    }

    internal async Task<JsonNode?> ExecuteAsync(
        string id,
        string tool,
        JsonObject args,
        string sessionId,
        string agent,
        string currentNode,
        string? cwd,
        bool programmatic,
        CancellationToken token,
        SessionOwner? owner = null,
        Action<JsonNode?>? pathMetadata = null
    )
    {
        Connection connection;
        lock (gate)
        {
            connection = Require(id);
            if (
                !connection.Capabilities["tools"]!
                    .AsArray()
                    .Any(value => SessionWait.Text(value?["name"]) == tool)
            )
                throw new InvalidDataException("Tool is not advertised by Node: " + tool);
        }
        if (tool != "exec")
            return await ExecuteOnceAsync(
                connection,
                tool,
                args,
                sessionId,
                agent,
                currentNode,
                cwd,
                programmatic,
                token,
                null,
                owner,
                pathMetadata: pathMetadata
            );
        if (owner is null || owner.Id != sessionId || owner.Agent != agent)
            throw new InvalidOperationException(
                "Remote exec requires its current Main-owned Session."
            );
        var legacy = false;
        for (var attempt = 0; attempt < 16; attempt++)
        {
            token.ThrowIfCancellationRequested();
            owner.Entry.RequireIdentityAuthority();
            var execId = ExecClaims.NextId(legacy);
            if (LocalExecActive?.Invoke(owner, execId) == true)
                continue;
            var admission = owner.Entry.AdmitMutation();
            var claim = ExecClaims.Reserve(id, owner, execId);
            if (claim is null)
            {
                admission?.Dispose();
                continue;
            }
            try
            {
                return await ExecuteOnceAsync(
                    connection,
                    tool,
                    args,
                    claim.OriginalSessionId,
                    claim.Agent,
                    currentNode,
                    cwd,
                    programmatic,
                    token,
                    claim,
                    owner,
                    admission
                );
            }
            catch (NodeToolException error)
                when (error.Started != true
                    && !legacy
                    && SessionWait.Number(connection.Protocol?["negotiated"]) == 1
                    && error.Detail == "Persistent exec ID is invalid."
                )
            {
                legacy = true;
                attempt = -1;
            }
            catch (NodeToolException error) when (error.RetryCollision(execId, legacy)) { }
        }
        throw new InvalidOperationException(
            "Remote exec identity allocation exhausted after explicit pre-start collision rejections."
        );
    }

    private async Task<JsonNode?> ExecuteOnceAsync(
        Connection connection,
        string tool,
        JsonObject args,
        string sessionId,
        string agent,
        string currentNode,
        string? cwd,
        bool programmatic,
        CancellationToken token,
        RemoteExecAuthority.Claim? claim,
        SessionOwner? owner,
        IDisposable? dispatchAdmission = null,
        Action<JsonNode?>? pathMetadata = null
    )
    {
        var callId = "call_" + Guid.NewGuid().ToString("N");
        var result = new TaskCompletionSource<JsonNode?>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var supportsRegistration =
            connection
                .Capabilities["features"]
                ?["remoteExecBackgroundRegistration"]?.GetValue<bool>() == true;
        var supportsCancel =
            supportsRegistration
            && connection.Capabilities["features"]?["execWaitCancellation"]?.GetValue<bool>()
                == true;
        var call = new Invocation(connection, result, claim, supportsRegistration, owner, pathMetadata);
        var attemptedSend = false;
        // Exec Stop is a wire handshake, not cancellation of its correlation or remote process.
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(
            shutdown.Token,
            claim is null ? token : CancellationToken.None
        );
        deadline.CancelAfter(TimeSpan.FromSeconds(62));
        try
        {
            var request = new JsonObject
            {
                ["type"] = "tool_call",
                ["callId"] = callId,
                ["tool"] = tool,
                ["args"] = args.DeepClone(),
                ["sessionId"] = sessionId,
                ["agentName"] = agent,
                ["timeoutMs"] = 62000,
            };
            if (claim is not null)
            {
                request["backgroundExecId"] = claim.ExecId;
                request["completionCapability"] = claim.Grant;
            }
            if (currentNode == connection.Id && cwd is not null)
                request["sessionCwd"] = cwd;
            if (
                programmatic
                && connection.Capabilities["features"]?["programmaticToolData"]?.GetValue<bool>()
                    == true
            )
                request["programmatic"] = true;
            token.ThrowIfCancellationRequested();
            lock (gate)
            {
                if (connection.Retired || shutdown.IsCancellationRequested)
                    throw new IOException("Node unavailable before dispatch.");
                calls[callId] = call;
            }
            attemptedSend = true;
            await SendAsync(connection, request, deadline.Token);
            dispatchAdmission?.Dispose();
            dispatchAdmission = null;
            using var cancellation =
                claim is not null && supportsCancel
                    ? token.Register(() =>
                    {
                        if (
                            calls.TryGetValue(callId, out var pendingCall)
                            && ReferenceEquals(pendingCall, call)
                        )
                            _ = CancelExecWaitAsync(connection, callId);
                    })
                    : default;
            var value = await result.Task.WaitAsync(deadline.Token);
            if (claim is not null && token.IsCancellationRequested && !supportsCancel)
            {
                const string note =
                    "\nStop or Run queued could not end waiting early on this Node. The actual result is preserved; update the Node client for foreground exec wait cancellation.";
                if (value is JsonObject obj && SessionWait.Text(obj["output"]) is string output)
                    obj["output"] = output + note;
                else if (SessionWait.Text(value) is string text)
                    value = JsonValue.Create(text + note);
            }
            return value;
        }
        catch (NodeToolException)
        {
            throw; // The authenticated response handler already classified the start boundary.
        }
        catch (Exception error)
            when (error is OperationCanceledException or WebSocketException or IOException)
        {
            if (claim is not null)
                ExecClaims.Settle(claim, !attemptedSend);
            throw new IOException(
                attemptedSend
                    ? "Node request canceled, disconnected or timed out. Started effects may have occurred; they were not retried."
                    : "Node request was not dispatched.",
                error
            );
        }
        finally
        {
            dispatchAdmission?.Dispose();
            calls.TryRemove(callId, out _);
        }
    }

    private static async Task CancelExecWaitAsync(Connection connection, string callId)
    {
        try
        {
            await SendAsync(
                connection,
                new JsonObject { ["type"] = "tool_call_cancel", ["callId"] = callId },
                CancellationToken.None
            );
        }
        catch (Exception error)
            when (error is WebSocketException or IOException or ObjectDisposedException) { }
    }

    private void HandleToolReply(Connection connection, JsonObject message, bool success)
    {
        var callId = SessionWait.Text(message["callId"]) ?? "";
        if (
            !calls.TryGetValue(callId, out var call)
            || !ReferenceEquals(call.Connection, connection)
            || !calls.TryRemove(callId, out _)
        )
            return;
        if (success)
        {
            if (call.Claim is not null)
                ExecClaims.Settle(call.Claim, call.SupportsRegistration);
            call.PathMetadata?.Invoke(message["result"]);
            call.Result.TrySetResult(RemoteNodeResult.Normalize(message["result"]));
        }
        else
        {
            var started =
                message["execStarted"] is JsonValue value && value.TryGetValue<bool>(out var flag)
                    ? (bool?)flag
                    : null;
            if (
                started is null
                && message["error"] is JsonObject details
                && details["execStarted"] is JsonValue embedded
                && embedded.TryGetValue<bool>(out var reported)
            )
                started = reported;
            var error = new NodeToolException(message["error"], started);
            if (call.Claim is not null)
                ExecClaims.Settle(call.Claim, error.PreStart(call.Claim.ExecId));
            call.Result.TrySetException(error);
        }
    }

    internal void RetireSession(SessionOwner owner)
    {
        ExecClaims.Retire(owner);
        foreach (var pair in calls)
            if (ReferenceEquals(pair.Value.Owner, owner) && calls.TryRemove(pair.Key, out var call))
                call.Result.TrySetException(
                    new IOException(
                        "Session lifetime retired. Started remote effects were not killed or retried."
                    )
                );
    }
}
