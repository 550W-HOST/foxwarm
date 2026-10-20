using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

/// <summary>Revisioned list/session subscription union, installed before acknowledged snapshots and buffered events.</summary>
internal sealed class WebUiRealtime(SessionRuntime runtime, WebUiLogFile? logs = null)
{
    // Optional scheduling seam for the focused transport test; normal hosts leave it unset.
    internal Func<JsonObject, CancellationToken, Task>? BeforeQueuedSend { get; init; }
    private const int MaxSubscriptions = 5000; // webuiRealtime.ts union limit.
    private const int MaxMessageBytes = 32 * 1024 * 1024; // Two bounded UTF-8 ID arrays, including JSON escaping.

    public async Task RunAsync(
        WebSocket socket,
        CancellationToken stopped,
        WebUiRequest? scoped = null
    )
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stopped);
        using var sendGate = new SemaphoreSlim(1);
        var gate = new object();
        long revision = 0;
        long eventId = 0;
        var sessionIds = new HashSet<string>(StringComparer.Ordinal);
        var listIds = new HashSet<string>(StringComparer.Ordinal);
        var listActive = false;
        var initializing = false;
        var pending = new List<JsonObject>();
        long queuedBytes = 0;
        string? logsId = null;
        Action? stopLogs = null;
        LogSubscription? requestedLogs = null;
        var output = Channel.CreateUnbounded<(
            long? Revision,
            JsonObject Data,
            int Bytes,
            string? LogsId
        )>();
        void Queue(long? expected, JsonObject data, string? topic = null)
        {
            var bytes = Encoding.UTF8.GetByteCount(data.ToJsonString());
            Interlocked.Add(ref queuedBytes, bytes);
            if (!output.Writer.TryWrite((expected, data, bytes, topic)))
                Interlocked.Add(ref queuedBytes, -bytes);
        }
        void Deliver(JsonObject data)
        {
            lock (gate)
            {
                if (initializing)
                    pending.Add(data);
                else
                    Queue(revision, data);
            }
        }
        void Changed(SessionRuntimeEvent entry)
        {
            bool watchSession;
            bool watchList;
            bool invalidate;
            lock (gate)
            {
                watchSession = sessionIds.Contains(entry.SessionId);
                watchList = listActive && listIds.Contains(entry.SessionId);
                invalidate =
                    listActive
                    && entry.Kind
                        is SessionEventKind.StateChanged
                            or SessionEventKind.MessageCommitted
                            or SessionEventKind.Deleted;
            }
            if (watchSession && entry.Kind != SessionEventKind.RequestProgress)
                Deliver(WebUiContract.Event(entry, runtime));
            if (watchList && entry.Kind == SessionEventKind.Deleted)
                Deliver(
                    new JsonObject
                    {
                        ["type"] = "session-list-delta",
                        ["sessions"] = new JsonArray(),
                        ["deletedIds"] = new JsonArray(entry.SessionId),
                    }
                );
            if (
                watchList
                && entry.Kind is SessionEventKind.StateChanged or SessionEventKind.MessageCommitted
            )
            {
                var row = new SessionListQueries(runtime).Projection(entry.SessionId);
                if (row is not null)
                    Deliver(
                        new JsonObject
                        {
                            ["type"] = "session-list-delta",
                            ["sessions"] = new JsonArray(row),
                            ["deletedIds"] = new JsonArray(),
                        }
                    );
            }
            if (invalidate)
                Invalidated();
        }
        void Invalidated()
        {
            lock (gate)
                if (!listActive)
                    return;
            Deliver(
                new JsonObject
                {
                    ["type"] = "session-list-invalidated",
                    ["eventId"] = Interlocked.Increment(ref eventId),
                    ["presentationRevision"] = new SessionListQueries(runtime).Revision,
                }
            );
        }
        runtime.Changed += Changed;
        runtime.TopologyChanged += Invalidated;
        async Task Pump()
        {
            await foreach (var item in output.Reader.ReadAllAsync(lifetime.Token))
            {
                try
                {
                    lock (gate)
                        if (
                            (item.Revision is long expected && expected != revision)
                            || (item.LogsId is not null && item.LogsId != logsId)
                        )
                            continue;
                    if (BeforeQueuedSend is { } pause)
                        await pause(item.Data, lifetime.Token);
                    await Send(item.Data, item.Revision, item.LogsId, queued: true);
                    // Logs starts behind the existing applied barrier, never in pending
                    // Session initialization. An unchanged logical ID survives revisions.
                    if (item.Data["type"]?.GetValue<string>() == "subscriptions-applied")
                    {
                        lock (gate)
                        {
                            if (
                                item.Revision == revision
                                && requestedLogs is { } request
                                && logsId is null
                            )
                            {
                                logsId = request.Id;
                                stopLogs = logs!.Subscribe(
                                    request,
                                    frame =>
                                    {
                                        if (Volatile.Read(ref logsId) == request.Id)
                                            Queue(null, frame, request.Id);
                                    },
                                    () =>
                                        !lifetime.IsCancellationRequested
                                        && socket.State == WebSocketState.Open
                                        && Interlocked.Read(ref queuedBytes)
                                            < WebUiLogFile.SocketBufferBytes
                                );
                            }
                        }
                    }
                }
                finally
                {
                    Interlocked.Add(ref queuedBytes, -item.Bytes);
                }
            }
        }
        var pumping = Pump();
        CancellationTokenSource? currentInitialization = null;
        var initializationTasks = new HashSet<Task>();
        try
        {
            await Send(new JsonObject { ["type"] = "connected" });
            while (socket.State == WebSocketState.Open && !stopped.IsCancellationRequested)
            {
                JsonObject? input;
                try
                {
                    input = await Receive(socket, lifetime.Token);
                }
                catch (Exception error)
                    when (error is FormatException or System.Text.Json.JsonException)
                {
                    await ProtocolError("Invalid subscription frame.");
                    break;
                }
                if (input is null)
                    break;
                if (
                    input["type"]?.GetValue<string>() != "set-subscriptions"
                    || input["revision"] is not JsonValue revisionValue
                    || !revisionValue.TryGetValue<long>(out var requested)
                    || requested < 1
                    || requested > 9007199254740991L
                    || input["sessionListActive"] is not JsonValue flag
                    || !flag.TryGetValue<bool>(out var active)
                )
                {
                    await ProtocolError("Invalid subscription revision or type.");
                    break;
                }
                if (requested <= revision)
                    continue;
                string[] requestedSessions;
                string[] requestedList;
                try
                {
                    requestedSessions = SessionListQueries
                        .Ids(input["sessionIds"], MaxSubscriptions)
                        .Distinct(StringComparer.Ordinal)
                        .ToArray();
                    requestedList = SessionListQueries
                        .Ids(input["sessionListIds"], MaxSubscriptions)
                        .Distinct(StringComparer.Ordinal)
                        .ToArray();
                }
                catch (SessionListQueryException error)
                {
                    await ProtocolError(error.Message);
                    break;
                }
                LogSubscription? logRequest;
                try
                {
                    logRequest = ParseLogs(input["logs"]);
                }
                catch (FormatException error)
                {
                    await ProtocolError(error.Message);
                    break;
                }
                if (logRequest is not null && logs is null)
                {
                    await ProtocolError("Logs are unavailable.");
                    break;
                }
                if (
                    scoped is not null
                    && (
                        active
                        || requestedList.Length > 0
                        || input["logs"] is not null
                        || requestedSessions.Any(id => !scoped.Allows(id))
                    )
                )
                {
                    await ProtocolError("WebUI subscription is not bound to this session.");
                    break;
                }
                scoped?.ResetBindings();
                foreach (var requestedId in requestedSessions)
                    scoped?.Bind(requestedId);
                var resolvedSemantic = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
                foreach (var chunk in requestedSessions.Chunk(200))
                foreach (var pair in runtime.Catalog.ResolveMany(chunk))
                    resolvedSemantic[pair.Key] = pair.Value;
                var resolvedList = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
                foreach (var chunk in requestedList.Chunk(200))
                foreach (var pair in runtime.Catalog.ResolveMany(chunk))
                    resolvedList[pair.Key] = pair.Value;
                var listCanonical = resolvedList
                    .Values.Select(row => SessionCatalog.Text(row["sessionId"]))
                    .OfType<string>()
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
                lock (gate)
                {
                    if (logsId != logRequest?.Id)
                    {
                        stopLogs?.Invoke();
                        stopLogs = null;
                        logsId = null;
                    }
                    requestedLogs = logRequest;
                    revision = requested;
                    initializing = true;
                    pending.Clear();
                    sessionIds = requestedSessions
                        .Select(id =>
                            SessionCatalog.Text(
                                resolvedSemantic.GetValueOrDefault(id)?["sessionId"]
                            ) ?? id
                        )
                        .ToHashSet(StringComparer.Ordinal);
                    listIds = listCanonical.ToHashSet(StringComparer.Ordinal);
                    listActive = active;
                }
                CancellationTokenSource? previous;
                lock (gate)
                {
                    previous = currentInitialization;
                    currentInitialization = null;
                }
                try
                {
                    previous?.Cancel();
                }
                catch (ObjectDisposedException) { }
                var attempt = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                lock (gate)
                    currentInitialization = attempt;
                var work = InitializeSubscriptions(
                    requested,
                    requestedSessions,
                    requestedList,
                    resolvedSemantic,
                    resolvedList,
                    listCanonical,
                    active,
                    attempt
                );
                lock (gate)
                    initializationTasks.Add(work);
                _ = work.ContinueWith(
                    done =>
                    {
                        _ = done.Exception;
                        lock (gate)
                            initializationTasks.Remove(done);
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default
                );
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (WebSocketException) { }
        catch (WebUiAccessException) { }
        finally
        {
            runtime.Changed -= Changed;
            runtime.TopologyChanged -= Invalidated;
            lifetime.Cancel();
            lock (gate)
            {
                stopLogs?.Invoke();
                stopLogs = null;
                logsId = null;
            }
            output.Writer.TryComplete();
            Task[] work;
            lock (gate)
                work = initializationTasks.ToArray();
            try
            {
                await Task.WhenAll(work);
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException) { }
            try
            {
                await pumping;
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException) { }
            catch (WebUiAccessException) { }
            if (socket.State == WebSocketState.Open)
                try
                {
                    await socket.CloseAsync(
                        WebSocketCloseStatus.NormalClosure,
                        "Subscription closed",
                        CancellationToken.None
                    );
                }
                catch (WebSocketException) { }
        }
        async Task InitializeSubscriptions(
            long requested,
            string[] requestedSessions,
            string[] requestedList,
            Dictionary<string, JsonObject> resolvedSemantic,
            Dictionary<string, JsonObject> resolvedList,
            string[] listCanonical,
            bool active,
            CancellationTokenSource attempt
        )
        {
            try
            {
                Dictionary<string, string?> semantic;
                Dictionary<string, SessionOwner?> admittedOwners;
                string? CurrentId(SessionOwner? owner)
                {
                    if (owner is null)
                        return null;
                    var current = runtime.Owner(owner.Id);
                    if (ReferenceEquals(current, owner))
                        return owner.Id;
                    if (current is null && runtime.Catalog.Get(owner.Id) is null)
                        return null;
                    throw new InvalidOperationException(
                        "Session changed while loading. Try again."
                    );
                }
                try
                {
                    var admitted = await Task.WhenAll(
                        requestedSessions.Select(async id =>
                            (
                                Requested: id,
                                Owner: await runtime.GetOwnerAsync(
                                    SessionCatalog.Text(
                                        resolvedSemantic.GetValueOrDefault(id)?["sessionId"]
                                    ) ?? id,
                                    attempt.Token
                                )
                            )
                        )
                    );
                    admittedOwners = admitted.ToDictionary(
                        pair => pair.Requested,
                        pair => pair.Owner,
                        StringComparer.Ordinal
                    );
                    semantic = admitted.ToDictionary(
                        pair => pair.Requested,
                        pair => CurrentId(pair.Owner),
                        StringComparer.Ordinal
                    );
                }
                catch (OperationCanceledException) when (attempt.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception error)
                {
                    await Send(
                        new JsonObject
                        {
                            ["type"] = "error",
                            ["code"] = "SESSION_STATE_UNAVAILABLE",
                            ["message"] = error.Message,
                            ["revision"] = requested,
                        },
                        requested
                    );
                    lock (gate)
                        if (revision != requested)
                            return;
                    lifetime.Cancel();
                    return;
                }
                var existing = semantic
                    .Values.OfType<string>()
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
                lock (gate)
                {
                    if (revision != requested || attempt.IsCancellationRequested)
                        return;
                    sessionIds = existing.ToHashSet(StringComparer.Ordinal);
                }
                var sessionMap = new JsonObject();
                var listMap = new JsonObject();
                foreach (var pair in semantic)
                    if (pair.Value is not null)
                        sessionMap[pair.Key] = pair.Value;
                foreach (var pair in resolvedList)
                    if (SessionCatalog.Text(pair.Value["sessionId"]) is { } canonical)
                        listMap[pair.Key] = canonical;
                await Send(
                    new JsonObject
                    {
                        ["type"] = "subscriptions-accepted",
                        ["revision"] = requested,
                        ["sessionResolutions"] = sessionMap,
                        ["sessionListResolutions"] = listMap,
                    },
                    requested
                );
                if (active)
                {
                    var view = new SessionListQueries(runtime);
                    await Send(
                        new JsonObject
                        {
                            ["type"] = "session-list-delta",
                            ["deletedIds"] = new JsonArray(
                                requestedList
                                    .Where(id => !listMap.ContainsKey(id))
                                    .Select(id => (JsonNode?)JsonValue.Create(id))
                                    .ToArray()
                            ),
                            ["sessions"] = view.ProjectionRows(listCanonical),
                        },
                        requested
                    );
                }
                foreach (var id in requestedSessions.Where(id => semantic[id] is null))
                    await Send(
                        new JsonObject { ["type"] = "session-deleted", ["sessionId"] = id },
                        requested
                    );
                foreach (var id in existing)
                {
                    var owner = admittedOwners.Values.First(value => value?.Id == id)!;
                    if (CurrentId(owner) is null)
                    {
                        await Send(
                            new JsonObject { ["type"] = "session-deleted", ["sessionId"] = id },
                            requested
                        );
                        continue;
                    }
                    var state = owner.BuildDto();
                    var draft = WebUiContract.Draft(owner);
                    if (CurrentId(owner) is null)
                    {
                        await Send(
                            new JsonObject { ["type"] = "session-deleted", ["sessionId"] = id },
                            requested
                        );
                        continue;
                    }
                    await Send(
                        new JsonObject
                        {
                            ["type"] = "session-state",
                            ["sessionId"] = id,
                            ["session"] = state,
                        },
                        requested
                    );
                    await Send(draft, requested);
                }
                // Queue buffered events and applied together under the initialization gate.
                // No live pump can overtake the snapshots or the registration barrier.
                lock (gate)
                {
                    if (revision != requested || attempt.IsCancellationRequested)
                        return;
                    foreach (var data in pending)
                        Queue(requested, data);
                    pending.Clear();
                    Queue(
                        requested,
                        new JsonObject
                        {
                            ["type"] = "subscriptions-applied",
                            ["revision"] = requested,
                        }
                    );
                    initializing = false;
                }
            }
            catch (OperationCanceledException)
                when (attempt.IsCancellationRequested || lifetime.IsCancellationRequested) { }
            catch (WebSocketException)
            {
                lifetime.Cancel();
            }
            catch (WebUiAccessException)
            {
                lifetime.Cancel();
            }
            catch (Exception error)
            {
                await Send(
                    new JsonObject
                    {
                        ["type"] = "error",
                        ["code"] = "SESSION_STATE_UNAVAILABLE",
                        ["message"] = error.Message,
                        ["revision"] = requested,
                    },
                    requested
                );
                lock (gate)
                    if (revision != requested)
                        return;
                lifetime.Cancel();
            }
            finally
            {
                lock (gate)
                {
                    if (ReferenceEquals(currentInitialization, attempt))
                        currentInitialization = null;
                }
                attempt.Dispose();
            }
        }
        async Task Send(
            JsonObject data,
            long? expectedRevision = null,
            string? expectedLogsId = null,
            bool queued = false
        )
        {
            scoped?.Require();
            if (scoped is not null && SessionCatalog.Text(data["sessionId"]) is { } scopedId)
            {
                scoped.Require(scopedId);
                if (data["session"] is JsonObject session)
                    data["session"] = scoped.Session(session);
            }
            var bytes = Encoding.UTF8.GetBytes(
                Foxwarm.Images.ImageTransport.Project(data)!.ToJsonString()
            );
            if (!queued)
                Interlocked.Add(ref queuedBytes, bytes.Length);
            try
            {
                await sendGate.WaitAsync(lifetime.Token);
                try
                {
                    // Recheck at the same barrier that orders snapshots and actual writes.
                    lock (gate)
                        if (
                            (expectedRevision is long expected && expected != revision)
                            || (expectedLogsId is not null && expectedLogsId != logsId)
                        )
                            return;
                    scoped?.Require();
                    if (socket.State == WebSocketState.Open)
                        await socket.SendAsync(
                            bytes,
                            WebSocketMessageType.Text,
                            true,
                            lifetime.Token
                        );
                }
                finally
                {
                    sendGate.Release();
                }
            }
            finally
            {
                if (!queued)
                    Interlocked.Add(ref queuedBytes, -bytes.Length);
            }
        }
        async Task ProtocolError(string message)
        {
            await Send(new JsonObject { ["type"] = "protocol-error", ["message"] = message });
            await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, message, lifetime.Token);
        }
    }

    private static LogSubscription? ParseLogs(JsonNode? raw)
    {
        if (raw is null)
            return null;
        if (
            raw is not JsonObject obj
            || obj["id"] is not JsonValue id
            || !id.TryGetValue<string>(out var text)
            || text.Length is 0 or > 128
        )
            throw new FormatException("Invalid logs subscription.");
        LogCursor? cursor = null;
        if (obj.ContainsKey("cursor"))
        {
            if (
                obj["cursor"] is not JsonObject value
                || value["fileId"] is not JsonValue file
                || !file.TryGetValue<string>(out var fileId)
                || fileId.Length is 0 or > 256
                || value["offset"] is not JsonValue position
                || !position.TryGetValue<long>(out var offset)
                || offset < 0
                || offset > 9007199254740991L
            )
                throw new FormatException("Invalid logs cursor.");
            cursor = new(fileId, offset);
        }
        return new(text, cursor);
    }

    private static async Task<JsonObject?> Receive(WebSocket socket, CancellationToken token)
    {
        using var stream = new MemoryStream();
        var buffer = new byte[4096];
        while (true)
        {
            var frame = await socket.ReceiveAsync(buffer, token);
            if (frame.MessageType == WebSocketMessageType.Close)
                return null;
            if (
                frame.MessageType != WebSocketMessageType.Text
                || stream.Length + frame.Count > MaxMessageBytes
            )
                throw new FormatException("Invalid subscription size or type.");
            stream.Write(buffer, 0, frame.Count);
            if (frame.EndOfMessage)
                break;
        }
        return JsonNode.Parse(stream.ToArray()) as JsonObject
            ?? throw new FormatException("Subscription must be an object.");
    }
}
