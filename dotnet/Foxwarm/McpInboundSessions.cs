using System.Security;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed class McpInboundSessions(
    SessionRuntime runtime,
    McpExternalAuthorization authorization
)
{
    private string Exact(string requested)
    {
        if (
            SessionGoal.Trim(requested).Length == 0
            || requested != SessionGoal.Trim(requested)
            || requested is "<main>" or "<parent>"
            || Encoding.UTF8.GetByteCount(requested) > 256
        )
            throw new McpInboundSafeException("An exact internal Session ID is required.");
        return SessionWait.Text(runtime.Catalog.Resolve(requested)["sessionId"])
            ?? throw new McpInboundSafeException("Session is unavailable.");
    }

    internal async Task<JsonObject> ListAsync(
        McpExternalContext context,
        long start,
        int count,
        CancellationToken token
    )
    {
        var args = new JsonObject
        {
            ["action"] = "list",
            ["start"] = start,
            ["count"] = count,
        };
        var permission = authorization.Request(context, "builtin", "session", args);
        await authorization.RequireAsync(context, permission, token);
        var (total, rows) = runtime.ListPage((int)Math.Min(start, int.MaxValue), count);
        var page = rows.Select(row =>
            {
                var item = new JsonObject();
                foreach (
                    var key in new[]
                    {
                        "id",
                        "displayName",
                        "busy",
                        "queueLength",
                        "messageCount",
                        "lastMessageTime",
                        "currentNode",
                    }
                )
                    if (row.ContainsKey(key))
                        item[key] = row[key]?.DeepClone();
                return (JsonNode?)item;
            })
            .ToArray();
        authorization.Require(context, permission);
        var result = new JsonObject
        {
            ["total"] = total,
            ["start"] = start,
            ["count"] = page.Length,
            ["sessions"] = new JsonArray(page),
        };
        if (start + page.Length < total)
            result["nextStart"] = start + page.Length;
        return result;
    }

    internal async Task<JsonObject> ReadAsync(
        McpExternalContext context,
        string requested,
        long? start,
        int count,
        int previewLength,
        CancellationToken token
    )
    {
        context.Require();
        var id = Exact(requested);
        var args = new JsonObject
        {
            ["sessionId"] = id,
            ["count"] = count,
            ["previewLength"] = previewLength,
        };
        if (start is not null)
            args["start"] = start;
        var permission = authorization.Request(context, "builtin", "get_session_messages", args);
        await authorization.RequireAsync(context, permission, token);
        var owner =
            await runtime.GetOwnerAsync(id, token)
            ?? throw new McpInboundSafeException("Session is unavailable.");
        if (owner.Id != id || Exact(requested) != id)
            throw new McpInboundSafeException("Session is unavailable.");
        var history = owner.History();
        var metadata = owner.Metadata();
        var actualStart = start is null
            ? Math.Max(0, history.Count - count)
            : (int)
                Math.Clamp(
                    start < 0 ? (long)history.Count + start.Value : start.Value,
                    0,
                    history.Count
                );
        var messages = history.Skip(actualStart).Take(count).ToArray();
        var state = SessionWait.Text(owner.RuntimeSnapshot(metadata)["state"]);
        var preview = new ContextPreviewRenderer(args).Render(
            id,
            "",
            history.Count,
            actualStart,
            messages
        );
        authorization.Require(context, permission);
        if (Exact(requested) != id || !ReferenceEquals(runtime.Owner(id), owner))
            throw new McpInboundSafeException("Session is unavailable.");
        return new JsonObject
        {
            ["sessionId"] = id,
            ["start"] = actualStart,
            ["count"] = count,
            ["total"] = history.Count,
            ["executionState"] = new JsonObject
            {
                ["state"] = state,
                ["busy"] = metadata.Busy,
                ["queueLength"] = metadata.QueueLength,
            },
            ["preview"] = preview,
        };
    }

    internal async Task<JsonObject> SendAsync(
        McpExternalContext context,
        string requested,
        string message,
        bool allowReply,
        CancellationToken token
    )
    {
        context.Require();
        if (
            SessionGoal.Trim(message).Length == 0
            || Encoding.UTF8.GetByteCount(message) > 1024 * 1024 - 4096
        )
            throw new McpInboundSafeException(
                "Message must be non-empty and fit in a bounded Session input."
            );
        var id = Exact(requested);
        var permission = authorization.Request(
            context,
            "builtin",
            "send_to_session",
            new JsonObject { ["sessionId"] = id, ["message"] = message }
        );
        await authorization.RequireAsync(context, permission, token);
        if (allowReply)
            throw new McpInboundSafeException(
                "A Foxwarm notification receiver is required for replies."
            );
        var owner =
            await runtime.GetOwnerAsync(id, token)
            ?? throw new McpInboundSafeException("Session is unavailable.");
        void Check()
        {
            token.ThrowIfCancellationRequested();
            authorization.Require(context, permission);
            if (
                Exact(requested) != id
                || owner.Id != id
                || !ReferenceEquals(runtime.Owner(id), owner)
            )
                throw new McpInboundSafeException("Session is unavailable.");
        }
        Check();
        var open =
            "<foxwarm-system kind=\"external-input\" externalId=\""
            + SecurityElement.Escape(context.ExternalId)
            + "\" contextId=\""
            + SecurityElement.Escape(context.Id)
            + "\" time=\""
            + DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss zzz")
            + "\" hint=\"Message from an external MCP client.\">";
        var item = new QueueItem(
            QueueItemType.User,
            [
                new JsonObject { ["system"] = open },
                new JsonObject { ["text"] = message },
                new JsonObject { ["system"] = "</foxwarm-system>" },
            ]
        );
        var serialized = new JsonObject
        {
            ["type"] = "user",
            ["parts"] = new JsonArray(item.Parts!.Select(p => (JsonNode?)p.DeepClone()).ToArray()),
        };
        if (Encoding.UTF8.GetByteCount(serialized.ToJsonString()) > 1024 * 1024)
            throw new McpInboundSafeException("Message exceeds the Session input limit.");
        try
        {
            await runtime.SubmitExternalAsync(owner, item, Check);
        }
        catch (McpInboundSafeException)
        {
            throw;
        }
        catch
        {
            throw new McpInboundSafeException(
                "Session admission failed; its outcome may be unknown. Do not retry automatically."
            );
        }
        return new JsonObject { ["accepted"] = true, ["sessionId"] = id };
    }
}
