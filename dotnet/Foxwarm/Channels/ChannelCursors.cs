using System.Text.Json.Nodes;
using Foxwarm.Storage;

namespace Foxwarm.Channels;

/// <summary>Committed poll positions for managed channel instances. One document per installation.</summary>
internal sealed class ChannelCursors(IStateDocuments documents)
{
    private readonly IStateDocument file = documents.Open(StateDocumentName.ChannelCursors);
    private readonly SemaphoreSlim lane = new(1, 1);
    private JsonObject? rows;
    private readonly CancellationTokenSource stopPolling = new();
    internal CancellationToken StopPolling => stopPolling.Token;
    private readonly CancellationTokenSource checkpointsClosed = new();
    internal CancellationToken Closing => checkpointsClosed.Token;
    internal async Task CloseAsync()
    {
        await checkpointsClosed.CancelAsync().ConfigureAwait(false);
        // A file-mode stop can reject an event for replay. No writer of this runtime may
        // publish a checkpoint after the next runtime opens the same file.
        await lane.WaitAsync().ConfigureAwait(false);
        lane.Release();
    }

    internal static string Receipt(string type, string instance, string account, string eventId) =>
        new JsonArray(type, instance, account, eventId).ToJsonString();

    // A replacement poller starts only after the previous instance's admissions and checkpoint
    // have settled. Starting it does not join the loop: commands can restart their own channel.
    private readonly object gate = new();
    private readonly Dictionary<string, Task> polling = new(StringComparer.Ordinal);

    internal Task PollAsync(string instance, Func<Task> poll)
    {
        lock (gate)
        {
            var previous = polling.GetValueOrDefault(instance);
            var next = Task.Run(async () =>
            {
                if (previous is not null)
                    try { await previous.ConfigureAwait(false); } catch { /* Its adapter reported the error. */ }
                await poll().ConfigureAwait(false);
            });
            polling[instance] = next;
            _ = next.ContinueWith(done =>
            {
                lock (gate)
                    if (polling.GetValueOrDefault(instance) == done) polling.Remove(instance);
            }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            return next;
        }
    }

    internal Task DrainedAsync()
    {
        lock (gate) return Task.WhenAll(polling.Values);
    }

    private async Task<JsonObject> RowsAsync()
    {
        if (rows is not null) return rows;
        var text = await file.ReadTextAsync().ConfigureAwait(false);
        return rows = text is null ? new JsonObject() : JsonNode.Parse(text)!.AsObject();
    }

    internal async Task<JsonObject?> ReadAsync(string instance, string account)
    {
        await lane.WaitAsync().ConfigureAwait(false);
        try
        {
            var row = (await RowsAsync().ConfigureAwait(false))[instance] as JsonObject;
            return row?["account"]?.GetValue<string>() == account ? (JsonObject)row.DeepClone() : null;
        }
        finally { lane.Release(); }
    }

    internal async Task SaveAsync(string instance, string account, JsonObject position, CancellationToken token = default)
    {
        await lane.WaitAsync(token).ConfigureAwait(false);
        try
        {
            token.ThrowIfCancellationRequested();
            Closing.ThrowIfCancellationRequested();
            var current = await RowsAsync().ConfigureAwait(false);
            position["account"] = account;
            if (JsonNode.DeepEquals(current[instance], position)) return;
            var next = (JsonObject)current.DeepClone();
            next[instance] = position.DeepClone();
            // On an uncertain file commit, the next save retries durably rather than skipping
            // output on the strength of the in-memory copy.
            file.ReplaceText(next.ToJsonString(), token);
            rows = next;
        }
        finally { lane.Release(); }
    }
}
