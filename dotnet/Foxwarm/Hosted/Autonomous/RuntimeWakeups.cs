using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Foxwarm.Timers;

namespace Foxwarm.Hosted.Autonomous;

// The generation owns this view. It is computed after producer settlement, while its fenced
// database is still open. The release transaction publishes the result along with the lease.
internal sealed class RuntimeWakeups(SessionManager sessions, TenantDb database)
{
    private PgLlmJournalStore? Journal => sessions.Journal as PgLlmJournalStore;

    internal bool Idle => sessions.MayUnload && !(Journal?.NextRetention <= DateTimeOffset.UtcNow + MainTimers.WakeLead);

    internal Task StopProducersAsync() => sessions.StopWakeupProducersAsync();

    internal async Task SettleAsync()
    {
        await sessions.SettleWakeupProducersAsync().ConfigureAwait(false);
        if (Journal is { } journal)
            await journal.StopRetentionAsync().ConfigureAwait(false);
    }

    internal async Task<WakeupDue?> NextDueAsync(CancellationToken token)
    {
        if (!sessions.Timers.Reconciled)
            throw new InvalidOperationException(sessions.Timers.Unavailable ?? "The scheduled occurrence was not reconciled.");
        var next = sessions.Timers.NextWakeup();
        var due = next is { } timer ? new WakeupDue(DateTimeOffset.FromUnixTimeMilliseconds(timer.DueAt), timer.Cron?.ToJson()) : null;
        void Earlier(DateTimeOffset? date)
        {
            if (date is { } value && (due is null || value < due.DueAt))
                due = new(value, due?.Occurrence);
        }
        // The persisted projection comes from authoritative wait snapshots; stopped in-memory
        // countdowns and legacy timer rows are not the restart authority.
        var wait = await database.ReadAsync(async (tx, ct) =>
        {
            using var command = tx.Command("""
                SELECT min((w->>'startedAt')::double precision + 1000 * (w->>'timeoutSeconds')::double precision)
                FROM (SELECT metadata_json::jsonb #> '{meta,wait}' AS w FROM session_catalog WHERE tenant_id=$1 AND wait_present) AS deadlines
                WHERE w ? 'id' AND jsonb_typeof(w->'startedAt')='number' AND jsonb_typeof(w->'timeoutSeconds')='number'
                """, database.TenantId);
            return await command.ExecuteScalarAsync(ct).ConfigureAwait(false) is double millis
                && millis <= DateTimeOffset.MaxValue.ToUnixTimeMilliseconds() && millis >= DateTimeOffset.MinValue.ToUnixTimeMilliseconds()
                    ? DateTimeOffset.FromUnixTimeMilliseconds((long)Math.Ceiling(millis)) : (DateTimeOffset?)null;
        }, token: token).ConfigureAwait(false);
        Earlier(wait);
        Earlier(Journal?.NextRetention);
        if (sessions.ManagedChannels?.ConfiguredPoller == true)
            Earlier(DateTimeOffset.UtcNow);
        return due;
    }

    internal Task ArmedAsync(CancellationToken token) => !sessions.Timers.Reconciled ? Task.CompletedTask : database.WriteAsync(
        (tx, ct) => tx.ExecuteAsync("SELECT foxwarm_clear_wakeup()", ct),
        new(Verify: tx => tx.Scalar("SELECT 1 FROM tenant_wakeups WHERE tenant_id=$1", database.TenantId) is null, Retryable: true), token);
}
