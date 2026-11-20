using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task<MessageRouteResult> HandleDeleteCommandAsync(
        ChannelContext context,
        string requested,
        SessionOwner? source,
        bool publishReply = true
    )
    {
        JsonObject? result = null;
        string reply;
        try
        {
            {
                result = await runtime.DeleteAsync(requested, source: source);
                reply = SessionCatalog.Text(result["status"]) switch
                {
                    "busy" => $"🛑 Session `{requested}` is busy. Stop signal sent."
                        + (
                            SessionWait.Number(result["abortedInFlightCount"]) > 0
                                ? " The in-flight LLM request was aborted."
                                : " It will stop after the current tool call completes."
                        )
                        + (
                            SessionWait.Number(result["droppedQueueItems"]) > 0
                                ? $" Cleared {result["droppedQueueItems"]} queued item(s)."
                                : ""
                        )
                        + " Retry delete after it becomes idle.",
                    "deleted" => $"✅ Session `{result["deletedSessionIds"]![0]}` deleted.",
                    _ => $"❌ Session `{requested}` not found.",
                };
            }
        }
        catch (SessionDeletionException error)
        {
            reply = "❌ " + error.Message;
            if (publishReply)
                runtime.ReplyToCommand(context.SessionId, reply);
            var outcome = (JsonObject)error.Details.DeepClone();
            outcome["error"] = error.Message;
            outcome["code"] = error.Code;
            return new(
                error.Status >= 500 ? error.Status : 200,
                new JsonObject
                {
                    ["success"] = error.Status < 500,
                    ["commandResponse"] = reply,
                    ["result"] = JsonData.Node(outcome),
                }
            );
        }
        catch (Exception error)
        {
            reply = "❌ " + error.Message;
        }
        if (publishReply)
            runtime.ReplyToCommand(context.SessionId, reply);
        return new(
            200,
            new JsonObject
            {
                ["success"] = true,
                ["commandResponse"] = reply,
                ["result"] = JsonData.Node(result),
            }
        );
    }
}
