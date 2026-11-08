using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

/// <summary>A Main-captured service endpoint bound to one transport generation of one Node.</summary>
internal sealed record NodeServiceTarget(
    string NodeId,
    string Service,
    Guid ConnectionId,
    int Version
);

internal sealed record NodeServiceEvent(NodeServiceTarget Target, JsonObject Event);

/// <summary>Reply handling shared by the resident WebSocket transport and the Provider channel.</summary>
internal static class NodeServiceReplies
{
    internal static readonly string[] FixedServices = ["vscode-fs", "vscode-git", "vscode-pty"];

    internal static void Complete(
        JsonObject message,
        bool success,
        TaskCompletionSource<JsonObject> result,
        Action<JsonObject>? receive
    )
    {
        if (success)
        {
            if (message["result"] is JsonObject value)
            {
                try
                {
                    var copy = (JsonObject)value.DeepClone();
                    // Attachment readiness is published before this transport admits subsequent stream events.
                    receive?.Invoke(copy);
                    result.TrySetResult(copy);
                }
                catch (Exception error)
                {
                    result.TrySetException(error);
                }
            }
            else
                result.TrySetException(
                    new CodeServiceException(
                        "NodeServiceError",
                        "Invalid Node service response.",
                        502
                    )
                );
            return;
        }
        var failure = message["error"] as JsonObject;
        var status = SessionWait.Number(failure?["statusCode"]);
        result.TrySetException(
            new CodeServiceException(
                SessionWait.Text(failure?["code"]) ?? "NodeServiceError",
                SessionWait.Text(failure?["message"])
                    ?? SessionWait.Text(message["error"])
                    ?? "Node service failed.",
                status is >= 400 and <= 599 ? (int)status : 500
            )
        );
    }
}
