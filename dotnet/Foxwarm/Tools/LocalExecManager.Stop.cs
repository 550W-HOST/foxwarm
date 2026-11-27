using Foxwarm.Nodes;

namespace Foxwarm.Tools;

// Listing and stopping background commands on request. Ownership follows waitExecIds: the
// exact current Session lifetime of a tracked command whose completion is still outstanding.
// Stopping never replays or retries a command; its completion is delivered once through the
// ordinary reconciliation path and states that a stop was requested.
internal sealed partial class LocalExecManager
{
    internal sealed record RunningExec(
        string Id,
        string NodeId,
        string Command,
        long StartedAt,
        string? Cwd,
        string LogPath,
        bool StopRequested,
        string? Summary
    );

    internal enum StopOutcome
    {
        NotOwned,
        AlreadyRequested,
        Finished,
        Unsupported,
        Stopped,
        Killed,
        Ended,
        Unknown,
    }

    // Resolves a Provider backend whose Node declares exec-stop; null when it cannot stop.
    internal Func<
        string,
        string,
        CancellationToken,
        Task<ProviderExecBackend?>
    >? ResolveProviderStop { get; set; }

    // Called with the lifetime Session after a delivered or expired background command stops
    // being tracked, so presentation can drop it from the running count.
    internal Action<string>? Untracked { get; set; }

    internal RunningExec[] Running(string sessionId) =>
        pending
            .Values.Where(record =>
                record.Notify && resolveLifetime(record.SessionId) == sessionId
            )
            .OrderBy(record => record.StartedAt)
            .ThenBy(record => record.Id, StringComparer.Ordinal)
            .Select(record => new RunningExec(
                record.Id,
                record.NodeId,
                record.Command,
                record.StartedAt,
                record.Observation.Cwd ?? record.Cwd,
                record.LogPath,
                record.StopRequestedAt is not null,
                record.Summary
            ))
            .ToArray();

    internal async Task<(StopOutcome Outcome, string? Detail)> StopAsync(
        string sessionId,
        string execId,
        CancellationToken token
    )
    {
        if (
            !pending.TryGetValue(execId, out var record)
            || !record.Notify
            || resolveLifetime(record.SessionId) != sessionId
        )
            return (StopOutcome.NotOwned, null);
        if (record.StopRequestedAt is not null)
            return (StopOutcome.AlreadyRequested, null);
        ProviderExecBackend? provider = null;
        if (record.ProviderId is not null)
        {
            provider = ResolveProviderStop is null
                ? null
                : await ResolveProviderStop(record.ProviderId, record.NodeId, token);
            if (provider is null)
                return (StopOutcome.Unsupported, null);
        }
        if (
            await ReadStatusAsync(record) is not null
            || provider is null
                && !ExecStop.Running(checked((int)record.Pid!), record.ProcessStartTicks)
        )
            return (StopOutcome.Finished, null);
        var marked = record with { StopRequestedAt = Now() };
        var replaced = false;
        await TrackAsync(() =>
        {
            if (pending.TryGetValue(execId, out var current) && ReferenceEquals(current, record))
            {
                pending[execId] = marked;
                replaced = true;
            }
        });
        if (!replaced)
            return pending.TryGetValue(execId, out var current) && current.StopRequestedAt is not null
                ? (StopOutcome.AlreadyRequested, null)
                : (StopOutcome.Finished, null);
        try
        {
            if (provider is not null)
            {
                string state;
                try
                {
                    state = await provider.StopAsync(record.Reference!, ExecStop.Grace, token);
                }
                catch (Exception error)
                    when (error
                            is IOException
                                or InvalidOperationException
                                or OperationCanceledException
                                or System.Text.Json.JsonException
                    )
                {
                    return (StopOutcome.Unknown, error.Message);
                }
                return state switch
                {
                    "stopped" => (StopOutcome.Stopped, null),
                    "killed" => (StopOutcome.Killed, null),
                    _ => await UnmarkAsync(marked),
                };
            }
            return await ExecStop.StopAsync(
                    checked((int)record.Pid!),
                    record.ProcessStartTicks,
                    token: token
                ) switch
            {
                ExecStop.Outcome.Exited => (StopOutcome.Stopped, null),
                ExecStop.Outcome.Killed => (StopOutcome.Killed, null),
                ExecStop.Outcome.TreeEnded => (StopOutcome.Ended, null),
                _ => await UnmarkAsync(marked),
            };
        }
        finally
        {
            // Deliver the completion promptly instead of at the next periodic pass.
            _ = Task.Run(ReconcileNowAsync);
        }
    }

    // The command had already ended before any signal: its completion is not a stopped one.
    private async Task<(StopOutcome, string?)> UnmarkAsync(ExecRecord marked)
    {
        await TrackAsync(() =>
        {
            if (pending.TryGetValue(marked.Id, out var current) && ReferenceEquals(current, marked))
                pending[marked.Id] = marked with { StopRequestedAt = null };
        });
        return (StopOutcome.Finished, null);
    }
}
