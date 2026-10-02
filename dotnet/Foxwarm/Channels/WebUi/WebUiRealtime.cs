using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

/// <summary>Revisioned list/session subscription union, installed before acknowledged snapshots and buffered events.</summary>
internal sealed class WebUiRealtime(SessionRuntime runtime)
{
    // Optional scheduling seam for the focused transport test; normal hosts leave it unset.
    internal Func<JsonObject, CancellationToken, Task>? BeforeQueuedSend { get; init; }
    private const int MaxSubscriptions = 5000; // webuiRealtime.ts union limit.
    private const int MaxMessageBytes = 32 * 1024 * 1024; // Two bounded UTF-8 ID arrays, including JSON escaping.
    public async Task RunAsync(WebSocket socket, CancellationToken stopped)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stopped);
        using var sendGate = new SemaphoreSlim(1);
        var gate = new object();
        long revision = 0; long eventId = 0;
        var sessionIds = new HashSet<string>(StringComparer.Ordinal);
        var listIds = new HashSet<string>(StringComparer.Ordinal);
        var listActive = false;
        var initializing = false;
        var pending = new List<JsonObject>();
        var output = Channel.CreateUnbounded<(long Revision, JsonObject Data)>();
        void Deliver(JsonObject data)
        {
            lock (gate)
            {
                if (initializing) pending.Add(data);
                else output.Writer.TryWrite((revision, data));
            }
        }
        void Changed(SessionRuntimeEvent entry)
        {
            bool watchSession; bool watchList; bool invalidate;
            lock (gate)
            {
                watchSession = sessionIds.Contains(entry.SessionId);
                watchList = listActive && listIds.Contains(entry.SessionId);
                invalidate = listActive && entry.Kind is SessionEventKind.StateChanged or SessionEventKind.MessageCommitted;
            }
            if (watchSession && entry.Kind != SessionEventKind.RequestProgress) Deliver(WebUiContract.Event(entry, runtime));
            if (watchList && entry.Kind is SessionEventKind.StateChanged or SessionEventKind.MessageCommitted)
            {
                var row = new SessionListQueries(runtime).Projection(entry.SessionId);
                if (row is not null) Deliver(new JsonObject { ["type"] = "session-list-delta", ["sessions"] = new JsonArray(row), ["deletedIds"] = new JsonArray() });
            }
            if (invalidate) Invalidated();
        }
        void Invalidated()
        {
            lock (gate) if (!listActive) return;
            Deliver(new JsonObject
            {
                ["type"] = "session-list-invalidated",
                ["eventId"] = Interlocked.Increment(ref eventId),
                ["presentationRevision"] = new SessionListQueries(runtime).Revision
            });
        }
        runtime.Changed += Changed;
        runtime.TopologyChanged += Invalidated;
        async Task Pump()
        {
            await foreach (var item in output.Reader.ReadAllAsync(lifetime.Token))
            {
                lock (gate) if (item.Revision != revision) continue;
                if (BeforeQueuedSend is { } pause) await pause(item.Data, lifetime.Token);
                await Send(item.Data, item.Revision);
            }
        }
        var pumping = Pump();
        try
        {
            await Send(new JsonObject { ["type"] = "connected" });
            while (socket.State == WebSocketState.Open && !stopped.IsCancellationRequested)
            {
                JsonObject? input;
                try { input = await Receive(socket, lifetime.Token); }
                catch (Exception error) when (error is FormatException or System.Text.Json.JsonException)
                { await ProtocolError("Invalid subscription frame."); break; }
                if (input is null) break;
                if (input["type"]?.GetValue<string>() != "set-subscriptions"
                    || input["revision"] is not JsonValue revisionValue || !revisionValue.TryGetValue<long>(out var requested)
                    || requested < 1 || requested > 9007199254740991L
                    || input["sessionListActive"] is not JsonValue flag || !flag.TryGetValue<bool>(out var active))
                { await ProtocolError("Invalid subscription revision or type."); break; }
                if (requested <= revision) continue;
                string[] requestedSessions; string[] requestedList;
                try
                {
                    requestedSessions = SessionListQueries.Ids(input["sessionIds"], MaxSubscriptions).Distinct(StringComparer.Ordinal).ToArray();
                    requestedList = SessionListQueries.Ids(input["sessionListIds"], MaxSubscriptions).Distinct(StringComparer.Ordinal).ToArray();
                }
                catch (SessionListQueryException error) { await ProtocolError(error.Message); break; }
                var semantic = requestedSessions.ToDictionary(id => id, id => runtime.Owner(id)?.Id, StringComparer.Ordinal);
                var resolvedList = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
                foreach (var chunk in requestedList.Chunk(200)) foreach (var pair in runtime.Catalog.ResolveMany(chunk)) resolvedList[pair.Key] = pair.Value;
                var existing = semantic.Values.OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
                var listCanonical = resolvedList.Values.Select(row => SessionCatalog.Text(row["sessionId"])).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
                lock (gate)
                {
                    revision = requested; initializing = true; pending.Clear();
                    sessionIds = existing.ToHashSet(StringComparer.Ordinal);
                    listIds = listCanonical.ToHashSet(StringComparer.Ordinal); listActive = active;
                }
                var sessionMap = new JsonObject(); var listMap = new JsonObject();
                foreach (var pair in semantic) if (pair.Value is not null) sessionMap[pair.Key] = pair.Value;
                foreach (var pair in resolvedList) if (SessionCatalog.Text(pair.Value["sessionId"]) is { } canonical) listMap[pair.Key] = canonical;
                await Send(new JsonObject
                {
                    ["type"] = "subscriptions-accepted",
                    ["revision"] = requested,
                    ["sessionResolutions"] = sessionMap,
                    ["sessionListResolutions"] = listMap
                });
                if (active)
                {
                    var view = new SessionListQueries(runtime);
                    await Send(new JsonObject
                    {
                        ["type"] = "session-list-delta",
                        ["deletedIds"] = new JsonArray(requestedList.Where(id => !listMap.ContainsKey(id)).Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
                        ["sessions"] = view.ProjectionRows(listCanonical)
                    });
                }
                foreach (var id in requestedSessions.Where(id => semantic[id] is null))
                    await Send(new JsonObject { ["type"] = "session-deleted", ["sessionId"] = id });
                foreach (var id in existing)
                {
                    await Send(new JsonObject { ["type"] = "session-state", ["sessionId"] = id, ["session"] = runtime.GetSession(id) });
                    await Send(WebUiContract.Draft(runtime.Owner(id)!));
                }
                // Queue buffered events and applied together under the initialization gate.
                // No live pump can overtake the snapshots or the registration barrier.
                lock (gate)
                {
                    foreach (var data in pending) output.Writer.TryWrite((requested, data));
                    pending.Clear();
                    output.Writer.TryWrite((requested, new JsonObject { ["type"] = "subscriptions-applied", ["revision"] = requested }));
                    initializing = false;
                }
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (WebSocketException) { }
        finally
        {
            runtime.Changed -= Changed; runtime.TopologyChanged -= Invalidated;
            lifetime.Cancel(); output.Writer.TryComplete();
            try { await pumping; } catch (OperationCanceledException) { } catch (WebSocketException) { }
            if (socket.State == WebSocketState.Open)
                try { await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Subscription closed", CancellationToken.None); }
                catch (WebSocketException) { }
        }
        async Task Send(JsonObject data, long? expectedRevision = null)
        {
            var bytes = Encoding.UTF8.GetBytes(data.ToJsonString());
            await sendGate.WaitAsync(lifetime.Token);
            try
            {
                // Recheck at the same barrier that orders snapshots and actual writes.
                lock (gate) if (expectedRevision is long expected && expected != revision) return;
                if (socket.State == WebSocketState.Open) await socket.SendAsync(bytes, WebSocketMessageType.Text, true, lifetime.Token);
            }
            finally { sendGate.Release(); }
        }
        async Task ProtocolError(string message)
        {
            await Send(new JsonObject { ["type"] = "protocol-error", ["message"] = message });
            await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, message, lifetime.Token);
        }
    }
    private static async Task<JsonObject?> Receive(WebSocket socket, CancellationToken token)
    {
        using var stream = new MemoryStream(); var buffer = new byte[4096];
        while (true)
        {
            var frame = await socket.ReceiveAsync(buffer, token);
            if (frame.MessageType == WebSocketMessageType.Close) return null;
            if (frame.MessageType != WebSocketMessageType.Text || stream.Length + frame.Count > MaxMessageBytes) throw new FormatException("Invalid subscription size or type.");
            stream.Write(buffer, 0, frame.Count); if (frame.EndOfMessage) break;
        }
        return JsonNode.Parse(stream.ToArray()) as JsonObject ?? throw new FormatException("Subscription must be an object.");
    }
}
