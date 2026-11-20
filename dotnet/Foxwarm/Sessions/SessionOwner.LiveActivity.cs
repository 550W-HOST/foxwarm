using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// The exact owner keeps the live activity of its busy Session: committed history after the latest
// input plus the current model stream. Nothing here is persisted; after a restart the committed
// part is derived from history again.
internal sealed partial class SessionOwner
{
    private readonly object liveActivityGate = new();

    // The last message seq of the latest ended turn; earlier rows are not live evidence.
    private long? liveActivityFloor;
    private SessionHistory? liveActivityHistory;
    private long? liveActivityHistoryFloor;
    private LiveActivitySegment liveActivitySegment = LiveActivitySegment.Empty;
    private LiveActivityItem[] streamActivity = [];
    private double? streamActivityStartedAt;
    private readonly Dictionary<int, (string Text, string? Title)> streamReasoning = [];
    private readonly Dictionary<int, StreamCall> streamCalls = [];
    private string? publishedActivity;

    private sealed record StreamCall(string? Name, string Arguments, string? Summary);

    internal LiveActivity? LiveActivity(bool busy, string? runningCallId)
    {
        if (!busy)
            return null;
        var history = Entry.WithState(state => state.History.Snapshot());
        lock (liveActivityGate)
        {
            if (
                !ReferenceEquals(history, liveActivityHistory)
                || liveActivityFloor != liveActivityHistoryFloor
            )
            {
                liveActivitySegment = SessionLiveActivity.Segment(history, liveActivityFloor);
                liveActivityHistory = history;
                liveActivityHistoryFloor = liveActivityFloor;
            }
            return SessionLiveActivity.Select(
                liveActivitySegment,
                streamActivity,
                streamActivityStartedAt,
                runningCallId
            );
        }
    }

    private static string? RunningCallId(JsonObject runtime) =>
        SessionWait.Text(runtime["state"]) == "running-tool"
            ? SessionWait.Text(runtime["tool"]?["id"])
            : null;

    /// <summary>
    /// Publishes the runtime state when the live activity differs from the value this check last
    /// published. Streaming and history appends call it; runtime transitions publish anyway.
    /// </summary>
    internal void PublishActivityIfChanged()
    {
        if (Entry.Retired)
            return;
        var busy = Entry.WithState(state => state.Busy);
        string? running;
        lock (runtimeGate)
            running = foregroundRuntime is { } foreground ? RunningCallId(foreground) : null;
        var value = LiveActivity(busy, running)?.ToJson().ToJsonString();
        lock (liveActivityGate)
        {
            if (value == publishedActivity)
                return;
            publishedActivity = value;
        }
        PublishStateChanged();
    }

    // The turn ended: the next turn starts without activity, even without a new input (Continue).
    private void EndLiveActivity()
    {
        var last = Entry.WithState(state => state.NextMessageSeq - 1);
        lock (liveActivityGate)
        {
            liveActivityFloor = last;
            ResetStreamActivityLocked(null);
            publishedActivity = null;
        }
    }

    private void ResetStreamActivity(double? startedAt)
    {
        lock (liveActivityGate)
            ResetStreamActivityLocked(startedAt);
    }

    private void ResetStreamActivityLocked(double? startedAt)
    {
        streamActivity = [];
        streamActivityStartedAt = startedAt;
        streamReasoning.Clear();
        streamCalls.Clear();
    }

    /// <summary>
    /// Updates the live stream's items from the owner's raw progress, before any client throttle.
    /// Returns whether the items changed.
    /// </summary>
    private bool UpdateStreamActivity(ResponsesStreamProgress progress)
    {
        lock (liveActivityGate)
        {
            var ordered = new List<(int Order, LiveActivityItem Item)>();
            var groups = progress.Parts is { } parts
                ? parts
                    .Where(part => part.Kind == "reasoning")
                    .GroupBy(part => part.OutputIndex)
                    .Select(group =>
                        (
                            Order: group.Key,
                            Text: string.Join(
                                "\n",
                                group
                                    .OrderBy(part => part.SummaryIndex ?? 0)
                                    .Select(part => part.Text)
                                    .Where(text => !string.IsNullOrEmpty(text))
                            )
                        )
                    )
                    .ToArray()
                : [(Order: -1, Text: progress.Reasoning)];
            foreach (var (order, text) in groups)
            {
                if (!streamReasoning.TryGetValue(order, out var cached) || cached.Text != text)
                {
                    cached = (text, SessionLiveActivity.ReasoningTitle(text));
                    streamReasoning[order] = cached;
                }
                if (cached.Title is not null)
                    ordered.Add((order, new(true, cached.Title, null)));
            }
            foreach (var call in progress.ToolCalls)
            {
                var arguments = call.Arguments ?? "";
                streamCalls.TryGetValue(call.Index, out var cached);
                if (
                    cached is null
                    || cached.Name != call.Name
                    || cached.Summary is null && cached.Arguments != arguments
                )
                {
                    // A summary completes with a closing quote; appended text without one adds none.
                    var unchanged =
                        cached is not null
                        && cached.Name == call.Name
                        && arguments.StartsWith(cached.Arguments, StringComparison.Ordinal)
                        && !arguments.AsSpan(cached.Arguments.Length).Contains('"');
                    cached = new(
                        call.Name,
                        arguments,
                        unchanged ? null : StreamSummary(call.Name, arguments)
                    );
                    streamCalls[call.Index] = cached;
                }
                if (cached.Summary is not null)
                    ordered.Add((call.Index, new(false, cached.Summary, null)));
            }
            var items = ordered
                .OrderBy(entry => entry.Order)
                .Select(entry => entry.Item)
                .ToArray();
            if (items.SequenceEqual(streamActivity))
                return false;
            streamActivity = items;
            return true;
        }
    }

    private static string? StreamSummary(string? name, string arguments) =>
        name is "exec" or "run_script" or "ctl" or "call_tool"
        && SessionLiveActivity.PartialObject(arguments) is { } args
            ? ToolActivity.CaptionSummary(name, args)
            : null;
}
