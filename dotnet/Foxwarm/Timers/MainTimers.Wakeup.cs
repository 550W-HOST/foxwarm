using System.Text.Json.Nodes;

namespace Foxwarm.Timers;

/// <summary>Hosted background callbacks may enter before publication, but never after retirement.</summary>
internal interface IProducerAdmission
{
    IDisposable? TryEnterProducer();
    CancellationToken StartupAborted { get; }
    Task AbortStartupAsync();
}

internal sealed record RuntimeSchedule(TimerOccurrence? Occurrence, IProducerAdmission Admission);

// Only a clean release nominates an occurrence. A cold start after an outage, without a
// nomination, uses the existing cron rule: the next instant strictly after now.
internal sealed record TimerOccurrence(string TimerId, long Generation, long ScheduledAt)
{
    internal JsonObject ToJson() => new() { ["timerId"] = TimerId, ["generation"] = Generation, ["scheduledAt"] = ScheduledAt };

    internal static TimerOccurrence? FromJson(JsonObject? row) =>
        row?["timerId"] is JsonValue id && id.TryGetValue<string>(out var timerId)
        && row["generation"] is JsonValue gen && gen.TryGetValue<long>(out var generation)
        && row["scheduledAt"] is JsonValue at && at.TryGetValue<long>(out var scheduledAt)
            ? new(timerId, generation, scheduledAt) : null;
}

internal sealed partial class MainTimers
{
    internal static readonly TimeSpan WakeLead = TimeSpan.FromMinutes(2);
    private TimerOccurrence? carried;
    private bool schedulesWakeups;
    private IProducerAdmission? producerAdmission;

    internal void EnableWakeups(TimerOccurrence? occurrence, IProducerAdmission? admission = null)
    {
        schedulesWakeups = true;
        carried = occurrence;
        producerAdmission = admission;
    }

    private static long ScheduleGeneration(JsonObject row) => row["scheduleGeneration"]?.GetValue<long>() ?? 0;

    // Read after producer settlement; Next is the clock's undelivered scheduled instant, not
    // Next(now), which could already have advanced past the occurrence during release.
    internal (long DueAt, TimerOccurrence? Cron)? NextWakeup()
    {
        lock (gate)
        {
            (long DueAt, TimerOccurrence? Cron)? earliest = null;
            foreach (var record in records.Values)
            {
                if (record.Internal || record.Paused || record.Reason is not null || record.Next is not long at)
                    continue;
                var due = at - (long)WakeLead.TotalMilliseconds;
                if (earliest is null || due < earliest.Value.DueAt
                    || due == earliest.Value.DueAt && record.Cron && (earliest.Value.Cron is null
                        || string.CompareOrdinal(record.Id, earliest.Value.Cron.TimerId) < 0))
                    earliest = (due, record.Cron ? new(record.Id, ScheduleGeneration(record.Row), at) : null);
            }
            return earliest;
        }
    }

    internal bool NeedsActiveRuntime(long now)
    {
        lock (gate)
            return unavailable is not null || deliveries.Count != 0 || NextWakeup()?.DueAt <= now;
    }
}
