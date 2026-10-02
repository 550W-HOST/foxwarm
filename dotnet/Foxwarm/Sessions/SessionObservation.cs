using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed record SessionMessagePage(double Start, int Total, long HistoryVersion, JsonObject Runtime, JsonObject[] Messages);
internal sealed partial class SessionOwner
{
    internal SessionMessagePage MessagePage(double? start, double? count) => Entry.WithState(state =>
    {
        var total = state.History.Count;
        var actualStart = start ?? (count is null ? Math.Max(0, total - 10) : 0);
        var actualCount = count ?? (start is null ? 10 : total - actualStart);
        if (actualStart < 0) actualStart = Math.Max(0, total + actualStart);
        actualStart = Math.Clamp(actualStart, 0, total); actualCount = Math.Min(actualCount, total - actualStart);
        var begin = (int)Math.Truncate(actualStart); var rawEnd = actualStart + actualCount;
        var end = (int)Math.Truncate(rawEnd < 0 ? Math.Max(0, total + rawEnd) : Math.Min(total, rawEnd));
        var rows = state.History.Skip(begin).Take(Math.Max(0, end - begin)).Select(row => (JsonObject)row.DeepClone()).ToArray();
        var metadata = Metadata();
        return new SessionMessagePage(actualStart, total, state.HistoryVersion, SessionRuntimeState.Build(metadata, toolActive, Compacting), rows);
    });
    internal (int Estimate, JsonObject? Usage, long? Threshold) ContextSummary() => Entry.WithState(state =>
    {
        var tokens = CompactCandidateBuilder.Tokens(SessionWait.Text(state.AuthorityEnvelope["persistentMemorySnapshot"]) ?? "");
        foreach (var row in state.History.Where(CompactCandidateBuilder.Visible))
            foreach (var part in (row["parts"] as JsonArray)?.OfType<JsonObject>() ?? [])
            {
                foreach (var key in new[] { "system", "text", "thinking" }) tokens += CompactCandidateBuilder.Tokens(SessionWait.Text(part[key]) ?? "");
                if (part["functionCall"] is JsonObject call) tokens += CompactCandidateBuilder.Tokens(SessionWait.Text(call["name"]) ?? "")
                    + CompactCandidateBuilder.Tokens(SessionWait.Text(call["rawArgsText"]) ?? (call["args"] is null ? "{}" : EcmaJson.Stringify(call["args"]!)));
                if (part["functionResponse"] is JsonObject response) tokens += CompactCandidateBuilder.Tokens(SessionWait.Text(response["name"]) ?? "")
                    + CompactCandidateBuilder.Tokens(response["response"] is null ? "{}" : EcmaJson.Stringify(response["response"]!));
            }
        return (tokens, (state.AuthorityEnvelope["stats"] as JsonObject)?["lastUsage"] is JsonObject usage ? (JsonObject)usage.DeepClone() : null, CompactCandidateBuilder.Number(state.AuthorityEnvelope["compactThresholdTokens"]));
    });
}

internal static class SessionStatus
{
    internal static string Runtime(JsonObject state)
    {
        var name = SessionWait.Text(state["state"]) ?? "idle";
        if (state["active"] is JsonObject active && SessionWait.Text(active["phase"]) == "compaction") name += " (compaction)";
        if (state["waiting"] is JsonObject wait)
        {
            name += " (" + (SessionWait.Text(wait["waitingFor"]) ?? "waiting") + ")";
            if (SessionWait.Text(wait["reason"]) is string reason) name += "; reason: " + reason;
            if (SessionWait.Strings(wait["pendingSessions"]) is { Length: > 0 } pending) name += "; pending: " + string.Join(", ", pending);
            if (SessionWait.Strings(wait["waitExecIds"]) is { Length: > 0 } exec) name += "; exec: " + string.Join(", ", exec);
        }
        var queued = SessionWait.Number(state["queueLength"]) ?? 0;
        return "Session execution state: " + name + (queued > 0 ? "; queue: " + queued : "") + ".";
    }
    internal static string Date(double value) => value == 0 ? "never" : DateTimeOffset.FromUnixTimeMilliseconds((long)value).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
    internal static string Row(JsonObject dto, string? current = null) => $"🤖 `{SessionWait.Text(dto["id"])}`"
        + (SessionWait.Text(dto["displayName"]) is { } name ? " (" + name + ")" : "") + (SessionWait.Text(dto["id"]) == current ? " **CURRENT**" : "")
        + $" - {SessionWait.Number(dto["messageCount"]) ?? 0} messages - {Runtime(dto["runtimeState"]!.AsObject())} - Last: {Date(SessionWait.Number(dto["lastMessageTime"]) ?? 0)}";
    internal static string Row(SessionOwner owner, SessionMetadata meta, string? current = null) => $"🤖 `{meta.Id}`"
        + (meta.DisplayName is null ? "" : " (" + meta.DisplayName + ")") + (meta.Id == current ? " **CURRENT**" : "")
        + $" - {meta.MessageCount} messages - {Runtime(owner.BuildDto(meta)["runtimeState"]!.AsObject())} - Last: {Date(meta.LastMessageTime)}";
}

internal sealed partial class SessionManager
{
    internal async Task<JsonObject> ObserveAsync(SessionOwner source, string name, JsonObject args)
    {
        if (name == "set_goal")
        {
            Keys(args, ["goal", "remindEvery", "clear"], []);
            var clear = OptionalBool(args, "clear") == true;
            string? goal = null;
            if (!clear)
            {
                if (SessionWait.Text(args["goal"]) is not string text) throw new InvalidDataException("goal must be a string.");
                goal = SessionGoal.Trim(text); if (goal.Length == 0) goal = null;
            }
            await source.Entry.SaveLane.SetGoalAsync(goal, args["remindEvery"], args.ContainsKey("remindEvery"));
            return Output("ok");
        }
        if (name == "get_session_messages")
        {
            Keys(args, ["sessionId", "start", "count", "previewLength", "contentFilter", "includeRegex", "excludeRegex", "toolDetail"], ["sessionId"]);
            var targetId = RequiredString(args, "sessionId");
            var target = await GetExistingAsync(targetId); if (target is null) return Output($"Session `{targetId}` not found.");
            var page = target.MessagePage(OptionalNumber(args, "start"), OptionalNumber(args, "count"));
            return Output(new ContextPreviewRenderer(args).Render(targetId, SessionStatus.Runtime(page.Runtime), page.Total, page.Start, page.Messages));
        }
        Keys(args, ["action", "start", "count", "scope", "sessionId", "name"], []);
        var action = SessionWait.Text(args["action"]) is string raw && SessionGoal.Trim(raw).Length > 0 ? SessionGoal.Trim(raw).ToLowerInvariant() : "status";
        if (action == "update-display-name")
        {
            var targetId = OptionalString(args, "sessionId") ?? source.Id;
            var canonical = SessionCatalog.Text(Catalog.Resolve(targetId)["sessionId"]) ?? throw new InvalidDataException($"Session `{targetId}` not found.");
            if (SessionWait.Text(args["name"]) is not string rawName) throw new InvalidDataException("session.name is required for action=\"update-display-name\".");
            var next = SessionGoal.Trim(rawName); var previous = SessionCatalog.Text(Catalog.Get(canonical)?["displayName"]); var current = next.Length == 0 ? null : next;
            if (previous != current) await RenameAsync(canonical, current); var result = (Changed: previous != current, Previous: previous, Current: current);
            static string Format(string? value) => value is null ? "unset" : EcmaJson.Stringify(JsonValue.Create(value)!);
            return Output(result.Changed ? $"Session `{targetId}` display name changed from {Format(result.Previous)} to {Format(result.Current)}."
                : $"Session `{targetId}` display name unchanged (from {Format(result.Previous)} to {Format(result.Current)}).");
        }
        if (action == "list")
        {
            var scope = OptionalString(args, "scope") ?? "current-agent";
            if (scope is not ("current-agent" or "all")) throw new InvalidDataException("session.scope must be \"current-agent\" or \"all\" for action=\"list\".");
            var agent = scope == "all" ? null : source.Agent;
            var start = (int)Math.Clamp(Math.Truncate(OptionalNumber(args, "start") ?? 0), 0, int.MaxValue);
            var count = (int)Math.Clamp(Math.Truncate(OptionalNumber(args, "count") ?? 20), 0, 1000);
            var (total, page) = CatalogMetadataOffset(start, count, agent);
            start = (int)Math.Min(start, total);
            if (total == 0) return Output("No sessions found.");
            if (page.Length == 0) return Output($"No sessions found in the requested range. Total sessions: {total}.");
            var parent = source.Metadata().ParentSessionId;
            return Output($"Current session: `{source.Id}`\n" + (parent is null ? "" : $"Parent session: `{parent}`\n") + $"\nFound {total} session(s). Showing {start + 1}-{start + page.Length}."
                + (start + page.Length < total ? $" Use `start: {start + page.Length}` to see the next page." : "") + "\n\n" + string.Join('\n', page.Select(row => SessionStatus.Row(row, source.Id))) + "\n");
        }
        if (action != "status") throw new InvalidDataException("session.action must be \"status\", \"list\", or \"update-display-name\".");
        var meta = source.Metadata(); var dto = source.BuildDto(meta); var summary = source.ContextSummary(); var leaf = models.Resolve(meta.Model);
        var (_, children) = CatalogMetadataOffset(0, 10, parent: source.Id);
        return Output("📊 *Session Status*\n\n" + $"- session id: `{source.Id}`\n- name: {meta.DisplayName ?? "unset"}\n- agent id/name: `{source.Agent}`\n- local workspace: `{agents.AgentDirectory(source.Agent)}`\n"
            + (meta.ParentSessionId is null ? "" : $"- parent session id: `{meta.ParentSessionId}`\n") + $"- model: `{leaf.Key}`\n- effort: raw={meta.Effort ?? "unset"}, effective={(SessionWait.Text(dto["effectiveEffort"]) ?? "per-leaf default")}, allowed={string.Join('|', leaf.AllowedEfforts)}, default={leaf.DefaultEffort}\n"
            + $"- messages: {meta.MessageCount}\n- token estimate: ~{summary.Estimate} / {leaf.ContextLimit}\n- last usage: {(summary.Usage is null ? "none" : EcmaJson.Stringify(summary.Usage))}\n- last message: {SessionStatus.Date(meta.LastMessageTime)}\n- auto-compact threshold: ~{dto["effectiveCompactThresholdTokens"]} tokens ({(summary.Threshold is > 0 ? "override" : "model default")})\n"
            + $"- child model: raw={meta.ChildModel ?? "follow current"}, effective={dto["effectiveChildModelKey"]}; child effort: raw={meta.ChildEffort ?? "unset"}, effective={dto["effectiveChildEffort"]}\n"
            + $"- runtime state: {SessionStatus.Runtime(dto["runtimeState"]!.AsObject())}\n\nRecent child sessions (max 10):" + (children.Length == 0 ? " none\n" : "\n" + string.Join('\n', children.Select(row => SessionStatus.Row(row))) + "\n"));
    }
    private (long Total, JsonObject[] Page) CatalogMetadataOffset(int start, int count, string? agent = null, string? parent = null)
    {
        var local = LocalProjections(); var persistedLocal = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in local.Select(row => SessionCatalog.Text(row["id"])!).Chunk(200)) foreach (var row in Catalog.GetMany(chunk)) persistedLocal[SessionCatalog.Text(row["id"])!] = row;
        bool Scope(JsonObject row) => (agent is null || SessionCatalog.Text(row["agent"]) == agent) && (parent is null || SessionCatalog.Text(row["parentSessionId"]) == parent);
        var relevant = local.Where(Scope).ToArray(); var total = Catalog.Count(agent, parent) + relevant.Count(row => !persistedLocal.ContainsKey(SessionCatalog.Text(row["id"])!));
        start = (int)Math.Min(start, total); var offset = Math.Max(0, start - relevant.Length);
        var basis = Catalog.OffsetPage(count + 2 * relevant.Length + 1, offset, agent, parent);
        int Compare(JsonObject left, JsonObject right)
        {
            var order = (SessionCatalog.Number(right["meta"]?["lastMessageTime"]) ?? 0).CompareTo(SessionCatalog.Number(left["meta"]?["lastMessageTime"]) ?? 0);
            return order != 0 ? order : SessionListQueries.CompareIds(SessionCatalog.Text(left["id"])!, SessionCatalog.Text(right["id"])!);
        }
        var removedBefore = persistedLocal.Values.Count(row => Scope(row) && (basis.Length == 0 || Compare(row, basis[0]) < 0));
        var unchangedBefore = offset - removedBefore;
        var candidates = CatalogPresentations(basis.Select(row => SessionCatalog.Text(row["id"])!).ToArray(), true)
            .Where(row => (agent is null || SessionCatalog.Text(row["agent"]) == agent) && (parent is null || SessionCatalog.Text(row["parentSessionId"]) == parent))
            .OrderByDescending(row => SessionWait.Number(row["lastMessageTime"]) ?? 0).ThenBy(row => SessionWait.Text(row["id"])!, Comparer<string>.Create(SessionListQueries.CompareIds)).ToArray();
        return (total, candidates.Skip(Math.Max(0, start - unchangedBefore)).Take(count).ToArray());
    }
    private static double? OptionalNumber(JsonObject args, string name)
    {
        if (!args.ContainsKey(name)) return null;
        var value = SessionWait.Number(args[name]);
        if (value is null || !double.IsFinite(value.Value)) throw new InvalidDataException(name + " must be a finite number.");
        return value;
    }
}
