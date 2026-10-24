using System.Text.Json.Nodes;
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
    internal static string Runtime(JsonObject state)
    {
        var name = SessionWait.Text(state["state"]) ?? "idle";
        if (
            state["active"] is JsonObject active
            && SessionWait.Text(active["phase"]) == "compaction"
        )
            name += " (compaction)";
        if (state["waiting"] is JsonObject wait)
        {
            name += " (" + (SessionWait.Text(wait["waitingFor"]) ?? "waiting") + ")";
            if (SessionWait.Text(wait["reason"]) is string reason)
                name += "; reason: " + reason;
            if (SessionWait.Strings(wait["pendingSessions"]) is { Length: > 0 } pending)
                name += "; pending: " + string.Join(", ", pending);
            if (SessionWait.Strings(wait["waitExecIds"]) is { Length: > 0 } exec)
                name += "; exec: " + string.Join(", ", exec);
        }
        var queued = SessionWait.Number(state["queueLength"]) ?? 0;
        return "Session execution state: " + name + (queued > 0 ? "; queue: " + queued : "") + ".";
    }

    internal static string Date(double value) =>
        value == 0
            ? "never"
            : DateTimeOffset
                .FromUnixTimeMilliseconds((long)value)
                .UtcDateTime.ToString(
                    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                    System.Globalization.CultureInfo.InvariantCulture
                );

    internal static string Row(JsonObject dto, string? current = null) =>
        $"🤖 `{SessionWait.Text(dto["id"])}`"
        + (SessionWait.Text(dto["displayName"]) is { } name ? " (" + name + ")" : "")
        + (SessionWait.Text(dto["id"]) == current ? " **CURRENT**" : "")
        + $" - {SessionWait.Number(dto["messageCount"]) ?? 0} messages - {Runtime(dto["runtimeState"]!.AsObject())} - Last: {Date(SessionWait.Number(dto["lastMessageTime"]) ?? 0)}";

    internal static string Row(SessionOwner owner, SessionMetadata meta, string? current = null) =>
        $"🤖 `{meta.Id}`"
        + (meta.DisplayName is null ? "" : " (" + meta.DisplayName + ")")
        + (meta.Id == current ? " **CURRENT**" : "")
        + $" - {meta.MessageCount} messages - {Runtime(owner.BuildDto(meta)["runtimeState"]!.AsObject())} - Last: {Date(meta.LastMessageTime)}";
}

internal sealed partial class SessionManager
{
    internal async Task<JsonObject> ObserveAsync(SessionOwner source, string name, JsonObject args)
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
                        "The active range changed structurally. Read a fresh page: view_session("
                        + EcmaJson.Stringify(new JsonObject { ["sessionId"] = targetId })
                        + ")",
                };
            return Output(renderer.RenderLive(targetId, page, args));
        }
        Keys(
            args,
            ["action", "start", "count", "scope", "sessionId", "name", "parentSessionId"],
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
        if (action == "update-parent")
        {
            if (AgentIsolated(source.Agent))
                throw new InvalidDataException(
                    "Isolated session cannot use session parent update tool."
                );
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
            var (total, page) = CatalogMetadataOffset(start, count, agent);
            start = (int)Math.Min(start, total);
            if (total == 0)
                return Output("No sessions found.");
            if (page.Length == 0)
                return Output(
                    $"No sessions found in the requested range. Total sessions: {total}."
                );
            var parent = source.Metadata().ParentSessionId;
            return Output(
                $"Current session: `{source.Id}`\n"
                    + (parent is null ? "" : $"Parent session: `{parent}`\n")
                    + $"\nFound {total} session(s). Showing {start + 1}-{start + page.Length}."
                    + (
                        start + page.Length < total
                            ? $" Use `start: {start + page.Length}` to see the next page."
                            : ""
                    )
                    + "\n\n"
                    + string.Join('\n', page.Select(row => SessionStatus.Row(row, source.Id)))
                    + "\n"
            );
        }
        if (action != "status")
            throw new InvalidDataException(
                "session.action must be \"status\", \"list\", \"update-display-name\", or \"update-parent\"."
            );
        var requestedStatusId = OptionalSessionReference(args) ?? source.Id;
        if (AgentIsolated(source.Agent) && !IsCurrentSessionReference(source, requestedStatusId))
            throw new InvalidDataException(
                "Isolated session can only use session status for its current session."
            );
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
        var (_, children) = CatalogMetadataOffset(0, 10, parent: statusTarget.Id);
        var currentNode = SessionWait.Text(dto["currentNode"])!;
        var isolated = AgentIsolated(statusTarget.Agent);
        var usage = summary.Usage;
        var cached = SessionWait.Number(usage?["cachedTokens"]) ?? 0;
        var input = SessionWait.Number(usage?["inputTokens"]) ?? 0;
        var output = SessionWait.Number(usage?["outputTokens"]) ?? 0;
        var usageText = usage is null
            ? "none"
            : $"cached={cached:N0}, input={input:N0}, output={output:N0}"
                + (
                    SessionWait.Number(usage["reasoningTokens"]) is { } reasoning
                        ? $" (reasoning={reasoning:N0})"
                        : ""
                )
                + $", total={cached + input + output:N0}"
                + (
                    SessionWait.Number(usage["cost"]) is double cost
                        ? $", estimated cost={ModelUsageCost.FormatUsd(cost)}"
                        : ""
                );
        return Output(
            "📊 *Session Status*\n\n"
                + $"- session id: `{meta.Id}`\n- name: {meta.DisplayName ?? "unset"}\n- agent id/name: `{statusTarget.Agent}`\n- current node: `{currentNode}` (connected={(NodeProviders.Connected(currentNode) ? "true" : "false")}, type={(currentNode == "master" ? "master" : NodeSummaries().OfType<JsonObject>().FirstOrDefault(node => SessionWait.Text(node["id"]) == currentNode)?["type"]?.GetValue<string>() ?? "unknown")}){(isolated ? " (isolated)" : "")}\n- agent directory: `{agents.AgentDirectory(statusTarget.Agent)}`\n- current cwd: {(currentCwd is string cwd && SessionGoal.Trim(cwd).Length > 0 ? $"`{SessionGoal.Trim(cwd)}`" : $"not set (defaults to current node agent directory; master: `{agents.AgentDirectory(statusTarget.Agent)}`)")}\n"
                + (
                    meta.ParentSessionId is null
                        ? ""
                        : $"- parent session id: `{meta.ParentSessionId}`\n"
                )
                + (meta.Archived ? "- 📦 archived\n" : "")
                + $"- model: `{leaf?.Key ?? catalog.DefaultKey}`\n- effort: raw={meta.Effort ?? "unset"}, effective={(SessionWait.Text(dto["effectiveEffort"]) ?? "per-leaf default")}, allowed={string.Join('|', leaf?.AllowedEfforts ?? HostModels.Efforts)}, default={(leaf is null ? "high" : leaf.DefaultEffort)}\n"
                + $"- messages: {meta.MessageCount}\n- token estimate: ~{summary.Estimate} / {leaf?.ContextLimit ?? catalog.PresentationContextLimit}\n- images: {summary.Images}\n- last usage: {usageText}\n- last message: {SessionStatus.Date(meta.LastMessageTime)}\n- auto-compact threshold: ~{dto["effectiveCompactThresholdTokens"]} tokens ({(summary.Threshold is > 0 ? "override" : "model default")})\n"
                + (
                    meta.Cost is double totalCost
                        ? $"- total estimated cost: {ModelUsageCost.FormatUsd(totalCost)}\n"
                        : ""
                )
                + $"- child model: raw={meta.ChildModel ?? "follow current"}, effective={dto["effectiveChildModelKey"]}; child effort: raw={meta.ChildEffort ?? "unset"}, effective={dto["effectiveChildEffort"]}\n"
                + $"- runtime state: {SessionStatus.Runtime(dto["runtimeState"]!.AsObject())}\n"
                + (meta.Busy ? "- busy: yes\n" : "")
                + (meta.QueueLength > 0 ? $"- queue: {meta.QueueLength}\n" : "")
                + "\nRecent child sessions (max 10):"
                + (
                    children.Length == 0
                        ? " none\n"
                        : "\n"
                            + string.Join('\n', children.Select(row => SessionStatus.Row(row)))
                            + "\n"
                )
        );
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
