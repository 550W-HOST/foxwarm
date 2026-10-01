using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed record ChannelContext(string SessionId, string Platform);
internal sealed record ChannelMessage(string Text, string? ClientMessageId);
internal sealed record MessageRouteResult(int Status, object Value);

/// <summary>Supported Main-local ingress. Channels validate their wire DTO, this owner handles commands and admission.</summary>
internal sealed class MessageRouter(SessionRuntime runtime)
{
    public async Task<MessageRouteResult> HandleMessageAsync(ChannelContext context, ChannelMessage message)
    {
        var owner = runtime.Owner(context.SessionId) ?? throw new InvalidDataException("Session not found.");
        var command = message.Text.Trim();
        if (message.Text.TrimStart().StartsWith("/", StringComparison.Ordinal))
        {
            if (command == "/continue")
            {
                try { await runtime.ContinueAsync(context.SessionId); return new(200, new { success = true }); }
                catch (SessionContinuationUnavailableException error) { return new(409, new { error = error.Message, code = error.Code }); }
                catch (InvalidOperationException error) { return new(409, new { error = error.Message }); }
            }
            if (command == "/compact")
            {
                var result = await owner.Compactor.StartManualAsync();
                return result.Started || result.AlreadyPending
                    ? new(202, new { accepted = true, compacting = true, alreadyPending = result.AlreadyPending, runsInBackground = result.Background })
                    : new(409, new { error = "This model disables background compaction. Stop or wait for the current run to finish, then request compaction again." });
            }
            if (command == "/dequeue")
            {
                var result = await runtime.DequeueAsync(context.SessionId);
                return new(200, new { success = true, queuedItems = result.QueuedItems, stoppedCurrent = result.StoppedCurrent, abortedInFlight = result.AbortedInFlight });
            }
            if (command == "/stop compact")
            {
                var result = await owner.Compactor.StopAsync();
                return new(200, new { success = true, stoppedCompact = result.Cancelled, tooLate = result.TooLate });
            }
            if (command != "/stop") return new(422, new { error = "This Session command has not been implemented." });
            if (owner.Compactor.Standalone) return new(200, new { success = true, stoppedCurrent = false });
            if (!owner.Metadata().Busy) return new(200, new { success = true, stoppedCurrent = false });
            var stopped = await runtime.StopAsync(context.SessionId);
            return new(200, new { success = true, stoppedCurrent = stopped.StoppedCurrent });
        }
        await runtime.SubmitAndRunAsync(context.SessionId, QueueItem.UserText(message.Text, clientMessageId: message.ClientMessageId));
        return new(202, new { accepted = true, note = "Queue save attempted; durable completion is not guaranteed." });
    }
}
