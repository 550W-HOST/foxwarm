using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal sealed partial class LocalExecManager
{
    private async Task<JsonObject?> WaitAsync(
        ExecRecord record,
        double seconds,
        CancellationToken stop,
        CancellationToken hardCancellation
    )
    {
        var clock = Stopwatch.StartNew();
        using var wake = CancellationTokenSource.CreateLinkedTokenSource(stop, hardCancellation);
        while (clock.Elapsed.TotalSeconds < seconds)
        {
            if (!pending.ContainsKey(record.Id))
                return null;
            if (record.ProviderId is null)
            {
                var status = await ReadStatusAsync(record); // Native status wins over Stop at this observation.
                if (status is not null)
                    return status;
            }
            else
            {
                var query = ReadStatusAsync(record);
                var pause = DelayAsync(
                    Math.Min(250, Math.Max(0, seconds * 1000 - clock.Elapsed.TotalMilliseconds)),
                    wake.Token
                );
                if (await Task.WhenAny(query, pause) == query && await query is { } status)
                    return status;
            }
            if (wake.IsCancellationRequested)
                return null;
            await DelayAsync(
                Math.Min(250, Math.Max(0, seconds * 1000 - clock.Elapsed.TotalMilliseconds)),
                wake.Token
            );
        }
        return null;
    }

    private static async Task DelayAsync(double milliseconds, CancellationToken token)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(milliseconds), token);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    internal void StartReconciliation()
    {
        if (!IsSupported)
            return;
        lock (initializationGate)
        {
            if (reconcileTask is not null)
                return;
            reconcileStop = new CancellationTokenSource();
            reconcileTask = ReconcileLoopAsync(reconcileStop.Token);
        }
    }

    private async Task ReconcileLoopAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        try
        {
            while (await timer.WaitForNextTickAsync(token))
                await ReconcileNowAsync();
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    internal async Task ReconcileNowAsync()
    {
        await reconciliation.WaitAsync();
        try
        {
            if (!closing)
                await Task.WhenAll(
                    pending.Values.Where(record => record.Notify).Select(ReconcileRecordAsync)
                );
        }
        finally
        {
            reconciliation.Release();
        }
    }

    private async Task ReconcileRecordAsync(ExecRecord record)
    {
        try
        {
            var expired = Now() - record.StartedAt > 24 * 60 * 60 * 1000;
            var status = expired ? null : await ReadStatusAsync(record);
            if (!expired && status is null)
                return;
            var gate = completionGates.GetOrAdd(resolveLifetime(record.SessionId), _ => new(1, 1));
            await gate.WaitAsync();
            try
            {
                if (
                    closing
                    || !pending.TryGetValue(record.Id, out var current)
                    || !ReferenceEquals(record, current)
                )
                    return;
                if (!expired)
                    await notify(
                        record.SessionId,
                        record.Id,
                        ExecOutput.Completion(record.ToJson(), status!)
                    );
                await MutateAsync(() => Remove(record));
            }
            finally
            {
                gate.Release();
            }
        }
        catch (Exception)
        {
            // Failed observation, delivery or persistence retains the existing retry behavior.
        }
    }

    public async ValueTask DisposeAsync()
    {
        closing = true;
        if (registration is not null)
            await registration;
        reconcileStop?.Cancel();
        if (reconcileTask is not null)
            await reconcileTask;
        await reconciliation.WaitAsync();
        reconciliation.Release();
        await mutation.WaitAsync();
        mutation.Release();
        reconcileStop?.Dispose();
    }
}
