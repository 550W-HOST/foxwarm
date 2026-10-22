using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal static class ArchiveControlTools
{
    internal static JsonArray Definitions() =>
        new(
            Definition(
                "get_archived_messages",
                "Read archived messages by sequence number, including messages no longer present in the active conversation.",
                "startSeq",
                "First message sequence number to include.",
                "endSeq",
                "Last message sequence number to include."
            ),
            Definition(
                "get_archived_blocks",
                "Read archived context-block summaries by block ID.",
                "startId",
                "First block ID to include.",
                "endId",
                "Last block ID to include."
            ),
            JsonNode.Parse(
                """
                {"type":"function","name":"stop_session","description":"Request that a running session stop its current turn. An in-flight model request may be aborted; a tool already running may need to finish.","parameters":{"type":"object","properties":{"sessionId":{"type":"string","description":"Session to stop."}},"required":["sessionId"],"additionalProperties":false},"strict":false}
                """
            )!
        );

    private static JsonObject Definition(
        string name,
        string description,
        string first,
        string firstDescription,
        string last,
        string lastDescription
    ) =>
        new()
        {
            ["type"] = "function",
            ["name"] = name,
            ["description"] = description,
            ["strict"] = false,
            ["parameters"] = new JsonObject
            {
                ["type"] = "object",
                ["required"] = new JsonArray(),
                ["additionalProperties"] = false,
                ["properties"] = new JsonObject
                {
                    ["sessionId"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "Session to read. Defaults to this session.",
                    },
                    [first] = new JsonObject
                    {
                        ["type"] = "number",
                        ["description"] = firstDescription,
                    },
                    [last] = new JsonObject
                    {
                        ["type"] = "number",
                        ["description"] = lastDescription,
                    },
                    ["previewLength"] = new JsonObject
                    {
                        ["type"] = "number",
                        ["description"] =
                            "Total character budget for the response. Defaults to 1,000; values are bounded to 1,000–20,000.",
                    },
                },
            },
        };

    internal static async Task<JsonObject> ReadMessagesAsync(
        SessionManager manager,
        SessionOwner source,
        JsonObject args,
        CancellationToken token
    )
    {
        Validate(args, "startSeq", "endSeq");
        var (sessionId, archive) = await AuthorizeArchiveAsync(
            manager,
            source,
            "get_archived_messages",
            args,
            token
        );
        var first = Number(args["startSeq"]);
        var last = Number(args["endSeq"]);
        if (first is not null && last is not null && first > last)
            (first, last) = (last, first);

        var records = archive.ReadEffectiveMessagesNumericRange(first, last);
        var stats = archive.EffectiveMessageStats();
        var canonicalSessionId = archive.CanonicalSessionId;
        var renderer = new ContextPreviewRenderer(args, 1000);
        var requested = RangeLabel("msg", first, last);
        var output = renderer.RenderItems(
            records
                .Select(record => renderer.ArchivedMessage(record, canonicalSessionId))
                .ToArray(),
            $"Archived messages for session `{sessionId}`{requested}.",
            matched => $"Showing {matched} of {records.Count} selected messages.",
            records.Count == 0
                ? $"No archived messages matched this lookup. Available message log: {(stats.Count == 0 ? "none" : $"msg#{stats.First}-{stats.Last}")}."
                : "No archived messages matched the requested filters.",
            []
        );
        return Output(output);
    }

    internal static async Task<JsonObject> ReadBlocksAsync(
        SessionManager manager,
        SessionOwner source,
        JsonObject args,
        CancellationToken token
    )
    {
        Validate(args, "startId", "endId");
        var (sessionId, archive) = await AuthorizeArchiveAsync(
            manager,
            source,
            "get_archived_blocks",
            args,
            token
        );
        var first = Number(args["startId"]);
        var last = Number(args["endId"]);
        var blocks = archive.ReadEffectiveBlocksNumericRange(first, last);
        var items = blocks
            .Select(block => ArchiveContextReader.BlockItem(block, archive.CanonicalSessionId))
            .ToArray();
        var renderer = new ContextPreviewRenderer(args, 1000);
        var output = renderer.RenderItems(
            items,
            $"Archived context blocks for session `{sessionId}`{RangeLabel("B", first, last)}.",
            matched => $"Showing {matched} of {blocks.Count} selected blocks.",
            "No archived blocks matched this lookup.",
            []
        );
        return Output(output);
    }

    internal static async Task<JsonObject> StopAsync(
        SessionManager manager,
        SessionOwner source,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, ["sessionId"]);
        var requested = SessionWait.Text(args["sessionId"]);
        if (requested is null || SessionGoal.Trim(requested).Length == 0)
            throw new InvalidDataException("stop_session requires sessionId.");

        var targetId = manager.ResolveSessionReference(source, SessionGoal.Trim(requested));
        var target =
            await manager.GetExistingAsync(targetId, token)
            ?? throw new InvalidDataException(
                $"Session `{SessionGoal.Trim(requested)}` not found."
            );
        await manager.AuthorizeToolAsync(
            source,
            new("stop_session", "builtin", "stop_session", args),
            null,
            token,
            target
        );

        var snapshot = target.Entry.Snapshot();
        if (!snapshot.Busy && !target.Processing)
            return new JsonObject
            {
                ["output"] = $"Session `{target.Id}` is idle; no stop was needed.",
            };

        var result = await target.Registry.Control.StopAsync(target.Id);
        var output = result.AbortedInFlight
            ? $"Stop signal sent to session `{target.Id}`; its in-flight request was canceled."
            : $"Stop signal sent to session `{target.Id}`. It will stop after the current tool call completes.";
        return new JsonObject { ["output"] = output };
    }

    private static async Task<(
        string SessionId,
        SqliteArchiveMessageStore Archive
    )> AuthorizeArchiveAsync(
        SessionManager manager,
        SessionOwner source,
        string name,
        JsonObject args,
        CancellationToken token
    )
    {
        Validate(
            args,
            name is "get_archived_messages" ? "startSeq" : "startId",
            name is "get_archived_messages" ? "endSeq" : "endId"
        );
        var sessionId = SessionGoal.Trim(SessionWait.Text(args["sessionId"]) ?? source.Id);
        await manager.AuthorizeToolAsync(source, new(name, "builtin", name, args), null, token);
        if (manager.AgentIsolated(source.Agent))
        {
            // Source resolves live catalog aliases first and falls back to the requested
            // identity's Agent segment when no live membership remains. Do not hydrate
            // an owner or inspect retained Archive contents to admit this read.
            var targetAgent = manager.AuthorizationTarget(sessionId)?.Agent ?? sessionId.Split('/')[0];
            if (targetAgent != source.Agent)
                throw new ToolAuthorizationDeniedException(
                    $"Isolated session can only use {name} for sessions under its own agent ({source.Agent})."
                );
        }
        return (sessionId, manager.ArchiveReader(sessionId));
    }

    private static void Validate(JsonObject args, string first, string last) =>
        ToolRegistry.Keys(
            args,
            [
                "sessionId",
                first,
                last,
                "previewLength",
                "contentFilter",
                "includeRegex",
                "excludeRegex",
                "toolDetail",
            ]
        );

    private static double? Number(JsonNode? node) => node is null ? null : SessionWait.Number(node);

    private static string RangeLabel(string prefix, double? first, double? last)
    {
        if (first is null && last is null)
            return string.Empty;
        var firstText = first is null
            ? "?"
            : first.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var lastText = last is null
            ? "?"
            : last.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return $" at {prefix}#{firstText}-{lastText}";
    }

    private static JsonObject Output(string text) => new() { ["output"] = text };
}
