using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Timers;

internal sealed partial class MainTimers
{
    private TimerRecord Classify(JsonObject row)
    {
        string? reason = null;
        var at = Number(row["at"]);
        var cron = Text(row["cron"]);
        var hasCron = cron is not null && SessionGoal.Trim(cron).Length > 0;
        if (
            Text(row["sessionId"]) is null
            || !TimerArguments.Script(row) && Text(row["message"]) is null
        )
            reason = "Unrecognized timer owner or message.";
        else if (
            row.ContainsKey("action") && Text(row["action"]) is not ("message" or "toolscript")
        )
            reason = "Unrecognized timer action.";
        else if ((at is not null) == hasCron)
            reason = "Unrecognized timer schedule.";
        else if (
            at is double absolute
            && (
                !double.IsFinite(absolute)
                || absolute < DateTimeOffset.MinValue.ToUnixTimeMilliseconds()
                || absolute > DateTimeOffset.MaxValue.ToUnixTimeMilliseconds()
            )
        )
            reason = "Unsupported absolute timer date.";
        if (reason is null && TimerArguments.Script(row))
        {
            try
            {
                if (row.ContainsKey("waitTimeoutId") || row.ContainsKey("waitTimeoutSeconds"))
                    throw new InvalidDataException("A wait timeout cannot execute ToolScript.");
                var normalized = new JsonObject();
                TimerArguments.PutAction(normalized, row);
            }
            catch (Exception error)
                when (error
                        is InvalidDataException
                            or ArgumentException
                            or System.Text.Json.JsonException
                            or Foxwarm.ToolScript.ToolScriptDataLimitException
                )
            {
                reason = "Unsupported ToolScript timer: " + error.Message;
            }
        }
        var record = new TimerRecord(row, reason);
        if (record.Internal)
        {
            if (
                hasCron
                || Flag(row["newSession"])
                || Text(row["waitTimeoutId"]) is not { Length: > 0 }
                || Number(row["waitTimeoutSeconds"]) is not double seconds
                || !double.IsFinite(seconds)
                || seconds <= 0
            )
                record.Reason = "Unrecognized internal wait relationship.";
            return record;
        }
        if (record.Reason is null && hasCron)
        {
            try
            {
                _ = new CronSchedule(cron!, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).Next();
            }
            catch (Exception error)
                when (error is InvalidDataException or ArgumentException or OverflowException)
            {
                record.Reason = "Unsupported cron schedule: " + error.Message;
            }
        }
        return record;
    }

    internal void Start()
    {
        TimerRecord[] items;
        lock (gate)
        {
            if (closed || running)
                return;
            if (unavailable is not null)
            {
                Console.Error.WriteLine("Timer startup: store unavailable; scheduling disabled.");
                return;
            }
            running = true;
            items = records.Values.ToArray();
        }
        foreach (var record in items)
            if (!record.Internal && record.Reason is null)
                Start(record);
        Console.WriteLine($"Timer startup: loaded={items.Length}, scheduled={items.Count(record => !record.Internal && record.Reason is null)}, inactive={items.Count(record => record.Internal || record.Reason is not null)}.");
    }

    private void Start(TimerRecord record)
    {
        var completion = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        long first;
        lock (gate)
        {
            if (
                !running
                || closed
                || record.Clock is not null
                || !records.TryGetValue(record.Id, out var current)
                || !ReferenceEquals(record, current)
            )
                return;
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            first = record.Cron
                ? new CronSchedule(Text(record.Row["cron"])!, now).Next()
                : checked((long)Math.Truncate(Number(record.Row["at"])!.Value));
            record.Next = first;
            record.Clock = completion.Task;
            clocks.Add(completion.Task);
        }
        // Neither registration's model turn nor its mutation/authorization scopes
        // belong to an independently scheduled invocation.
        using (ExecutionContext.SuppressFlow())
            _ = Task.Run(() => RunClockAsync(record, completion, first));
    }

    private async Task RunClockAsync(
        TimerRecord record,
        TaskCompletionSource completion,
        long first
    )
    {
        try
        {
            var row = record.Row;
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var cron = record.Cron ? new CronSchedule(Text(row["cron"])!, now) : null;
            var next = first;
            while (!record.StopSource.IsCancellationRequested)
            {
                lock (gate)
                    record.Next = next;
                var remaining = next - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                while (remaining > 0)
                {
                    await Task.Delay(
                        TimeSpan.FromMilliseconds(Math.Min(remaining, 86_400_000)),
                        record.StopSource.Token
                    );
                    remaining = next - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                }
                Task? predecessor;
                lock (gate)
                    predecessor =
                        TimerArguments.Script(row) && cron is null
                            ? scriptInvocations.GetValueOrDefault(record.Id)
                            : null;
                if (predecessor is not null)
                {
                    // An overdue once replacement waits for release, not a dropped clock.
                    await predecessor.WaitAsync(record.StopSource.Token);
                    continue;
                }
                var exhausted = false;
                if (cron is not null)
                {
                    try
                    {
                        next = new CronSchedule(
                            Text(row["cron"])!,
                            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                        ).Next();
                    }
                    catch (Exception error)
                        when (error
                                is InvalidDataException
                                    or ArgumentException
                                    or OverflowException
                        )
                    {
                        exhausted = true;
                        Report("Timer recurrence has no further occurrence: " + record.Id, error);
                    }
                }
                TaskCompletionSource? accepted = null;
                JsonObject? captured = null;
                lock (gate)
                {
                    if (
                        running
                        && !closed
                        && records.TryGetValue(record.Id, out var current)
                        && ReferenceEquals(current, record)
                        && !record.StopSource.IsCancellationRequested
                        && (
                            !TimerArguments.Script(row) || !scriptInvocations.ContainsKey(record.Id)
                        )
                    )
                    {
                        accepted = new(TaskCreationOptions.RunContinuationsAsynchronously);
                        deliveries.Add(accepted.Task);
                        if (TimerArguments.Script(row))
                            scriptInvocations.Add(record.Id, accepted.Task);
                        captured = record.Row;
                        record.Next = cron is null || exhausted ? null : next;
                    }
                }
                if (accepted is not null)
                    _ = FireAsync(record, captured!, accepted);
                if (cron is null || exhausted)
                    break;
            }
        }
        catch (OperationCanceledException) when (record.StopSource.IsCancellationRequested) { }
        catch (Exception error)
        {
            Report("Timer clock failed: " + record.Id, error);
        }
        finally
        {
            lock (gate)
                clocks.Remove(completion.Task);
            completion.TrySetResult();
        }
    }

    private async Task FireAsync(
        TimerRecord record,
        JsonObject captured,
        TaskCompletionSource accepted
    )
    {
        var firedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var delivered = false;
        try
        {
            try
            {
                if (BeforeDelivery is { } before)
                    await before(record.Id);
                var payload = (JsonObject)captured.DeepClone();
                payload["__timerFiredAt"] = firedAt;
                await deliver(payload);
                delivered = true;
            }
            catch (Exception error)
            {
                Report("Timer delivery failed: " + record.Id, error);
            }
            if (!record.Cron || delivered || TimerArguments.Script(captured))
            {
                await ChangeAsync(
                    null,
                    record,
                    candidate =>
                    {
                        lock (gate)
                            if (
                                !records.TryGetValue(record.Id, out var current)
                                || !ReferenceEquals(current, record)
                            )
                                return null;
                        var rows = candidate["timers"]!.AsArray();
                        var index = rows.Select((row, position) => (row, position))
                            .First(pair =>
                                pair.row is JsonObject item && Text(item["id"]) == record.Id
                            )
                            .position;
                        if (record.Cron)
                            rows[index]!["lastTriggeredAt"] = firedAt;
                        else
                            rows.RemoveAt(index);
                        return null;
                    },
                    acceptedCompletion: true
                );
            }
        }
        catch (Exception error)
        {
            Report("Timer completion save failed: " + record.Id, error);
        }
        finally
        {
            lock (gate)
            {
                deliveries.Remove(accepted.Task);
                if (scriptInvocations.GetValueOrDefault(record.Id) == accepted.Task)
                    scriptInvocations.Remove(record.Id);
            }
            accepted.TrySetResult();
        }
    }

    internal string[] InternalOwners()
    {
        lock (gate)
            return records
                .Values.Where(record => record.Internal && record.Reason is null)
                .Select(record => Text(record.Row["sessionId"])!)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
    }

    internal async Task ConsumeValidatedWaitAsync(string sessionId, string? waitId)
    {
        TimerRecord[] candidates;
        lock (gate)
            candidates = records
                .Values.Where(record =>
                    record.Internal
                    && record.Reason is null
                    && Text(record.Row["sessionId"]) == sessionId
                )
                .ToArray();
        foreach (var record in candidates)
        {
            // Matching, no canonical wait, and a different canonical wait ID are all
            // proven redundant/stale. No timer is armed; the canonical deadline wins.
            _ = waitId;
            try
            {
                await ChangeAsync(
                    null,
                    null,
                    candidate =>
                    {
                        lock (gate)
                            if (
                                !records.TryGetValue(record.Id, out var current)
                                || !ReferenceEquals(current, record)
                            )
                                return null;
                        var rows = candidate["timers"]!.AsArray();
                        for (var index = rows.Count - 1; index >= 0; index--)
                            if (rows[index] is JsonObject item && Text(item["id"]) == record.Id)
                                rows.RemoveAt(index);
                        return null;
                    }
                );
            }
            catch (Exception error)
            {
                Report("Legacy wait timer reconciliation failed: " + record.Id, error);
            }
        }
    }

    internal void StopFuture()
    {
        TimerRecord[] clocks;
        lock (gate)
        {
            closed = true;
            running = false;
            clocks = records.Values.ToArray();
        }
        foreach (var record in clocks)
            record.Stop();
    }

    public async ValueTask DisposeAsync()
    {
        StopFuture();
        Task[] tasks;
        lock (gate)
            tasks = clocks.Concat(deliveries).ToArray();
        await Task.WhenAll(tasks);
        await saveLane.WaitAsync();
        saveLane.Release();
    }

    internal static string TriggeredMessage(JsonObject timer)
    {
        static string Escape(string value) =>
            value
                .Replace("&", "&amp;", StringComparison.Ordinal)
                .Replace("\"", "&quot;", StringComparison.Ordinal)
                .Replace("<", "&lt;", StringComparison.Ordinal)
                .Replace(">", "&gt;", StringComparison.Ordinal);
        var fired = DateTimeOffset.FromUnixTimeMilliseconds(
            (long)Number(timer["__timerFiredAt"])!.Value
        );
        var local = fired.ToLocalTime();
        var cron =
            Text(timer["cron"]) is string expression && SessionGoal.Trim(expression).Length > 0;
        var body = Text(timer["message"]) ?? "";
        var time = local.ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture);
        time = time[..^3] + time[^2..];
        var open =
            $"<foxwarm-message type=\"timer\" timerId=\"{Escape(Text(timer["id"])!)}\" mode=\"{(cron ? "cron" : "once")}\" firedAt=\"{fired.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)}\" time=\"{time}\" hint=\"{(cron ? "Scheduled timer fired" : "Timer fired")}\">";
        return open + "\n" + (body.Length == 0 ? "" : body + "\n") + "</foxwarm-message>";
    }
}
