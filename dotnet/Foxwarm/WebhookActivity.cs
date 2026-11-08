using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal enum WebhookHandlerAdmission
{
    Queued,
    Duplicate,
    Full,
    Closed,
}

/// <summary>
/// Main-process webhook state per identity: recent verified deliveries for System › Webhooks
/// and the serialized ToolScript handler lanes. Nothing here is persisted; a restart forgets
/// history, pending handler runs and handler duplicate receipts.
/// </summary>
internal sealed class WebhookActivity
{
    internal const int HistoryLimit = 20;
    internal const int PendingLimit = 32;
    private const int ReceiptLimit = 64;
    private const int ErrorLimit = 500;

    private readonly object gate = new();
    private readonly Dictionary<string, Lane> lanes = new(StringComparer.Ordinal);
    private bool closed;

    /// <summary>Raised after history, handler state or webhook configuration changes.</summary>
    internal event Action? Changed;

    private sealed class Lane
    {
        internal readonly LinkedList<JsonObject> History = new();
        internal readonly Queue<(JsonObject Entry, Func<Task<JsonObject?>> Run)> Pending = new();
        internal readonly LinkedList<string> Receipts = new();
        internal readonly HashSet<string> ReceiptSet = new(StringComparer.Ordinal);
        internal Task? Worker;
        internal int Unauthorized;
        internal long LastUnauthorizedAt;
    }

    internal void Notify() => Changed?.Invoke();

    /// <summary>Records one verified delivery's result, newest first.</summary>
    internal void Record(
        string id,
        string outcome,
        int status,
        string? eventName = null,
        string? action = null,
        string? delivery = null,
        string? sessionId = null,
        string? error = null
    )
    {
        lock (gate)
            Add(LaneFor(id), Entry(outcome, status, eventName, action, delivery, sessionId, error));
        Notify();
    }

    /// <summary>Failed verification is counted, not listed, so it cannot displace real deliveries.</summary>
    internal void Unauthorized(string id)
    {
        lock (gate)
        {
            var lane = LaneFor(id);
            lane.Unauthorized++;
            lane.LastUnauthorizedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
        Notify();
    }

    /// <summary>
    /// Queues one handler run behind the identity's earlier runs. A delivery ID already
    /// queued, running or run by this process without failing is a duplicate.
    /// </summary>
    internal WebhookHandlerAdmission EnqueueHandler(
        string id,
        string? eventName,
        string? action,
        string? delivery,
        string sessionId,
        Func<Task<JsonObject?>> run
    )
    {
        lock (gate)
        {
            if (closed)
                return WebhookHandlerAdmission.Closed;
            var lane = LaneFor(id);
            if (delivery is not null && lane.ReceiptSet.Contains(delivery))
                return WebhookHandlerAdmission.Duplicate;
            if (lane.Pending.Count >= PendingLimit)
                return WebhookHandlerAdmission.Full;
            if (delivery is not null)
            {
                lane.Receipts.AddLast(delivery);
                lane.ReceiptSet.Add(delivery);
                while (lane.Receipts.Count > ReceiptLimit)
                {
                    lane.ReceiptSet.Remove(lane.Receipts.First!.Value);
                    lane.Receipts.RemoveFirst();
                }
            }
            var entry = Entry("queued", 202, eventName, action, delivery, sessionId, null);
            Add(lane, entry);
            lane.Pending.Enqueue((entry, run));
            lane.Worker ??= Task.Run(() => WorkAsync(lane));
        }
        Notify();
        return WebhookHandlerAdmission.Queued;
    }

    private async Task WorkAsync(Lane lane)
    {
        while (true)
        {
            JsonObject entry;
            Func<Task<JsonObject?>> run;
            lock (gate)
            {
                if (lane.Pending.Count == 0)
                {
                    lane.Worker = null;
                    return;
                }
                (entry, run) = lane.Pending.Dequeue();
                entry["outcome"] = "running";
            }
            Notify();
            JsonObject? outcome = null;
            string? failure = null;
            try
            {
                outcome = await run().ConfigureAwait(false);
            }
            catch (Exception error)
            {
                failure = error.Message;
            }
            lock (gate)
            {
                // Same result vocabulary as ToolScript timers.
                var status = SessionWait.Text(outcome?["status"]);
                entry["outcome"] =
                    failure is not null ? "failed"
                    : outcome is null ? "completed"
                    : status switch
                    {
                        "completed" => "completed",
                        "waiting" => "paused",
                        _ => "failed",
                    };
                if (SessionWait.Text(outcome?["runId"]) is { Length: > 0 } runId)
                    entry["runId"] = runId;
                failure ??=
                    SessionWait.Text(outcome?["error"])
                    ?? SessionWait.Text(outcome?["error"]?["message"]);
                if (SessionWait.Text(entry["outcome"]) == "failed")
                {
                    if (failure is { Length: > 0 })
                        entry["error"] = Bound(failure);
                    // A failed run can be retried by redelivering it.
                    if (
                        SessionWait.Text(entry["deliveryId"]) is { } delivery
                        && lane.ReceiptSet.Remove(delivery)
                    )
                        lane.Receipts.Remove(delivery);
                }
            }
            Notify();
        }
    }

    /// <summary>
    /// Stops new handler runs, fails pending ones and waits for running ones. Called by Session
    /// shutdown before ToolScript closes, as timers drain their accepted slice.
    /// </summary>
    internal async Task DrainAsync()
    {
        Task[] workers;
        lock (gate)
        {
            closed = true;
            foreach (var lane in lanes.Values)
            {
                while (lane.Pending.TryDequeue(out var pending))
                {
                    pending.Entry["outcome"] = "failed";
                    pending.Entry["error"] = "Foxwarm stopped before the handler ran.";
                }
            }
            workers = lanes.Values.Select(lane => lane.Worker).OfType<Task>().ToArray();
        }
        Notify();
        await Task.WhenAll(workers).ConfigureAwait(false);
    }

    /// <summary>History and handler state of one identity, for the administrator status view.</summary>
    internal JsonObject Status(string id)
    {
        lock (gate)
        {
            if (!lanes.TryGetValue(id, out var lane))
                return new JsonObject
                {
                    ["pending"] = 0,
                    ["unauthorized"] = 0,
                    ["deliveries"] = new JsonArray(),
                };
            var status = new JsonObject
            {
                ["pending"] = lane.Pending.Count,
                ["unauthorized"] = lane.Unauthorized,
                ["deliveries"] = new JsonArray(
                    lane.History.Select(entry => (JsonNode)entry.DeepClone()).ToArray()
                ),
            };
            if (lane.Unauthorized > 0)
                status["lastUnauthorizedAt"] = lane.LastUnauthorizedAt;
            return status;
        }
    }

    /// <summary>The target Session of a run still listed in the identity's recent deliveries.</summary>
    internal string? RunOwner(string id, string runId)
    {
        lock (gate)
            return lanes.TryGetValue(id, out var lane)
                ? lane
                    .History.Where(entry => SessionWait.Text(entry["runId"]) == runId)
                    .Select(entry => SessionWait.Text(entry["sessionId"]))
                    .FirstOrDefault()
                : null;
    }

    /// <summary>Forgets idle state of identities that are no longer configured.</summary>
    internal void Retain(IReadOnlySet<string> configured)
    {
        lock (gate)
            foreach (var id in lanes.Keys.ToArray())
                if (!configured.Contains(id) && lanes[id] is { Worker: null, Pending.Count: 0 })
                    lanes.Remove(id);
    }

    private Lane LaneFor(string id)
    {
        if (!lanes.TryGetValue(id, out var lane))
            lanes[id] = lane = new Lane();
        return lane;
    }

    private static void Add(Lane lane, JsonObject entry)
    {
        lane.History.AddFirst(entry);
        while (lane.History.Count > HistoryLimit)
            lane.History.RemoveLast();
    }

    private static JsonObject Entry(
        string outcome,
        int status,
        string? eventName,
        string? action,
        string? delivery,
        string? sessionId,
        string? error
    )
    {
        var entry = new JsonObject
        {
            ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["outcome"] = outcome,
            ["status"] = status,
        };
        if (eventName is not null)
            entry["event"] = eventName;
        if (action is not null)
            entry["action"] = action;
        if (delivery is not null)
            entry["deliveryId"] = delivery;
        if (sessionId is not null)
            entry["sessionId"] = sessionId;
        if (error is not null)
            entry["error"] = Bound(error);
        return entry;
    }

    private static string Bound(string text) =>
        text.Length > ErrorLimit ? text[..ErrorLimit] : text;
}
