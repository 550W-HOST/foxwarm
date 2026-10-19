using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task HandleTextControlAsync(ExternalChannelContext source, string command, string[] args, SessionOwner owner)
    {
        switch (command)
        {
            case "/compact":
                var keep = CommandArguments.CompactKeep(args);
                if (owner.Entry.HistoryMutation) throw new InvalidOperationException("Session history change is in progress.");
                if (owner.Entry.WithState(state => state.History.Count == 0)) { await source.Reply("History is empty."); return; }
                var compact = await owner.Compactor.StartManualAsync(keepPercent: keep);
                await source.Reply(compact.AlreadyPending ? "ℹ️ Compaction is already pending for this session."
                    : compact.Started ? compact.Background ? "🗜️ Compaction requested. It runs in parallel, so this chat can continue normally."
                        : "🗜️ Compaction started. This session will remain busy until awaited compaction finishes."
                    : "⚠️ This model disables background compaction. Stop or wait for the current run to finish, then request compaction again.");
                return;
            case "/stop":
                if (args.Length > 0)
                {
                    if (args.Length != 1 || args[0] != "compact") { await source.Reply("Usage: `/stop` or `/stop compact`"); return; }
                    var cancelled = await owner.Compactor.StopAsync();
                    await source.Reply(cancelled.TooLate ? "⚠️ Compaction had already committed; cancellation was too late."
                        : cancelled.Cancelled ? "🛑 Compaction cancelled. The current Session run was not stopped." : "⚠️ No active compaction to cancel.");
                    return;
                }
                if (!owner.Metadata().Busy) { await source.Reply("⚠️ Session is not currently running."); return; }
                if (owner.Compactor.Standalone) { await source.Reply("⚠️ No main Session run was stopped. Compaction continues; use `/stop compact` to cancel it."); return; }
                var queued = owner.Metadata().QueueLength > 0;
                var stopped = await owner.Registry.Control.StopAsync(owner.Id);
                await source.Reply((stopped.AbortedInFlight ? "🛑 Stop signal sent. The in-flight LLM request was aborted."
                    : "🛑 Stop signal sent. The session will stop after the current tool call completes.")
                    + (queued ? " Queued inputs will be added to history without being run." : ""));
                return;
            case "/dequeue":
                var dequeue = await runtime.DequeueAsync(owner.Id);
                await source.Reply(dequeue.QueuedItems == 0 ? "⚠️ No queued items to run."
                    : $"▶️ Running {dequeue.QueuedItems} queued item{(dequeue.QueuedItems > 1 ? "s" : "")}."
                        + (dequeue.StoppedCurrent ? dequeue.AbortedInFlight ? " The in-flight LLM request was aborted first." : " After the current tool call stops." : ""));
                return;
            case "/continue":
                if (owner.Metadata().Busy || owner.Processing) { await source.Reply("⚠️ Session is already running."); return; }
                if (owner.WaitSnapshot() is not null) { await source.Reply("⚠️ Session is waiting and cannot be continued manually."); return; }
                await source.Reply("▶️ Continuing interrupted turn...");
                var admitted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var running = owner.StartProcessing(retry: true, admitted: () => admitted.TrySetResult());
                await Task.WhenAny(admitted.Task, running);
                if (!admitted.Task.IsCompleted)
                {
                    try { await running; }
                    catch (SessionContinuationUnavailableException error) { await source.Reply("⚠️ " + error.Message); }
                }
                else _ = ObserveControlSettlementAsync(running);
                return;
        }
    }
}
