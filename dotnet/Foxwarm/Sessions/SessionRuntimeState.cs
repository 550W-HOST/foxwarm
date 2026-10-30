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

    internal static JsonObject Build(
        SessionMetadata meta,
        bool toolActive,
        bool compacting,
        JsonObject? foreground = null,
        JsonObject? compaction = null
    )
    {
        if (meta.Runtime == ClaudeRuntimeState.Kind && meta.Busy && foreground is null)
            foreground = new JsonObject
            {
                ["state"] = "requesting-model",
                ["note"] = "Claude Code is running on Main.",
                ["active"] = new JsonObject
                {
                    ["phase"] = "external-runtime",
                    ["runtime"] = meta.Runtime,
                    ["modelKey"] = meta.Model,
                },
            };
        var result = Build(
            meta.Busy,
            meta.Stopping,
            meta.BusyStartedAt,
            meta.QueueLength,
            meta.Wait,
            toolActive,
            compacting,
            foreground,
            compaction,
            meta.LlmFailed
        );
        if (
            meta.Runtime == ClaudeRuntimeState.Kind
            && !meta.Busy
            && SessionWait.Text(meta.ExternalRuntime?["status"]) == "interrupted"
        )
            result["note"] = "Claude Code was interrupted. Continue or send a new message.";
        return result;
    }

    internal static JsonObject Build(
        bool busy,
        bool stopping,
        long? busyStartedAt,
        int queueLength,
        JsonObject? wait,
        bool toolActive,
        bool compacting,
        JsonObject? foreground = null,
        JsonObject? compaction = null,
        bool llmFailed = false
    )
    {
        var state = new JsonObject
        {
            ["state"] = busy
                ? toolActive
                    ? "running-tool"
                    : "requesting-model"
                : wait is not null
                    ? "waiting"
                    : llmFailed
                        ? "llm-failed"
                        : "idle",
            ["busy"] = busy,
            ["queueLength"] = queueLength,
        };
        if (compaction is not null)
            state["compaction"] = compaction.DeepClone();
        if (busy)
        {
            if (stopping)
                state["stopping"] = true;
            if (foreground is not null)
                foreach (var (key, value) in foreground)
                    state[key] = value?.DeepClone();
            if (!state.ContainsKey("since") && busyStartedAt is long since)
                state["since"] = since;
            if (foreground is null)
            {
                state["active"] = new JsonObject
                {
                    ["phase"] = compacting ? "compaction" : "unknown",
                };
                if (!compacting)
                    state["note"] = "Session is busy, but exact runtime phase is not available.";
            }
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
    private readonly object runtimeGate = new();
    private JsonObject? foregroundRuntime;
    private JsonObject? compactRuntime;

    internal JsonObject RuntimeSnapshot(SessionMetadata? meta = null)
    {
        meta ??= Metadata();
        lock (runtimeGate)
        {
            var runtime = SessionRuntimeState.Build(
                meta,
                ToolActive,
                Compacting,
                foregroundRuntime,
                compactRuntime
            );
            if (Processing)
                runtime["processing"] = true;
            return runtime;
        }
    }

    internal void BeginModelAttempt()
    {
        lock (runtimeGate)
            foregroundRuntime = new JsonObject
            {
                ["state"] = "requesting-model",
                ["since"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["active"] = new JsonObject { ["phase"] = "normal-turn" },
            };
        PublishStateChanged();
    }

    private Action CaptureForegroundRelease()
    {
        // Busy release retires only this foreground projection, never independent compaction or a successor.
        JsonObject? released;
        lock (runtimeGate)
            released = foregroundRuntime;
        return () =>
        {
            lock (runtimeGate)
                if (ReferenceEquals(foregroundRuntime, released))
                    foregroundRuntime = null;
        };
    }

    internal static JsonObject RetryProjection(Foxwarm.Models.ModelRetryEvent value) =>
        new()
        {
            ["attempt"] = Math.Max(1, value.Attempt),
            ["maxAttempts"] = Math.Max(1, value.MaxRetries),
            ["final"] = value.Final ? true : null,
            ["nextAttempt"] = value.Final ? null : value.Attempt + 1,
            ["retryAt"] = value.DelayMs is { } delay
                ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + Math.Max(0, delay)
                : null,
            ["reason"] = Bound(
                System.Text.RegularExpressions.Regex.Replace(value.Reason, @"\s+", " ").Trim(),
                1024
            ),
        };

    internal static string Bound(string value, int max) =>
        value.Length > max ? value[..max] : value;

    internal void SetModelRetry(Foxwarm.Models.ModelRetryEvent value)
    {
        lock (runtimeGate)
            if (foregroundRuntime is not null)
                foregroundRuntime["retry"] = RetryProjection(value);
        PublishStateChanged();
    }

    internal void SetCompactRuntime(
        string operationId,
        string phase,
        bool background,
        JsonObject? retry
    )
    {
        lock (runtimeGate)
            compactRuntime = new JsonObject
            {
                ["operationId"] = operationId,
                ["phase"] = phase,
                ["background"] = background,
                ["retry"] = retry?.DeepClone(),
            };
        PublishStateChanged();
    }

    internal void ClearCompactRuntime(string operationId)
    {
        lock (runtimeGate)
        {
            if (SessionWait.Text(compactRuntime?["operationId"]) != operationId)
                return;
            compactRuntime = null;
        }
        PublishStateChanged();
    }

    internal JsonObject? WaitSnapshot() =>
        Entry.WithState(state => SessionRuntimeState.WaitProjection(state.Meta));
}
