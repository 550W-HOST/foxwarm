using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.ToolScript;

// Background runs started by an attended call: the call waits like exec, then the run detaches.
internal sealed partial class MainToolScript
{
    internal const double DefaultDetachWait = 15;
    internal const double MaximumDetachWait = 60;
    internal const string ShutdownCancellation =
        "The Main server shut down before the run finished; it was not resumed.";

    private readonly Dictionary<string, (SessionEntry Owner, Task Settled)> detached = new(
        StringComparer.Ordinal
    );
    private volatile bool detachedClosing;

    /// <summary>
    /// Waits for one background segment up to its time limit. A segment that finishes, pauses
    /// or fails in time returns its ordinary result. Otherwise the call returns the run ID and
    /// the segment continues detached; its outcome reaches <see cref="ToolScriptDetach.Finished"/>.
    /// The lane is owned from entry and released when the segment settles.
    /// </summary>
    private async Task<JsonObject> RunDetachableAsync(
        JsonObject record,
        IDisposable lane,
        ToolScriptContext context,
        CancellationToken caller,
        string? warning,
        string? code,
        JsonNode? input,
        JsonObject? resume = null,
        byte[]? snapshot = null
    )
    {
        var detach = context.Detach!;
        var id = Required(record, "runId");
        var seconds = Number(record["timeoutSecs"], DefaultDetachWait);
        var activity = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate)
        {
            if (closing)
            {
                lane.Dispose();
                throw new InvalidOperationException("ToolScript host is closing.");
            }
            activities.Add(activity);
        }
        // Stop and Run queued end only this wait: the segment carries no caller token.
        var work = Task.Run(async () =>
        {
            using (lane)
                return await RunAsync(
                    record,
                    context,
                    CancellationToken.None,
                    code,
                    input,
                    resume,
                    snapshot,
                    detach
                );
        });
        var settled = ObserveDetachedAsync(id, work, detach, activity);
        using (var waiting = CancellationTokenSource.CreateLinkedTokenSource(caller))
        {
            var delay = Task.Delay(TimeSpan.FromSeconds(seconds), waiting.Token);
            await Task.WhenAny(work, delay);
            waiting.Cancel();
        }
        string printed;
        bool handedOff;
        lock (detach.Gate)
        {
            handedOff = !work.IsCompleted;
            printed = handedOff ? detach.Output?.Invoke() ?? "" : "";
            // Registered before the decision, so the settling observer always finds it.
            if (handedOff)
                lock (gate)
                    detached[id] = (context.Owner.Entry, settled);
            detach.Decide(handedOff);
        }
        if (!handedOff)
        {
            var result = await work;
            if (warning is not null)
                result["warning"] = warning;
            return result;
        }
        if (detachedClosing && active.TryGetValue(id, out var run))
            run.RequestCancel();
        var receipt = new JsonObject { ["status"] = "running", ["runId"] = id };
        if (printed.Length > 0)
            receipt["stdout"] = printed;
        receipt["notice"] =
            "The run continues in the background. A background-script-finished event reports its outcome; wait for it with waitExecIds, or stop it with `"
            + CtlCommandText.For("cancel_toolscript_run", new JsonObject { ["runId"] = id })
            + "`.";
        if (warning is not null)
            receipt["warning"] = warning;
        return receipt;
    }

    private async Task ObserveDetachedAsync(
        string id,
        Task<JsonObject> work,
        ToolScriptDetach detach,
        TaskCompletionSource activity
    )
    {
        try
        {
            JsonObject outcome;
            try
            {
                outcome = await work;
            }
            catch (Exception error)
            {
                outcome = new JsonObject
                {
                    ["status"] = "failed",
                    ["runId"] = id,
                    ["error"] = error.Message,
                };
            }
            if (await detach.Decision && detach.Finished is { } finished)
                try
                {
                    await finished(outcome);
                }
                catch (Exception error)
                {
                    MainLog.Diagnostic(
                        "ToolScript background completion was not delivered: "
                            + MainLog.SafeFailure(error),
                        failure: true
                    );
                }
        }
        finally
        {
            lock (gate)
            {
                detached.Remove(id);
                activities.Remove(activity);
            }
            activity.TrySetResult();
        }
    }

    /// <summary>True while the owner's run is executing detached from its starting call.</summary>
    internal bool IsDetached(string owner, string runId) =>
        active.TryGetValue(runId, out var run)
        && run.RecordOwner == owner
        && run.Context.Detach?.Detached == true;

    /// <summary>
    /// Cancels detached runs at the start of shutdown, including segments that detach later.
    /// They are not resumed after restart.
    /// </summary>
    internal void CancelDetached()
    {
        detachedClosing = true;
        foreach (var run in active.Values)
            if (run.Context.Detach?.Detached == true)
                run.RequestCancel();
    }

    /// <summary>Cancels the retiring owner's detached runs and waits for them to settle.</summary>
    internal async Task RetireDetachedAsync(SessionEntry owner)
    {
        Task[] pending;
        lock (gate)
            pending = detached
                .Where(pair => ReferenceEquals(pair.Value.Owner, owner))
                .Select(pair => pair.Value.Settled)
                .ToArray();
        foreach (var run in active.Values)
            if (
                ReferenceEquals(run.Context.Owner.Entry, owner)
                && run.Context.Detach?.Detached == true
            )
                run.RequestCancel();
        await Task.WhenAll(pending);
    }

    // Like exec's wait: a default of 15 seconds, at most 60.
    private static (double Seconds, string? Warning) DetachWait(JsonNode? value, double fallback)
    {
        var seconds = Timeout(value, fallback);
        if (seconds <= MaximumDetachWait)
            return (seconds, null);
        return (
            MaximumDetachWait,
            "WARNING: Requested timeoutSecs "
                + seconds.ToString(CultureInfo.InvariantCulture)
                + "s exceeds the 60s maximum for background mode; using 60s."
        );
    }
}
