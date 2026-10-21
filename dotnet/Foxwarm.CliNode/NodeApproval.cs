using System.Text.Json.Nodes;

namespace Foxwarm.CliNode;

internal enum ToolApproval
{
    Approved,
    Rejected,
    Timeout,
    Busy,
    Cancelled,
}

internal sealed record NodeToolCall(
    string Tool,
    JsonObject? Args,
    string SessionId,
    string CallId,
    double TimeoutMs
);

internal sealed partial class NodeClient
{
    private async Task Approve(Connection connection, JsonObject frame, CancellationToken execStop)
    {
        if (options.ToolCallInterceptor is not { } intercept)
            return;
        using var cancelled = CancellationTokenSource.CreateLinkedTokenSource(
            connection.ApprovalStop.Token,
            execStop
        );
        var token = cancelled.Token;
        var request = new NodeToolCall(
            Text(frame, "tool") ?? "",
            frame["args"] as JsonObject,
            Text(frame, "sessionId")
                ?? Text(frame["args"] as JsonObject ?? new(), "sessionId")
                ?? "node",
            Text(frame, "callId") ?? "",
            frame["timeoutMs"] is JsonValue value && value.TryGetValue<double>(out var timeout)
                ? timeout
                : 0
        );
        ToolApproval decision;
        try
        {
            token.ThrowIfCancellationRequested();
            // A caller that ignores cancellation still cannot authorize a retired call.
            decision = await intercept(request, token).WaitAsync(token);
            token.ThrowIfCancellationRequested();
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            throw new InvalidDataException(
                execStop.IsCancellationRequested
                    ? "Exec was not started because Stop or Run queued cancelled it; the command was not executed."
                    : "Tool execution rejected because its interactive connection closed"
            );
        }
        if (decision != ToolApproval.Approved)
            throw new InvalidDataException(
                decision switch
                {
                    ToolApproval.Timeout =>
                        "Tool call timed out waiting for user confirmation on interactive node. The user was not present to approve.",
                    ToolApproval.Busy =>
                        "Tool execution rejected because another interactive tool call is awaiting approval",
                    _ => "Tool execution rejected by user on interactive node",
                }
            );
        // Disconnect only cancels approval. An approved effect keeps its original execution lifetime.
    }
}
