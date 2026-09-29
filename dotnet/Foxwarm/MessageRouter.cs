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
            if (command == "/compact")
                return await owner.Compactor.StartManualAsync()
                    ? new(202, new { accepted = true, compacting = true })
                    : new(409, new { error = "Compaction requires an idle Session." });
            if (command == "/stop compact")
            {
                var result = await owner.Compactor.StopAsync();
                return new(200, new { success = true, stoppedCompact = result.Cancelled, tooLate = result.TooLate });
            }
            if (command != "/stop") return new(422, new { error = "This Session command has not been implemented." });
            if (owner.Compactor.Active) return new(409, new { error = "Use /stop compact to cancel compaction only." });
            if (!owner.Metadata().Busy) return new(200, new { success = true, stoppedCurrent = false });
            var stopped = await runtime.StopAsync(context.SessionId);
            return new(200, new { success = true, stoppedCurrent = stopped.StoppedCurrent });
        }
        await runtime.SubmitAndRunAsync(context.SessionId, QueueItem.UserText(message.Text, clientMessageId: message.ClientMessageId));
        return new(202, new { accepted = true, note = "Queue save attempted; durable completion is not guaranteed." });
    }
}
