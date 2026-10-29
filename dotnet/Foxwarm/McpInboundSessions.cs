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
        JsonObject options,
        CancellationToken token
    )
    {
        context.Require();
        var id = Exact(requested);
        var args = (JsonObject)options.DeepClone();
        args.Remove("action");
        args["sessionId"] = id;
        if (!args.ContainsKey("count"))
            args["count"] = 10;
        if (!args.ContainsKey("previewLength"))
            args["previewLength"] = 6000;
        var permission = authorization.Request(context, "builtin", "view_session", args);
        await authorization.RequireAsync(context, permission, token);
        var owner =
            await runtime.GetOwnerAsync(id, token)
            ?? throw new McpInboundSafeException("Session is unavailable.");
        if (owner.Id != id || Exact(requested) != id)
            throw new McpInboundSafeException("Session is unavailable.");
        ContextPreviewRenderer renderer;
        SessionViewPage page;
        try
        {
            renderer = new ContextPreviewRenderer(args, externalRead: true);
            page = owner.ViewPage(args, renderer);
        }
        catch (InvalidDataException error)
        {
            throw new McpInboundSafeException(error.Message);
        }
        var preview = page.Stale
            ? "The active range changed structurally. Read a fresh page: "
                + renderer.LiveCall(new JsonObject { ["sessionId"] = id })
            : renderer.RenderLive(id, page, args);
        authorization.Require(context, permission);
        if (Exact(requested) != id || !ReferenceEquals(runtime.Owner(id), owner))
            throw new McpInboundSafeException("Session is unavailable.");
        var result = new JsonObject
        {
            ["sessionId"] = id,
            ["start"] = page.Begin,
            ["end"] = page.End,
            ["count"] = page.Messages.Length,
            ["total"] = page.Total,
            ["historyVersion"] = page.HistoryVersion,
            ["executionState"] = new JsonObject
            {
                ["state"] = page.Runtime["state"]?.DeepClone(),
                ["busy"] = page.Runtime["busy"]?.DeepClone(),
                ["queueLength"] = page.Runtime["queueLength"]?.DeepClone(),
            },
            ["preview"] = preview,
        };
        if (page.Stale)
        {
            result["error"] = "stale_history_boundary";
            var error = McpInboundCatalog.Result(result);
            error["isError"] = true;
            return error;
        }
        return result;
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
        using var reply = allowReply
            ? (
                context.ReplyChannel
                ?? throw new McpInboundSafeException(
                    "A Foxwarm notification receiver is required for replies."
                )
            ).Acquire()
            : null;
        var owner =
            await runtime.GetOwnerAsync(id, token)
            ?? throw new McpInboundSafeException("Session is unavailable.");
        void Check()
        {
            token.ThrowIfCancellationRequested();
            authorization.Require(context, permission);
            if (allowReply)
                context.ReplyChannel!.Require();
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
            + (
                allowReply
                    ? "\" channelTargetId=\""
                        + SecurityElement.Escape(context.ReplyChannel!.TargetId)
                    : ""
            )
            + "\" hint=\"Message from an external MCP client."
            + (
                allowReply
                    ? " For an explicit reply, use send_to_channel with the channelTargetId shown here. Ordinary assistant replies are not sent to this connection."
                    : ""
            )
            + "\">";
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
        catch (AuthorityCommittedException)
        {
            reply?.Commit();
            throw new McpInboundSafeException(
                "Session admission failed; its outcome may be unknown. Do not retry automatically."
            );
        }
        catch
        {
            throw new McpInboundSafeException(
                "Session admission failed; its outcome may be unknown. Do not retry automatically."
            );
        }
        reply?.Commit();
        var result = new JsonObject { ["accepted"] = true, ["sessionId"] = id };
        if (allowReply)
            result["channelTargetId"] = context.ReplyChannel!.TargetId;
        return result;
    }
}
