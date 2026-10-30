using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class NodeConnectionHub
{
    internal ExternalExecOwnership ExternalExec { get; }

    private sealed record ExternalQuery(
        Connection Connection,
        TaskCompletionSource<JsonObject> Result
    );

    private readonly ConcurrentDictionary<string, ExternalQuery> externalQueries = new(
        StringComparer.Ordinal
    );

    private static bool SupportsExternal(Connection connection) =>
        connection is { Retired: false, Http: null }
        && connection.Open
        && connection.Executable
        && SessionWait.Number(connection.Protocol?["negotiated"]) == 3
        && SessionWait.Number(connection.Capabilities["features"]?["externalToolOwner"]) == 1;

    internal bool SupportsExternal(string node)
    {
        lock (gate)
            return nodes.TryGetValue(node, out var connection) && SupportsExternal(connection);
    }

    internal bool SupportsExternalRead(string node)
    {
        lock (gate)
            return nodes.TryGetValue(node, out var connection)
                && SupportsExternal(connection)
                && connection.Type is "cli" or "cli-node"
                && connection.Capabilities["tools"]!
                    .AsArray()
                    .Any(tool => SessionWait.Text(tool?["name"]) == "read");
    }

    internal async Task<JsonNode?> ExecuteExternalAsync(
        McpExternalContext context,
        string node,
        string tool,
        JsonObject args,
        string? cwd,
        ExternalExecOwnership.Record? record,
        Action assertActive,
        CancellationToken token
    )
    {
        Connection connection;
        lock (gate)
        {
            connection = Require(node);
            if (
                !SupportsExternal(connection)
                || !new[]
                {
                    "read",
                    "write",
                    "edit",
                    "apply_patch",
                    "exec",
                    "get_default_cwd",
                }.Contains(tool)
                || !connection.Capabilities["tools"]!
                    .AsArray()
                    .Any(value => SessionWait.Text(value?["name"]) == tool)
                || (tool == "exec") != (record is not null)
            )
                throw new McpInboundSafeException(
                    "Node capability is not available to external callers."
                );
        }
        var id = "call_" + Guid.NewGuid().ToString("N");
        var completion = new TaskCompletionSource<JsonNode?>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var call = new Invocation(connection, completion, null, false, null, null);
        var sent = false;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(shutdown.Token);
        deadline.CancelAfter(TimeSpan.FromSeconds(62));
        try
        {
            token.ThrowIfCancellationRequested();
            var request = new JsonObject
            {
                ["type"] = "tool_call",
                ["callId"] = id,
                ["tool"] = tool,
                ["args"] = args.DeepClone(),
                ["owner"] = context.WireOwner(),
                ["timeoutMs"] = 62000,
            };
            if (cwd is not null)
                request["sessionCwd"] = cwd;
            if (record is not null)
            {
                request["backgroundExecId"] = record.Id;
                request["completionCapability"] = record.Capability;
            }
            calls[id] = call;
            await SendAsync(
                connection,
                request,
                deadline.Token,
                () =>
                {
                    token.ThrowIfCancellationRequested();
                    assertActive();
                    lock (gate)
                        if (
                            !ReferenceEquals(nodes.GetValueOrDefault(node), connection)
                            || !SupportsExternal(connection)
                        )
                            throw new McpInboundSafeException("Node unavailable before dispatch.");
                    if (
                        record is not null
                        && !ReferenceEquals(ExternalExec.Get(context, record.Id), record)
                    )
                        throw new McpInboundSafeException(
                            "External execution context is unavailable."
                        );
                    sent = true;
                }
            );
            // A started command outlives the HTTP wait/context. No cancellation/retry kills it.
            return await completion.Task.WaitAsync(deadline.Token);
        }
        catch (NodeToolException error)
        {
            if (record is not null)
                ExternalExec.Failed(record, error.Started == false);
            throw new McpInboundSafeException(
                error.Started == false
                    ? "External Node tool was rejected before command start."
                    : "External Node tool failed; effects may have occurred. Do not retry automatically."
            );
        }
        catch (Exception error)
            when (error is IOException or WebSocketException or OperationCanceledException)
        {
            if (record is not null)
                ExternalExec.Failed(record, !sent);
            throw new McpInboundSafeException(
                sent
                    ? "Node request canceled, disconnected or timed out; outcome may be unknown. Do not retry automatically."
                    : "Node request was not dispatched."
            );
        }
        catch
        {
            if (record is not null)
                ExternalExec.Failed(record, !sent);
            throw;
        }
        finally
        {
            calls.TryRemove(id, out _);
        }
    }

    internal async Task<JsonObject> QueryExternalAsync(
        McpExternalContext context,
        string node,
        string execId,
        Action assertActive,
        CancellationToken token
    )
    {
        Connection connection;
        lock (gate)
        {
            connection = Require(node);
            if (!SupportsExternal(connection))
                throw new IOException("External Node is unavailable.");
        }
        var id = "external-exec-" + Guid.NewGuid().ToString("N");
        var completion = new TaskCompletionSource<JsonObject>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token, shutdown.Token);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        externalQueries[id] = new(connection, completion);
        try
        {
            await SendAsync(
                connection,
                new JsonObject
                {
                    ["type"] = "external_exec_result_request",
                    ["requestId"] = id,
                    ["owner"] = context.WireOwner(),
                    ["execId"] = execId,
                },
                deadline.Token,
                assertActive
            );
            return await completion.Task.WaitAsync(deadline.Token);
        }
        finally
        {
            externalQueries.TryRemove(id, out _);
        }
    }

    internal async Task ReleaseExternalAsync(McpExternalContext context, string[] usedNodes)
    {
        ExternalExec.Release(context);
        foreach (var node in usedNodes)
        {
            Connection? connection;
            lock (gate)
                connection = nodes.GetValueOrDefault(node);
            if (connection is null || !SupportsExternal(connection))
                continue;
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            try
            {
                await SendAsync(
                    connection,
                    new JsonObject
                    {
                        ["type"] = "external_exec_release",
                        ["owner"] = context.WireOwner(),
                    },
                    deadline.Token
                );
            }
            catch (Exception error)
                when (error
                        is IOException
                            or WebSocketException
                            or OperationCanceledException
                            or ObjectDisposedException
                ) { }
        }
    }

    private async Task HandleExternalMessageAsync(
        Connection connection,
        JsonObject message,
        string type,
        CancellationToken token
    )
    {
        if (!SupportsExternal(connection))
            return;
        if (type == "external_exec_result_response")
        {
            var requestId = SessionWait.Text(message["requestId"]) ?? "";
            if (
                externalQueries.TryGetValue(requestId, out var query)
                && ReferenceEquals(query.Connection, connection)
                && externalQueries.TryRemove(requestId, out _)
            )
            {
                if (message["error"] is not null || message["result"] is not JsonObject result)
                    query.Result.TrySetException(
                        new IOException("External Node result query failed.")
                    );
                else
                    query.Result.TrySetResult((JsonObject)result.DeepClone());
            }
            return;
        }
        var owner = message["owner"] as JsonObject;
        var id = SessionWait.Text(message["execId"]);
        var capability = SessionWait.Text(message["completionCapability"]);
        var validCwd = !message.ContainsKey("cwd") || SessionWait.Text(message["cwd"]) is not null;
        var accepted =
            type == "external_exec_background"
                ? ExternalExec.Background(connection.Id!, owner, id, capability)
                : validCwd
                    && ExternalExec.Complete(
                        connection.Id!,
                        owner,
                        id,
                        capability,
                        SessionWait.Text(message["output"]),
                        SessionWait.Text(message["cwd"])
                    );
        if (
            type == "external_exec_completed"
            && SessionWait.Text(message["requestId"]) is string request
        )
            await SendAsync(
                connection,
                new JsonObject
                {
                    ["type"] = "cli_response",
                    ["requestId"] = request,
                    ["ok"] = accepted,
                    ["result"] = accepted ? new JsonObject { ["accepted"] = true } : null,
                    ["error"] = accepted ? null : "External execution owner is unavailable.",
                },
                token
            );
    }
}
