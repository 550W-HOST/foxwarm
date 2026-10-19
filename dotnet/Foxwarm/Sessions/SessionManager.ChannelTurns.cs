using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Channels;
using Foxwarm.Images;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private readonly object channelTurnGate = new();
    private readonly Dictionary<SessionOwner, ChannelTurn> channelTurns = new();

    private sealed class ChannelTurn
    {
        internal readonly string Id = Guid.NewGuid().ToString("N");
        internal bool Finalized;
        internal bool Stopping;
    }

    private IEnumerable<(
        string Target,
        string Conversation,
        RegisteredChannel Channel
    )> AutomaticTargets(string id)
    {
        foreach (
            var (target, binding) in deletionChannels.ReadForDelivery()["channels"]!.AsObject()
        )
        {
            if (
                SessionWait.Text(binding?["sessionId"]) != id
                || SessionWait.Text(binding?["mode"]) == "send-only"
            )
                continue;
            var (instance, conversation) = ChannelRegistry.Parse(target);
            var channel = ChannelRegistry.Get(instance);
            if (channel is null || channel.Type == "webui" || instance == "webui")
                continue;
            yield return (target, conversation, channel);
        }
    }

    private void StartChannelTurn(SessionOwner owner)
    {
        lock (channelTurnGate)
        {
            if (channelTurns.TryGetValue(owner, out var previous) && previous.Finalized)
            {
                ChannelProgress.Finish(previous.Id);
                channelTurns.Remove(owner);
            }
            if (!channelTurns.ContainsKey(owner))
                channelTurns[owner] = new();
        }
        try
        {
            foreach (var (_, conversation, channel) in AutomaticTargets(owner.Id))
                if (channel.Typing is { } typing)
                    _ = ChannelProgress.BestEffortAsync(
                        _ => typing(conversation, CancellationToken.None),
                        ""
                    );
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Channel typing failed: " + error.Message);
        }
    }

    private async Task ChannelStoppedAsync(SessionOwner owner)
    {
        try
        {
            ChannelTurn? turn;
            lock (channelTurnGate)
                turn = channelTurns.GetValueOrDefault(owner);
            if (turn is not null)
                await BroadcastChannelTextAsync(
                    owner,
                    turn,
                    "_[Execution stopped by user]_",
                    final: true
                );
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Channel stop presentation failed: " + error.Message);
        }
    }

    private ChannelProgressTarget[] ProgressTargets(SessionOwner owner, string turnId)
    {
        var configured = models.ConfigurationOwner?.CurrentChannels() ?? new JsonObject();
        var result = new List<ChannelProgressTarget>();
        foreach (var (target, conversation, channel) in AutomaticTargets(owner.Id))
        {
            var (instance, _) = ChannelRegistry.Parse(target);
            var interval = configured[instance]?["channelProgress"] is JsonObject progress
                ? SessionWait.Number(progress["intervalMs"])
                : null;
            if (
                channel.IsLifecycleActive?.Invoke(conversation) == true
                || interval is not >= 30000 or > 1800000
            )
                continue;
            result.Add(
                new(
                    target,
                    TimeSpan.FromMilliseconds(interval.Value),
                    text =>
                        channel.IsLifecycleActive?.Invoke(conversation) == true
                            ? Task.CompletedTask
                            : channel.Send(
                                conversation,
                                text,
                                new(PresentationTurnId: turnId),
                                CancellationToken.None
                            )
                )
            );
        }
        return result.ToArray();
    }

    private void ChannelStructuredProgress(SessionOwner owner, ChannelTurnProgress progress)
    {
        try
        {
            foreach (var (_, conversation, channel) in AutomaticTargets(owner.Id))
                if (channel.Progress is { } report)
                    _ = ChannelProgress.BestEffortAsync(
                        _ => report(conversation, progress, CancellationToken.None),
                        ""
                    );
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Channel native progress failed: " + error.Message);
        }
    }

    private void ChannelToolProgress(SessionOwner owner, JsonObject call, bool start)
    {
        ChannelTurn? turn;
        lock (channelTurnGate)
            turn = channelTurns.GetValueOrDefault(owner);
        if (turn is null)
            return;
        try
        {
            ChannelProgress.Report(
                turn.Id,
                ProgressTargets(owner, turn.Id),
                SessionWait.Text(call["id"]) ?? "",
                SessionWait.Text(call["name"]) ?? "tool",
                start
            );
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Channel progress failed: " + error.Message);
        }
    }

    private void ObserveChannelTurn(SessionOwner owner, SessionRuntimeEvent value)
    {
        try
        {
            ChannelTurn? turn;
            lock (channelTurnGate)
                turn = channelTurns.GetValueOrDefault(owner);
            if (turn is null)
                return;
            if (value.Kind == SessionEventKind.StateChanged)
            {
                var state = owner.Metadata();
                turn.Stopping |= state.Stopping;
                return;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Channel turn presentation failed: " + error.Message);
        }
    }

    private async Task FinishChannelTurnAsync(
        SessionOwner owner,
        Exception? error,
        bool interrupted,
        bool suspended
    )
    {
        ChannelTurn? turn;
        lock (channelTurnGate)
            turn = channelTurns.GetValueOrDefault(owner);
        if (turn is null)
            return;
        try
        {
            if (!interrupted)
            {
                if (error is not null)
                    await ChannelFailureAsync(owner, error);
                if (!turn.Finalized)
                    await BroadcastChannelTextAsync(
                        owner,
                        turn,
                        turn.Stopping ? "_[Execution stopped by user]_" : "",
                        final: !suspended || turn.Stopping || error is not null,
                        suspended: suspended && !turn.Stopping && error is null
                    );
            }
        }
        catch (Exception deliveryError)
        {
            Console.Error.WriteLine(
                "Channel terminal presentation failed: " + deliveryError.Message
            );
        }
        finally
        {
            lock (channelTurnGate)
                channelTurns.Remove(owner);
            ChannelProgress.Finish(turn.Id);
        }
    }

    private async Task ChannelFailureAsync(SessionOwner owner, Exception error)
    {
        if (error is ModelRequestException { TerminalNoticeDelivered: true })
            return;
        try
        {
            ChannelTurn? turn;
            lock (channelTurnGate)
                turn = channelTurns.GetValueOrDefault(owner);
            if (turn is null || turn.Finalized)
                return;
            var text =
                error is ModelRequestException
                    ? "⚠️ LLM request failed: " + error.Message
                    : "Error: " + error.Message;
            await BroadcastChannelTextAsync(owner, turn, text, final: true);
        }
        catch (Exception deliveryError)
        {
            Console.Error.WriteLine("Channel error presentation failed: " + deliveryError.Message);
        }
    }

    private async Task ChannelRetryAsync(
        SessionOwner owner,
        ModelRetryEvent retry,
        bool initial,
        bool same
    )
    {
        if (!initial && !retry.Final)
            return;
        try
        {
            ChannelTurn? turn;
            lock (channelTurnGate)
                turn = channelTurns.GetValueOrDefault(owner);
            if (turn is null)
                return;
            static string Clean(string? value) => Regex.Replace(value ?? "", @"\s+", " ").Trim();
            var status = same ? "" : Clean(retry.Status);
            var reason = same ? "(same error)" : Clean(retry.Reason);
            var descriptor = status.Length == 0 ? reason : (status + ": " + reason).Trim();
            var seconds = Math.Max(1, (int)Math.Ceiling((retry.DelayMs ?? 0) / 1000d));
            var after = retry.Final
                ? "No more retries."
                : $"Retry in {seconds} second{(seconds == 1 ? "" : "s")}...";
            var text =
                $"⚠️ LLM Error: Attempt {retry.Attempt}/{retry.MaxRetries} failed{(descriptor.Length == 0 ? "." : ": " + descriptor + ".")} {after}";
            await BroadcastChannelTextAsync(owner, turn, text, final: false);
            if (retry.Final)
                await BroadcastChannelTextAsync(owner, turn, "", final: true);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Channel retry presentation failed: " + error.Message);
        }
    }

    private static string AssistantText(JsonObject message) =>
        string.Join(
            "",
            (message["parts"] as JsonArray ?? [])
                .OfType<JsonObject>()
                .Where(part => part["thinking"] is null)
                .Select(part => SessionWait.Text(part["text"]) ?? "")
        );

    private async Task ChannelAssistantCommittedAsync(SessionOwner owner, JsonObject message)
    {
        try
        {
            ChannelTurn? turn;
            lock (channelTurnGate)
                turn = channelTurns.GetValueOrDefault(owner);
            if (turn is null)
                return;
            var parts = (message["parts"] as JsonArray ?? []).OfType<JsonObject>().ToArray();
            var final =
                !parts.Any(part => part["functionCall"] is not null)
                && !owner.Entry.WithState(state => state.Queue.Any(SessionCompactor.Ordinary));
            await BroadcastChannelTextAsync(
                owner,
                turn,
                AssistantText(message),
                final,
                nativeProgressText: parts.Any(part => part["functionCall"] is not null)
            );
            foreach (
                var part in parts.Where(part =>
                    SessionWait.Text(part["imageMeta"]?["origin"]) == "generated"
                )
            )
                if (part["inlineDataRef"] is JsonObject reference)
                    await DeliverGeneratedImageAsync(owner, reference);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Channel turn presentation failed: " + error.Message);
        }
    }

    private Task BroadcastChannelTextAsync(
        SessionOwner owner,
        ChannelTurn turn,
        string text,
        bool final,
        bool nativeProgressText = false,
        bool suspended = false
    )
    {
        turn.Finalized = final;
        foreach (var (target, conversation, channel) in AutomaticTargets(owner.Id))
        {
            if (nativeProgressText && channel.IsLifecycleActive?.Invoke(conversation) == true)
                continue;
            if (!string.IsNullOrWhiteSpace(text))
            {
                var decorated =
                    channel.IsLifecycleActive?.Invoke(conversation) == true
                        ? text
                        : ChannelProgress.Decorate(turn.Id, target, text);
                _ = ChannelProgress.BestEffortAsync(
                    value =>
                        channel.Send(
                            conversation,
                            value,
                            new(final, final ? null : "Markdown", PresentationTurnId: turn.Id),
                            CancellationToken.None
                        ),
                    decorated
                );
            }
            else if ((final || suspended) && channel.Finalize is { } finish)
                _ = ChannelProgress.BestEffortAsync(
                    _ => finish(conversation, new(TurnFinal: final, TurnSuspended: suspended), CancellationToken.None),
                    ""
                );
        }
        // Ordinary Main broadcasts never wait for platform acknowledgement, including terminal lifecycle.
        return Task.CompletedTask;
    }

    private async Task DeliverGeneratedImageAsync(SessionOwner owner, JsonObject reference)
    {
        try
        {
            var blob = SessionWait.Text(reference["blobId"]) ?? "";
            var mime =
                ImageBlobStore.SafeMime(blob)
                ?? throw new InvalidDataException("Generated image has no safe raster blob.");
            await Images.ReadAsync(reference);
            var name =
                (SessionWait.Text(reference["imageId"]) ?? "image")
                + "."
                + ImageBlobStore.Extension(mime);
            var file = new ChannelFile(Images.ResolveBlob(blob), name, mime, true);
            foreach (var (_, conversation, channel) in AutomaticTargets(owner.Id))
                if (channel.SendFile is { } send)
                    try
                    {
                        await send(conversation, file, null, CancellationToken.None);
                    }
                    catch (Exception error)
                    {
                        Console.Error.WriteLine(
                            "Generated image delivery failed: " + error.Message
                        );
                    }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Generated image delivery failed: " + error.Message);
        }
    }
}
