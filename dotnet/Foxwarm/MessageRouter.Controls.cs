using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private static string? ControlAction(string command)
    {
        var words = command.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        return words.FirstOrDefault() switch
        {
            "/stop" => words.ElementAtOrDefault(1) == "compact" ? "cancel-compaction" : "stop",
            "/continue" => "continue",
            "/dequeue" => "dequeue",
            "/compact" => "compact",
            _ => null,
        };
    }

    private async Task<MessageRouteResult> HandleControlAsync(
        SessionOwner owner,
        string command,
        string requestId,
        string action
    )
    {
        MessageRouteResult Reply(
            string status,
            string message,
            string? details = null,
            int httpStatus = 200
        )
        {
            var feedback = new JsonObject
            {
                ["action"] = action,
                ["status"] = status,
                ["message"] = SessionOwner.Bound(message, 512),
            };
            if (!string.IsNullOrEmpty(details))
                feedback["details"] = SessionOwner.Bound(details, 4096);
            owner.Emit(
                SessionEventKind.ModelStream,
                new JsonObject
                {
                    ["type"] = "session-control-feedback",
                    ["requestId"] = requestId,
                    ["feedback"] = feedback,
                }
            );
            owner.PublishStateChanged();
            return new(
                httpStatus,
                new { accepted = status == "accepted", success = status != "error" }
            );
        }
        try
        {
            if (
                command
                is not ("/stop" or "/continue" or "/dequeue" or "/compact" or "/stop compact")
            )
                return Reply(
                    "error",
                    "This Session command has not been implemented.",
                    httpStatus: 422
                );
            switch (action)
            {
                case "stop":
                    if (!owner.Metadata().Busy)
                        return Reply("noop", "No active run");
                    if (owner.Compactor.Standalone)
                        return Reply(
                            "noop",
                            "Only compaction is running",
                            "Use Cancel compaction to stop it."
                        );
                    // Save/cancel admission retains the existing control contract; foreground settlement is independent.
                    await owner.Registry.Control.StopAsync(owner.Id);
                    return Reply("accepted", "Stop requested");
                case "continue":
                    if (owner.Metadata().Busy || owner.Processing)
                        return Reply("noop", "Session is already running");
                    if (owner.WaitSnapshot() is not null)
                        return Reply(
                            "noop",
                            "Session is waiting",
                            "Continue is available only for an interrupted turn."
                        );
                    var admitted = new TaskCompletionSource(
                        TaskCreationOptions.RunContinuationsAsynchronously
                    );
                    var processing = owner.StartProcessing(
                        retry: true,
                        admitted: () => admitted.TrySetResult()
                    );
                    await Task.WhenAny(admitted.Task, processing);
                    if (!admitted.Task.IsCompleted)
                    {
                        await processing;
                        return Reply("noop", "Continue unavailable");
                    }
                    _ = ObserveControlSettlementAsync(processing);
                    return Reply("accepted", "Continue requested");
                case "dequeue":
                    var dequeue = await owner.Registry.Control.DequeueAsync(owner.Id);
                    return dequeue.QueuedItems == 0
                        ? Reply("noop", "No queued messages")
                        : Reply("accepted", "Queued messages requested");
                case "compact":
                    if (owner.Entry.HistoryMutation)
                        return Reply(
                            "error",
                            "Session history change is in progress.",
                            httpStatus: 409
                        );
                    if (owner.Entry.WithState(state => state.History.Count == 0))
                        return Reply("noop", "History is empty");
                    var compact = await owner.Compactor.StartManualAsync();
                    return compact.AlreadyPending ? Reply("noop", "Compaction is already pending")
                        : compact.Started
                            ? Reply("accepted", "Compaction requested", httpStatus: 202)
                        : Reply(
                            "noop",
                            "Compaction requires an idle session",
                            "Background compaction is disabled for this model."
                        );
                case "cancel-compaction":
                    var requested = new TaskCompletionSource(
                        TaskCreationOptions.RunContinuationsAsynchronously
                    );
                    var stopping = owner.Compactor.StopAsync(() => requested.TrySetResult());
                    await Task.WhenAny(requested.Task, stopping);
                    if (requested.Task.IsCompleted)
                    {
                        _ = ObserveControlSettlementAsync(stopping);
                        return Reply("accepted", "Compaction cancellation requested");
                    }
                    var stopped = await stopping;
                    return Reply(
                        "noop",
                        stopped.TooLate ? "Compaction already applied" : "No active compaction"
                    );
            }
            throw new InvalidOperationException("Unknown Session control.");
        }
        catch (SessionContinuationUnavailableException error)
        {
            return Reply("noop", "Continue unavailable", error.Message);
        }
        catch (Exception error)
        {
            return Reply("error", "Could not apply Session control", error.Message, 409);
        }
    }

    private static async Task ObserveControlSettlementAsync(Task task)
    {
        // The owner already records and presents a run failure. Observe only the detached completion.
        try
        {
            await task;
        }
        catch { }
    }
}
