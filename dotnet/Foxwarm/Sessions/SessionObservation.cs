using System.Text.Json.Nodes;
using Foxwarm.Tools;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed record SessionViewPage(
    int Begin,
    int End,
    int Total,
    long Count,
    long HistoryVersion,
    JsonObject Runtime,
    (int Index, JsonObject Message)[] Messages,
    bool Stale = false
);

internal sealed partial class SessionOwner
{
    internal SessionViewPage ViewPage(JsonObject args, ContextPreviewRenderer renderer) =>
        Entry.WithState(state =>
        {
            var total = state.History.Count;
            static int? Integer(JsonObject args, string name, int min, int max)
            {
                if (!args.ContainsKey(name))
                    return null;
                if (
                    SessionWait.Number(args[name]) is not { } value
                    || !double.IsFinite(value)
                    || value != Math.Truncate(value)
                    || value < min
                    || value > max
                )
                    throw new InvalidDataException(
                        name + " must be an integer in [" + min + "," + max + "]."
                    );
                return (int)value;
            }
            var start = Integer(args, "start", int.MinValue, int.MaxValue);
            var before = Integer(args, "before", 0, int.MaxValue);
            var requestedCount = args.ContainsKey("count") ? SessionWait.Number(args["count"]) : 10;
            if (
                requestedCount is not { } countValue
                || !double.IsFinite(countValue)
                || countValue < 0
                || countValue > 9007199254740991L
                || countValue != Math.Truncate(countValue)
            )
                throw new InvalidDataException("count must be a nonnegative safe integer.");
            var count = (long)countValue;
            if (start.HasValue && before.HasValue)
                throw new InvalidDataException("start and before cannot be combined.");
            if (args.ContainsKey("historyVersion"))
            {
                if (
                    SessionWait.Number(args["historyVersion"]) is not { } version
                    || !double.IsFinite(version)
                    || version < 0
                    || version > 9007199254740991L
                    || version != Math.Truncate(version)
                )
                    throw new InvalidDataException(
                        "historyVersion must be a nonnegative safe integer."
                    );
                if ((start.HasValue || before.HasValue) && version != state.HistoryVersion)
                    return new SessionViewPage(
                        0,
                        0,
                        total,
                        count,
                        state.HistoryVersion,
                        RuntimeSnapshot(Metadata()),
                        [],
                        Stale: true
                    );
            }
            var forward = start.HasValue;
            var boundary = forward
                ? (int)
                    Math.Clamp(start!.Value < 0 ? (long)total + start.Value : start.Value, 0, total)
                : Math.Min(before ?? total, total);
            var index = forward ? boundary : boundary - 1;
            var begin = boundary;
            var end = boundary;
            var rows = new List<(int Index, JsonObject Message)>();
            while (rows.Count < count && index >= 0 && index < total)
            {
                begin = Math.Min(begin, index);
                end = Math.Max(end, index + 1);
                var row = state.History[index].ToJson();
                if (renderer.Eligible(row))
                    rows.Add((index, row));
                index += forward ? 1 : -1;
            }
            if (!forward)
                rows.Reverse();
            return new SessionViewPage(
                begin,
                end,
                total,
                count,
                state.HistoryVersion,
                RuntimeSnapshot(Metadata()),
                rows.ToArray()
            );
        });

    internal (int Estimate, JsonObject? Usage, long? Threshold, int Images) ContextSummary() =>
        Entry.WithState(state =>
        {
            var tokens = CompactCandidateBuilder.Tokens(
                SessionWait.Text(state.AuthorityEnvelope["persistentMemorySnapshot"]) ?? ""
            );
            var images = 0;
            foreach (
                var row in state
                    .History.Where(row => row.IsModelVisible)
                    .Select(row => row.ToJson())
            )
            {
                var summary = Foxwarm.Images.ImageTokenEstimate.Message(row);
                tokens += summary.Tokens;
                images += summary.Images;
            }
            return (
                tokens,
                (state.AuthorityEnvelope["stats"] as JsonObject)?["lastUsage"] is JsonObject usage
                    ? (JsonObject)usage.DeepClone()
                    : null,
                CompactCandidateBuilder.Number(state.AuthorityEnvelope["compactThresholdTokens"]),
                images
            );
        });
}

internal static class SessionStatus
{
    // A Session's runtime state as record fields: its state, and the compaction phase, wait,
    // live activity and queue only when present.
    internal static JsonObject RuntimeFields(JsonObject state, JsonObject? target = null)
    {
        target ??= new JsonObject();
        target["state"] = SessionWait.Text(state["state"]) ?? "idle";
        if (
            state["active"] is JsonObject active
            && SessionWait.Text(active["phase"]) == "compaction"
        )
            target["phase"] = "compaction";
        if (state["waiting"] is JsonObject wait)
        {
            target["waitingFor"] = SessionWait.Text(wait["waitingFor"]) ?? "waiting";
            if (SessionWait.Text(wait["reason"]) is string reason)
                target["waitReason"] = reason;
            foreach (var key in new[] { "pendingSessions", "waitExecIds", "waitQuestionIds" })
                if (SessionWait.Strings(wait[key]) is { Length: > 0 } values)
                    target[key] = Strings(values);
        }
        if (Activity(state) is { } activity)
            target["activity"] = activity;
        if (SessionWait.Number(state["queueLength"]) is > 0 and var queued)
            target["queueLength"] = (long)queued;
        return target;
    }

    // The runtime sentence of session view and `/status`, from RuntimeFields.
    internal static string Runtime(JsonObject state) => RuntimeText(RuntimeFields(state));

    private static string RuntimeText(JsonObject fields)
    {
        var name = SessionWait.Text(fields["state"]) ?? "idle";
        if (SessionWait.Text(fields["phase"]) == "compaction")
            name += " (compaction)";
        if (SessionWait.Text(fields["waitingFor"]) is { } waitingFor)
        {
            name += " (" + waitingFor + ")";
            if (SessionWait.Text(fields["waitReason"]) is string reason)
                name += "; reason: " + reason;
            if (SessionWait.Strings(fields["pendingSessions"]) is { Length: > 0 } pending)
                name += "; pending: " + string.Join(", ", pending);
            if (SessionWait.Strings(fields["waitExecIds"]) is { Length: > 0 } exec)
                name += "; exec: " + string.Join(", ", exec);
            if (SessionWait.Strings(fields["waitQuestionIds"]) is { Length: > 0 } questions)
                name += "; questions: " + string.Join(", ", questions);
        }
        if (SessionWait.Text(fields["activity"]) is { } activity)
            name += "; activity: " + Quote(activity);
        var queued = SessionWait.Number(fields["queueLength"]) ?? 0;
        return "Session execution state: " + name + (queued > 0 ? "; queue: " + queued : "") + ".";
    }

    private static JsonArray Strings(IEnumerable<string> values) =>
        new(values.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());

    // The later of the live reasoning heading and tool summary, already bounded to one line.
    private static string? Activity(JsonObject state)
    {
        if (state["activity"] is not JsonObject activity)
            return null;
        var reasoning = SessionWait.Text(activity["reasoning"]);
        var tool = SessionWait.Text(activity["tool"]);
        var text = SessionWait.Text(activity["latest"]) == "reasoning"
            ? reasoning ?? tool
            : tool ?? reasoning;
        return string.IsNullOrWhiteSpace(text) ? null : ToolActivity.SingleLine(text);
    }

    private static string Quote(string text) =>
        "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    // The newest message seq beside the active history count; seq numbers every message ever
    // appended, while active history excludes compacted and archived rows.
    internal static string Messages(long latestSeq, long active) =>
        latestSeq > 0 ? $"msg#{latestSeq} latest · {active} active" : $"{active} active";

    internal static string Date(double value) =>
        value == 0
            ? "never"
            : DateTimeOffset
                .FromUnixTimeMilliseconds((long)value)
                .UtcDateTime.ToString(
                    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                    System.Globalization.CultureInfo.InvariantCulture
                );

    // One Session of session list and of the recent children of session status. The message
    // seq, display name and last message time are left out when there are none.
    internal static JsonObject Row(JsonObject dto, string? current = null)
    {
        var id = SessionWait.Text(dto["id"]);
        var row = new JsonObject { ["id"] = id };
        if (SessionWait.Text(dto["displayName"]) is { } name)
            row["displayName"] = name;
        if (current is not null && id == current)
            row["current"] = true;
        if ((long)(SessionWait.Number(dto["latestMessageSeq"]) ?? 0) is > 0 and var latest)
            row["latestMessageSeq"] = latest;
        row["activeMessages"] = (long)(SessionWait.Number(dto["messageCount"]) ?? 0);
        RuntimeFields(dto["runtimeState"]!.AsObject(), row);
        if (SessionWait.Number(dto["lastMessageTime"]) is > 0 and var last)
            row["lastMessageAt"] = Date(last);
        return row;
    }

    // A session list or recent-children row as `/status` shows it.
    private static string RowText(JsonObject row) =>
        $"🤖 `{SessionWait.Text(row["id"])}`"
        + (SessionWait.Text(row["displayName"]) is { } name ? " (" + name + ")" : "")
        + $" - {Messages((long)(SessionWait.Number(row["latestMessageSeq"]) ?? 0), (long)(SessionWait.Number(row["activeMessages"]) ?? 0))} - {RuntimeText(row)} - Last: {SessionWait.Text(row["lastMessageAt"]) ?? "never"}";

    // The `/status` reply, from the session status record.
    internal static string Text(JsonObject status)
    {
        string Value(string key) => SessionWait.Text(status[key]) ?? status[key]?.ToJsonText() ?? "";
        static string Count(JsonNode? value) =>
            (SessionWait.Number(value) ?? 0).ToString("N0", System.Globalization.CultureInfo.CurrentCulture);
        var node = status["node"]!.AsObject();
        var usage = status["lastUsage"] as JsonObject;
        var usageText = usage is null
            ? "none"
            : $"cached={Count(usage["cachedTokens"])}, input={Count(usage["inputTokens"])}, output={Count(usage["outputTokens"])}"
                + (usage["reasoningTokens"] is { } reasoning ? $" (reasoning={Count(reasoning)})" : "")
                + $", total={Count(usage["totalTokens"])}"
                + (
                    SessionWait.Number(usage["cost"]) is double cost
                        ? $", estimated cost={ModelUsageCost.FormatUsd(cost)}"
                        : ""
                );
        var children = (status["recentChildren"] as JsonArray ?? []).OfType<JsonObject>().ToArray();
        var images = (long)(SessionWait.Number(status["images"]) ?? 0);
        return "📊 *Session Status*\n\n"
            + $"- session id: `{Value("sessionId")}`\n- name: {SessionWait.Text(status["displayName"]) ?? "unset"}\n- agent id/name: `{Value("agent")}`\n- current node: `{SessionWait.Text(node["id"])}` (connected={(SessionCatalog.Flag(node["connected"]) ? "true" : "false")}, type={SessionWait.Text(node["type"])})\n- agent directory: `{Value("agentDirectory")}`\n- current cwd: {(SessionWait.Text(status["cwd"]) is { } cwd ? $"`{cwd}`" : $"not set (defaults to current node agent directory; master: `{Value("agentDirectory")}`)")}\n"
            + (
                SessionWait.Text(status["parentSessionId"]) is { } parent
                    ? $"- parent session id: `{parent}`\n"
                    : ""
            )
            + (SessionCatalog.Flag(status["archived"]) ? "- 📦 archived\n" : "")
            + $"- model: `{Value("model")}`\n- effort: raw={SessionWait.Text(status["effort"]) ?? "unset"}, effective={SessionWait.Text(status["effectiveEffort"]) ?? "per-leaf default"}, allowed={string.Join('|', SessionWait.Strings(status["allowedEfforts"]))}, default={Value("defaultEffort")}\n"
            + $"- messages: {Messages((long)(SessionWait.Number(status["latestMessageSeq"]) ?? 0), (long)(SessionWait.Number(status["activeMessages"]) ?? 0))}\n- token estimate: ~{Value("tokenEstimate")} / {Value("contextLimit")}\n- images: {images}{(status["imagesSent"] is not null && !SessionCatalog.Flag(status["imagesSent"]) ? " (not sent: the current model does not support image input)" : "")}\n- last usage: {usageText}\n- last message: {SessionWait.Text(status["lastMessageAt"]) ?? "never"}\n- auto-compact threshold: ~{Value("compactThresholdTokens")} tokens ({(SessionWait.Text(status["compactThresholdSource"]) == "override" ? "override" : "model default")})\n"
            + (
                SessionWait.Number(status["totalCost"]) is double totalCost
                    ? $"- total estimated cost: {ModelUsageCost.FormatUsd(totalCost)}\n"
                    : ""
            )
            + $"- child model: raw={SessionWait.Text(status["childModel"]) ?? "follow current"}, effective={Value("effectiveChildModel")}; child effort: raw={SessionWait.Text(status["childEffort"]) ?? "unset"}, effective={Value("effectiveChildEffort")}\n"
            + $"- runtime state: {RuntimeText(status["runtime"]!.AsObject())}\n"
            + (SessionCatalog.Flag(status["busy"]) ? "- busy: yes\n" : "")
            + (
                SessionWait.Number(status["runtime"]?["queueLength"]) is > 0 and var queue
                    ? $"- queue: {queue}\n"
                    : ""
            )
            + "\nRecent child sessions (max 10):"
            + (
                children.Length == 0
                    ? " none\n"
                    : "\n" + string.Join('\n', children.Select(RowText)) + "\n"
            );
    }
}

internal sealed partial class SessionManager
{
    // Model-facing lists show only Sessions the caller's policy might let it address. An
    // administrator surface that renders the same status (`/status`) passes administrator: true.
    internal async Task<JsonObject> ObserveAsync(
        SessionOwner source,
        string name,
        JsonObject args,
        bool administrator = false
    )
    {
        if (name == "view_session")
        {
            Keys(
                args,
                [
                    "sessionId",
                    "start",
                    "before",
                    "count",
                    "historyVersion",
                    "parts",
                    "previewLength",
                    "contentFilter",
                    "includeRegex",
                    "excludeRegex",
                    "toolDetail",
                ],
                ["sessionId"]
            );
            var targetId = RequiredString(args, "sessionId");
            var target = await GetExistingAsync(targetId);
            if (target is null)
                return Output($"Session `{targetId}` not found.");
            await AuthorizeToolAsync(
                source,
                new(name, "builtin", name, args),
                null,
                semanticCaller.Value ?? CancellationToken.None,
                target
            );
            var renderer = new ContextPreviewRenderer(args);
            var page = target.ViewPage(args, renderer);
            if (page.Stale)
                return new JsonObject
                {
                    ["error"] = "stale_history_boundary",
                    ["historyVersion"] = page.HistoryVersion,
                    ["output"] =
                        "The active range changed structurally. Read a fresh page: "
                        + CtlCommandText.For(
                            "view_session",
                            new JsonObject { ["sessionId"] = targetId }
                        ),
                };
            return Output(renderer.RenderLive(targetId, page, args));
        }
        Keys(
            args,
            ["action", "start", "count", "scope", "query", "sessionId", "name", "parentSessionId"],
            []
        );
        var action =
            SessionWait.Text(args["action"]) is string raw && SessionGoal.Trim(raw).Length > 0
                ? SessionGoal.Trim(raw).ToLowerInvariant()
                : "status";
        if (action == "update-display-name")
        {
            var targetId = OptionalString(args, "sessionId") ?? source.Id;
            var canonical =
                SessionCatalog.Text(Catalog.Resolve(targetId)["sessionId"])
                ?? throw new InvalidDataException($"Session `{targetId}` not found.");
            if (SessionWait.Text(args["name"]) is not string rawName)
                throw new InvalidDataException(
                    "session.name is required for action=\"update-display-name\"."
                );
            var next = SessionGoal.Trim(rawName);
            var previous = SessionCatalog.Text(Catalog.Get(canonical)?["displayName"]);
            var current = next.Length == 0 ? null : next;
            if (previous != current)
                await RenameAsync(canonical, current);
            var result = (Changed: previous != current, Previous: previous, Current: current);
            static string Format(string? value) =>
                value is null ? "unset" : EcmaJson.Stringify(JsonValue.Create(value)!);
            return Output(
                result.Changed
                    ? $"Session `{targetId}` display name changed from {Format(result.Previous)} to {Format(result.Current)}."
                    : $"Session `{targetId}` display name unchanged (from {Format(result.Previous)} to {Format(result.Current)})."
            );
        }
        if (action is "archive" or "unarchive")
        {
            // Main catalog presentation only, like a display name: the Session keeps running.
            var targetId = OptionalString(args, "sessionId") ?? source.Id;
            var canonical =
                SessionCatalog.Text(Catalog.Resolve(targetId)["sessionId"])
                ?? throw new InvalidDataException($"Session `{targetId}` not found.");
            var archived = action == "archive";
            var change = ChangePresentation(catalog => catalog.Archive(canonical, archived));
            var changed = SessionWait.Number(change.Result["changedCount"]) is > 0;
            return Output(
                changed
                    ? $"Session `{canonical}` {(archived ? "archived" : "unarchived")}."
                    : $"Session `{canonical}` was already {(archived ? "archived" : "not archived")}."
            );
        }
        if (action == "update-parent")
        {
            var requestedTarget = OptionalSessionReference(args);
            var targetId = requestedTarget ?? source.Id;
            if (!args.ContainsKey("parentSessionId"))
                throw new InvalidDataException(
                    "parentSessionId is required for action=\"update-parent\" and must be a non-empty session ID or null."
                );
            string? requestedParent = null;
            if (args["parentSessionId"] is not null)
            {
                requestedParent = SessionWait.Text(args["parentSessionId"]);
                if (requestedParent is null || SessionGoal.Trim(requestedParent).Length == 0)
                    throw new InvalidDataException(
                        "parentSessionId must be a non-empty session ID or null."
                    );
                requestedParent = SessionGoal.Trim(requestedParent);
            }
            RequireParentChange(source.Agent, targetId, requestedParent);
            var change = ChangePresentation(catalog =>
                catalog.SetParent(targetId, requestedParent)
            );
            return new JsonObject
            {
                ["sessionId"] = change.Result["childSessionId"]?.DeepClone(),
                ["previousParentSessionId"] = change.Result["previousParentSessionId"]?.DeepClone(),
                ["parentSessionId"] = change.Result["parentSessionId"]?.DeepClone(),
            };
        }
        if (action == "list")
        {
            var scope = OptionalString(args, "scope") ?? "current-agent";
            if (scope is not ("current-agent" or "all"))
                throw new InvalidDataException(
                    "session.scope must be \"current-agent\" or \"all\" for action=\"list\"."
                );
            var agent = scope == "all" ? null : source.Agent;
            var start = (int)
                Math.Clamp(Math.Truncate(OptionalNumber(args, "start") ?? 0), 0, int.MaxValue);
            var count = (int)
                Math.Clamp(Math.Truncate(OptionalNumber(args, "count") ?? 20), 0, 1000);
            var query = ListQuery(args);
            var visibility = SessionVisibilityFor(source);
            var (total, page) =
                query is null && visibility.Covers(agent)
                    ? CatalogMetadataOffset(start, count, agent)
                    : VisibleMetadata(visibility, query, start, count, agent);
            start = (int)Math.Min(start, total);
            var parent = source.Metadata().ParentSessionId;
            var list = new JsonObject { ["currentSession"] = source.Id };
            if (parent is not null)
                list["parentSession"] = parent;
            if (query is not null)
                list["query"] = query;
            list["total"] = total;
            list["start"] = start;
            list["sessions"] = new JsonArray(
                page.Select(row => (JsonNode?)SessionStatus.Row(row, source.Id)).ToArray()
            );
            if (page.Length > 0 && start + page.Length < total)
            {
                var next = new JsonObject { ["action"] = "list" };
                if (query is not null)
                    next["query"] = query;
                next["start"] = start + page.Length;
                if (args.ContainsKey("count"))
                    next["count"] = count;
                if (scope != "current-agent")
                    next["scope"] = scope;
                list["nextPage"] = CtlCommandText.For("session", next);
            }
            return list;
        }
        if (action != "status")
            throw new InvalidDataException(
                "session.action must be \"status\", \"list\", \"update-display-name\", \"update-parent\", \"archive\" or \"unarchive\"."
            );
        var requestedStatusId = OptionalSessionReference(args) ?? source.Id;
        var statusTarget = IsCurrentSessionReference(source, requestedStatusId)
            ? source
            : await GetExistingAsync(requestedStatusId);
        if (statusTarget is null)
            throw new InvalidDataException($"Session `{requestedStatusId}` not found.");
        var currentCwd = statusTarget.Entry.WithState(state =>
            SessionWait.Text(state.AuthorityEnvelope["cwd"])
        );
        var meta = statusTarget.Metadata();
        var dto = statusTarget.BuildDto(meta);
        var summary = statusTarget.ContextSummary();
        var catalog = models.Capture();
        var leaf = catalog.All.Count == 0 ? null : catalog.Resolve(meta.Model);
        var children = administrator
            ? CatalogMetadataOffset(0, 10, parent: statusTarget.Id).Page
            : VisibleChildren(SessionVisibilityFor(source), statusTarget.Id, 10);
        var currentNode = SessionWait.Text(dto["currentNode"])!;
        var status = new JsonObject { ["sessionId"] = meta.Id };
        if (meta.DisplayName is not null)
            status["displayName"] = meta.DisplayName;
        status["agent"] = statusTarget.Agent;
        status["node"] = new JsonObject
        {
            ["id"] = currentNode,
            ["connected"] = NodeProviders.Connected(currentNode),
            ["type"] =
                currentNode == "master"
                    ? "master"
                    : SessionWait.Text(
                        NodeSummaries()
                            .OfType<JsonObject>()
                            .FirstOrDefault(node => SessionWait.Text(node["id"]) == currentNode)
                            ?["type"]
                    ) ?? "unknown",
        };
        status["agentDirectory"] = agents.AgentDirectory(statusTarget.Agent);
        // Without a Session cwd, commands start in the Node's default directory.
        if (currentCwd is string cwd && SessionGoal.Trim(cwd).Length > 0)
            status["cwd"] = SessionGoal.Trim(cwd);
        if (meta.ParentSessionId is not null)
            status["parentSessionId"] = meta.ParentSessionId;
        if (meta.Archived)
            status["archived"] = true;
        status["model"] = leaf?.Key ?? catalog.DefaultKey;
        // A null effort is unset, and a null effective effort is the leaf's default.
        status["effort"] = meta.Effort;
        status["effectiveEffort"] = dto["effectiveEffort"]?.DeepClone();
        status["allowedEfforts"] = new JsonArray(
            (leaf?.AllowedEfforts ?? HostModels.Efforts)
                .Select(value => (JsonNode?)JsonValue.Create(value))
                .ToArray()
        );
        status["defaultEffort"] = leaf is null ? "high" : leaf.DefaultEffort;
        if (Math.Max(0, meta.NextMessageSeq - 1) is > 0 and var latest)
            status["latestMessageSeq"] = latest;
        status["activeMessages"] = meta.MessageCount;
        status["tokenEstimate"] = summary.Estimate;
        status["contextLimit"] = leaf?.ContextLimit ?? catalog.PresentationContextLimit;
        status["images"] = summary.Images;
        if (summary.Images > 0 && leaf?.ImageInput == false)
            status["imagesSent"] = false;
        if (summary.Usage is { } usage)
        {
            var cached = SessionWait.Number(usage["cachedTokens"]) ?? 0;
            var input = SessionWait.Number(usage["inputTokens"]) ?? 0;
            var output = SessionWait.Number(usage["outputTokens"]) ?? 0;
            var last = new JsonObject
            {
                ["cachedTokens"] = cached,
                ["inputTokens"] = input,
                ["outputTokens"] = output,
            };
            if (SessionWait.Number(usage["reasoningTokens"]) is { } reasoning)
                last["reasoningTokens"] = reasoning;
            last["totalTokens"] = cached + input + output;
            if (SessionWait.Number(usage["cost"]) is double cost)
                last["cost"] = cost;
            status["lastUsage"] = last;
        }
        if (meta.LastMessageTime > 0)
            status["lastMessageAt"] = SessionStatus.Date(meta.LastMessageTime);
        status["compactThresholdTokens"] = dto["effectiveCompactThresholdTokens"]?.DeepClone();
        status["compactThresholdSource"] = summary.Threshold is > 0 ? "override" : "model-default";
        if (meta.Cost is double totalCost)
            status["totalCost"] = totalCost;
        // A null child model follows the current model; a null child effort is unset.
        status["childModel"] = meta.ChildModel;
        status["effectiveChildModel"] = dto["effectiveChildModelKey"]?.DeepClone();
        status["childEffort"] = meta.ChildEffort;
        status["effectiveChildEffort"] = dto["effectiveChildEffort"]?.DeepClone();
        status["runtime"] = SessionStatus.RuntimeFields(dto["runtimeState"]!.AsObject());
        if (meta.Busy)
            status["busy"] = true;
        status["recentChildren"] = new JsonArray(
            children.Select(row => (JsonNode?)SessionStatus.Row(row)).ToArray()
        );
        return status;
    }

    private bool IsCurrentSessionReference(SessionOwner source, string requested)
    {
        if (requested == source.Id)
            return true;
        return Catalog.Get(source.Id)?["aliases"] is JsonArray aliases
            && aliases.OfType<JsonNode>().Select(SessionCatalog.Text).Contains(requested);
    }

    private static string? OptionalSessionReference(JsonObject args)
    {
        if (args["sessionId"] is not JsonValue value || !value.TryGetValue<string>(out var raw))
            return null;
        var trimmed = SessionGoal.Trim(raw);
        return trimmed.Length == 0 ? null : trimmed;
    }

    internal (long Total, JsonObject[] Page) CatalogMetadataOffset(
        int start,
        int count,
        string? agent = null,
        string? parent = null
    )
    {
        var local = LocalProjections();
        var persistedLocal = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in local.Select(row => SessionCatalog.Text(row["id"])!).Chunk(200))
        foreach (var row in Catalog.GetMany(chunk))
            persistedLocal[SessionCatalog.Text(row["id"])!] = row;
        bool Scope(JsonObject row) =>
            (agent is null || SessionCatalog.Text(row["agent"]) == agent)
            && (parent is null || SessionCatalog.Text(row["parentSessionId"]) == parent);
        var relevant = local.Where(Scope).ToArray();
        var total =
            Catalog.Count(agent, parent)
            + relevant.Count(row => !persistedLocal.ContainsKey(SessionCatalog.Text(row["id"])!));
        start = (int)Math.Min(start, total);
        var offset = Math.Max(0, start - relevant.Length);
        var basis = Catalog.OffsetPage(count + 2 * relevant.Length + 1, offset, agent, parent);
        int Compare(JsonObject left, JsonObject right)
        {
            var order = (SessionCatalog.Number(right["meta"]?["lastMessageTime"]) ?? 0).CompareTo(
                SessionCatalog.Number(left["meta"]?["lastMessageTime"]) ?? 0
            );
            return order != 0
                ? order
                : SessionListQueries.CompareIds(
                    SessionCatalog.Text(left["id"])!,
                    SessionCatalog.Text(right["id"])!
                );
        }
        var removedBefore = persistedLocal.Values.Count(row =>
            Scope(row) && (basis.Length == 0 || Compare(row, basis[0]) < 0)
        );
        var unchangedBefore = offset - removedBefore;
        var candidates = CatalogPresentations(
                basis.Select(row => SessionCatalog.Text(row["id"])!).ToArray(),
                true
            )
            .Where(row =>
                (agent is null || SessionCatalog.Text(row["agent"]) == agent)
                && (parent is null || SessionCatalog.Text(row["parentSessionId"]) == parent)
            )
            .OrderByDescending(row => SessionWait.Number(row["lastMessageTime"]) ?? 0)
            .ThenBy(
                row => SessionWait.Text(row["id"])!,
                Comparer<string>.Create(SessionListQueries.CompareIds)
            )
            .ToArray();
        return (total, candidates.Skip(Math.Max(0, start - unchangedBefore)).Take(count).ToArray());
    }

    // The administrator's list (user `/session list`): every Session in scope, optionally
    // narrowed by the WebUI metadata matcher, in the ordinary list order.
    internal (long Total, JsonObject[] Page) AdministratorSessionList(
        string? query,
        int start,
        int count,
        string? agent
    )
    {
        query = query is null ? null : SessionCatalog.Trim(query);
        if (string.IsNullOrEmpty(query))
            return CatalogMetadataOffset(start, count, agent);
        var matcher = SessionListQueries.MetadataMatcher(query);
        var matches = ListPresentations()
            .Where(row => agent is null || SessionCatalog.Text(row["agent"]) == agent)
            .Where(row => matcher(row))
            .OrderByDescending(row => SessionWait.Number(row["lastMessageTime"]) ?? 0)
            .ThenBy(
                row => SessionWait.Text(row["id"])!,
                Comparer<string>.Create(SessionListQueries.CompareIds)
            )
            .ToArray();
        return (matches.Length, matches.Skip(start).Take(count).ToArray());
    }

    private static string? ListQuery(JsonObject args)
    {
        if (!args.ContainsKey("query"))
            return null;
        var query = SessionWait.Text(args["query"]) is string raw ? SessionCatalog.Trim(raw) : null;
        if (query is null || query.Length is < 1 or > 256)
            throw new InvalidDataException("session.query must contain 1 to 256 characters.");
        return query;
    }

    // Filtered list: the listed Sessions in scope, optionally narrowed by the same metadata
    // matcher as WebUI search, in the ordinary list order and offset. When only the caller, its
    // parent, its children and Sessions a rule names can be listed, only those are read;
    // otherwise the scope is scanned like a keyword search.
    private (long Total, JsonObject[] Page) VisibleMetadata(
        SessionListVisibility visibility,
        string? query,
        int start,
        int count,
        string? agent
    )
    {
        // Sessions outside the caller's Agent can be listed beyond the explicit set only when
        // the other-Agent class admits; otherwise the caller's Agent rows and that set suffice.
        var candidates =
            !visibility.Broad(agent) ? CatalogPresentations(visibility.ExplicitIds(), true)
            : agent is not null || !visibility.Broad(null, sameAgent: false)
                ? CatalogPresentations(
                    Catalog
                        .OffsetPage(
                            (int)Math.Min(Catalog.Count(visibility.Agent) + 1, int.MaxValue),
                            0,
                            visibility.Agent
                        )
                        .Select(row => SessionCatalog.Text(row["id"])!)
                        .Concat(visibility.ExplicitIds())
                        .ToArray(),
                    true
                )
            : ListPresentations();
        var matcher = query is null ? null : SessionListQueries.MetadataMatcher(query);
        var matches = candidates
            .Where(row => agent is null || SessionCatalog.Text(row["agent"]) == agent)
            .Where(row => matcher is null || matcher(row))
            .Where(visibility.Admits)
            .OrderByDescending(row => SessionWait.Number(row["lastMessageTime"]) ?? 0)
            .ThenBy(
                row => SessionWait.Text(row["id"])!,
                Comparer<string>.Create(SessionListQueries.CompareIds)
            )
            .ToArray();
        return (matches.Length, matches.Skip(start).Take(count).ToArray());
    }

    // Most recent children of a Session that the caller may list, filtered before the cap.
    private JsonObject[] VisibleChildren(SessionListVisibility visibility, string parent, int limit)
    {
        if (visibility.Covers(null))
            return CatalogMetadataOffset(0, limit, parent: parent).Page;
        var result = new List<JsonObject>();
        for (var start = 0; result.Count < limit; start += 50)
        {
            var (total, page) = CatalogMetadataOffset(start, 50, parent: parent);
            result.AddRange(page.Where(visibility.Admits).Take(limit - result.Count));
            if (page.Length == 0 || start + 50 >= total)
                break;
        }
        return result.ToArray();
    }

    private static double? OptionalNumber(JsonObject args, string name)
    {
        if (!args.ContainsKey(name))
            return null;
        var value = SessionWait.Number(args[name]);
        if (value is null || !double.IsFinite(value.Value))
            throw new InvalidDataException(name + " must be a finite number.");
        return value;
    }
}
