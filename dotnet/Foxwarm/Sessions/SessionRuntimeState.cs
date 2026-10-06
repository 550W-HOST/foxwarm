using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal static class SessionRuntimeState
{
    // Only the bounded declaration/status, never deferred message contents, belongs in presentation metadata.
    internal static JsonObject? WaitProjection(JsonObject meta)
    {
        var wait = SessionWait.Current(meta);
        if (
            wait is null
            || SessionWait.Strings(wait["waitAll"]?["sessions"]).Length == 0
                && SessionWait.Strings(wait["waitAnySessions"]).Length == 0
                && SessionWait.Strings(wait["waitExecIds"]).Length == 0
                && wait["waitForInput"]?.GetValue<bool>() != true
                && !(SessionWait.Number(wait["timeoutSeconds"]) > 0)
        )
            return null;
        var view = new JsonObject();
        foreach (
            var key in new[]
            {
                "id",
                "startedAt",
                "reason",
                "timeoutSeconds",
                "waitAnySessions",
                "waitExecIds",
                "waitForInput",
                "declarationVersion",
            }
        )
            if (wait.TryGetPropertyValue(key, out var value))
                view[key] = value?.DeepClone();
        if (wait["waitAll"] is JsonObject all)
            view["waitAll"] = new JsonObject
            {
                ["sessions"] = all["sessions"]?.DeepClone(),
                ["satisfiedSessions"] = all["satisfiedSessions"]?.DeepClone(),
            };
        return view;
    }

    internal static JsonObject Build(SessionMetadata meta, bool toolActive, bool compacting)
    {
        var wait = meta.Wait;
        var state = new JsonObject
        {
            ["state"] = meta.Busy
                ? toolActive
                    ? "running-tool"
                    : "requesting-model"
                : wait is not null
                    ? "waiting"
                    : "idle",
            ["busy"] = meta.Busy,
            ["queueLength"] = meta.QueueLength,
        };
        if (meta.Busy)
        {
            if (meta.BusyStartedAt is long since)
                state["since"] = since;
            if (compacting)
                state["active"] = new JsonObject { ["phase"] = "compaction" };
            return state;
        }
        if (wait is null)
            return state;
        var all = SessionWait.Strings(wait["waitAll"]?["sessions"]);
        var any = SessionWait.Strings(wait["waitAnySessions"]);
        var exec = SessionWait.Strings(wait["waitExecIds"]);
        var satisfied = SessionWait.Strings(wait["waitAll"]?["satisfiedSessions"]);
        var input = wait["waitForInput"]?.GetValue<bool>() == true;
        var details = new JsonObject
        {
            ["waitId"] = wait["id"]?.DeepClone(),
            ["waitingFor"] =
                all.Length > 0 ? "all-sessions"
                : any.Length > 0 ? "any-session"
                : exec.Length > 0 ? "exec"
                : input ? "input"
                : "fallback",
        };
        if (all.Length > 0)
        {
            details["waitAllSessions"] = wait["waitAll"]!["sessions"]?.DeepClone();
            details["satisfiedSessions"] = wait["waitAll"]!["satisfiedSessions"]?.DeepClone();
            details["pendingSessions"] = new JsonArray(
                all.Except(satisfied, StringComparer.Ordinal)
                    .Select(id => (JsonNode?)JsonValue.Create(id))
                    .ToArray()
            );
        }
        foreach (
            var key in new[]
            {
                "reason",
                "waitAnySessions",
                "waitExecIds",
                "waitForInput",
                "timeoutSeconds",
            }
        )
            if (wait.TryGetPropertyValue(key, out var value))
                details[key] = value?.DeepClone();
        if (SessionWait.Number(wait["startedAt"]) is double started)
        {
            state["since"] = started;
            if (SessionWait.Number(wait["timeoutSeconds"]) is double seconds)
                details["timeoutAt"] = started + seconds * 1000;
        }
        state["waiting"] = details;
        return state;
    }
}

internal sealed partial class SessionOwner
{
    internal JsonObject? WaitSnapshot() =>
        Entry.WithState(state => SessionRuntimeState.WaitProjection(state.Meta));
}
