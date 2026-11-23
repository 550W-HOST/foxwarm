using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

// Stopping a Session's background command on an authenticated CLI Node. Nodes advertise the
// request with features.execControl; older Nodes are reported unsupported without a request.
internal sealed partial class NodeConnectionHub
{
    internal const string ExecControlFeature = "execControl";

    internal enum RemoteStop
    {
        NotOwned,
        Unavailable,
        Unsupported,
        AlreadyRequested,
        Finished,
        Stopped,
        Killed,
        Ended,
        Unknown,
    }

    private sealed record ExecControlQuery(
        Connection Connection,
        TaskCompletionSource<JsonObject> Result
    );

    private readonly ConcurrentDictionary<string, ExecControlQuery> execControls = new(
        StringComparer.Ordinal
    );

    internal async Task<RemoteStop> StopRemoteExecAsync(
        SessionOwner owner,
        string execId,
        CancellationToken token
    )
    {
        var claim = ExecClaims.Active(owner, execId);
        if (claim is null)
            return RemoteStop.NotOwned;
        Connection connection;
        lock (gate)
        {
            if (
                !nodes.TryGetValue(claim.Node, out connection!)
                || connection.Retired
                || !connection.Open
                || !connection.Executable
            )
                return RemoteStop.Unavailable;
            if (
                connection.Http is not null
                || connection.Capabilities["features"]?[ExecControlFeature]?.GetValue<bool>()
                    != true
            )
                return RemoteStop.Unsupported;
        }
        if (!ExecClaims.RequestStop(claim))
            return RemoteStop.AlreadyRequested;
        var id = "exec-control-" + Guid.NewGuid().ToString("N");
        var completion = new TaskCompletionSource<JsonObject>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token, shutdown.Token);
        // The Node's grace period plus margin for its status check and reply.
        deadline.CancelAfter(TimeSpan.FromSeconds(15));
        execControls[id] = new(connection, completion);
        JsonObject result;
        try
        {
            await SendAsync(
                connection,
                new JsonObject
                {
                    ["type"] = "exec_control_request",
                    ["requestId"] = id,
                    ["action"] = "stop",
                    ["sessionId"] = claim.OriginalSessionId,
                    ["agentName"] = claim.Agent,
                    ["execId"] = claim.ExecId,
                    ["completionCapability"] = claim.Grant,
                },
                deadline.Token
            );
            result = await completion.Task.WaitAsync(deadline.Token);
        }
        catch (Exception error)
            when (error
                    is OperationCanceledException
                        or IOException
                        or System.Net.WebSockets.WebSocketException
                        or ObjectDisposedException
            )
        {
            // The request may have reached the Node; it is never resent.
            return RemoteStop.Unknown;
        }
        finally
        {
            execControls.TryRemove(id, out _);
        }
        var outcome = SessionWait.Text(result["outcome"]) switch
        {
            "stopped" => RemoteStop.Stopped,
            "killed" => RemoteStop.Killed,
            "ended" => RemoteStop.Ended,
            "already-requested" => RemoteStop.AlreadyRequested,
            "finished" or "not-found" => RemoteStop.Finished,
            _ => RemoteStop.Unknown,
        };
        if (outcome == RemoteStop.Finished)
            ExecClaims.ClearStop(claim);
        return outcome;
    }

    private void HandleExecControlReply(Connection connection, JsonObject message)
    {
        var requestId = SessionWait.Text(message["requestId"]) ?? "";
        if (
            !execControls.TryGetValue(requestId, out var query)
            || !ReferenceEquals(query.Connection, connection)
            || !execControls.TryRemove(requestId, out _)
        )
            return;
        if (message["result"] is JsonObject result)
            query.Result.TrySetResult((JsonObject)result.DeepClone());
        else
            query.Result.TrySetException(
                new IOException(SessionWait.Text(message["error"]) ?? "Exec stop failed on the Node.")
            );
    }
}
