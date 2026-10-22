using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class ResponsesWsTransport(
    TimeProvider? clock = null,
    Func<ClientWebSocket>? socketFactory = null,
    Action<JsonObject>? diagnostics = null
) : IAsyncDisposable
{
    internal TimeProvider Clock { get; } = clock ?? TimeProvider.System;
    internal const int IdleLimit = 5;
    internal const int IdleTimeoutMs = 600000;
    internal const int MaxAgeMs = 3600000;
    private readonly object gate = new();
    private readonly List<Chain> idle = [];
    private readonly HashSet<ResponsesWsResource> resources = [];
    private readonly HashSet<Task> closing = [];
    private bool disposed;

    private sealed record Chain(
        ResponsesWsResource Resource,
        string Connection,
        string Invariant,
        WsPrefix Expected,
        string PreviousId,
        DateTimeOffset Created,
        DateTimeOffset LastUsed
    )
    {
        internal ITimer? Timer;
    }

    internal void BeginShutdown()
    {
        lock (gate)
            disposed = true;
    }

    internal int IdleCount
    {
        get
        {
            lock (gate)
                return idle.Count;
        }
    }
    internal int ResourceCount
    {
        get
        {
            lock (gate)
                return resources.Count;
        }
    }

    internal void Log(
        ResponsesWsResource resource,
        string boundary,
        string cause,
        string? origin = null,
        int? code = null,
        bool failure = false
    )
    {
        try
        {
            var data = new JsonObject
            {
                ["providerType"] = "openai-ws",
                ["socketId"] = resource.Id,
                ["boundary"] = boundary,
                ["cause"] = cause,
                ["phase"] = resource.Phase.ToString().ToLowerInvariant(),
            };
            foreach (var (key, value) in resource.Summary())
                data[key] = value?.DeepClone();
            if (origin is not null)
                data["closeOrigin"] = origin;
            if (code is not null)
                data["closeCode"] = code;
            if (diagnostics is not null)
                diagnostics(data);
            else
                MainLog.Diagnostic(data.ToJsonString(), failure);
        }
        catch { }
    }

    internal void Remove(ResponsesWsResource resource)
    {
        Chain[] removed;
        lock (gate)
        {
            removed = idle.Where(chain => ReferenceEquals(chain.Resource, resource)).ToArray();
            idle.RemoveAll(chain => ReferenceEquals(chain.Resource, resource));
        }
        foreach (var chain in removed)
            chain.Timer?.Dispose();
    }

    internal void Unregister(ResponsesWsResource resource)
    {
        Remove(resource);
        lock (gate)
            resources.Remove(resource);
    }

    private void Close(ResponsesWsResource resource, string cause)
    {
        var task = resource.CloseIdleAsync(cause);
        lock (gate)
            closing.Add(task);
        _ = FinishAsync(task);
        async Task FinishAsync(Task pending)
        {
            try
            {
                await pending.ConfigureAwait(false);
            }
            catch { }
            finally
            {
                lock (gate)
                    closing.Remove(pending);
            }
        }
    }

    private Chain? Take(string connection, WsFingerprint fingerprint)
    {
        var now = Clock.GetUtcNow();
        Chain? chosen;
        Chain[] expired;
        lock (gate)
        {
            if (disposed)
                throw new ObjectDisposedException(nameof(ResponsesWsTransport));
            expired = idle.Where(chain =>
                    now - chain.Created >= TimeSpan.FromMilliseconds(MaxAgeMs)
                )
                .ToArray();
            foreach (var old in expired)
                idle.Remove(old);
            chosen = idle.Where(chain =>
                    chain.Connection == connection
                    && chain.Invariant == fingerprint.Invariant
                    && fingerprint.Prefixes.Any(prefix =>
                        prefix.ItemCount == chain.Expected.ItemCount
                        && prefix.Hash == chain.Expected.Hash
                    )
                )
                .OrderByDescending(chain => chain.Expected.ItemCount)
                .ThenByDescending(chain => chain.LastUsed)
                .FirstOrDefault();
            if (chosen is not null)
                idle.Remove(chosen);
        }
        foreach (var old in expired)
        {
            old.Timer?.Dispose();
            Close(old.Resource, "age-expired");
        }
        chosen?.Timer?.Dispose();
        return chosen;
    }

    private void Release(Chain chain)
    {
        Chain[] evicted;
        var admitted = false;
        lock (gate)
        {
            if (!disposed && chain.Resource.Phase == WsPhase.Idle)
            {
                idle.Add(chain);
                idle.Sort((left, right) => right.LastUsed.CompareTo(left.LastUsed));
                evicted = idle.Skip(IdleLimit).ToArray();
                foreach (var old in evicted)
                    idle.Remove(old);
                admitted = idle.Contains(chain);
            }
            else
                evicted = [chain];
        }
        foreach (var old in evicted)
        {
            old.Timer?.Dispose();
            Close(old.Resource, "lru-or-shutdown");
        }
        if (!admitted)
            return;
        var timer = Clock.CreateTimer(
            _ =>
            {
                var removed = false;
                lock (gate)
                    removed = idle.Remove(chain);
                if (removed)
                    Close(chain.Resource, "idle-timeout");
            },
            null,
            TimeSpan.FromMilliseconds(IdleTimeoutMs),
            Timeout.InfiniteTimeSpan
        );
        bool keepTimer;
        lock (gate)
        {
            keepTimer = idle.Contains(chain);
            if (keepTimer)
                chain.Timer = timer;
        }
        if (!keepTimer)
            timer.Dispose();
    }

    internal async Task<WsPendingCompletion> RequestAsync(
        Uri endpoint,
        IReadOnlyDictionary<string, string> headers,
        string concreteIdentity,
        JsonObject body,
        ResponsesStreamCallbacks callbacks,
        int? inactivityMs,
        CancellationToken caller,
        string? sessionId = null,
        string purpose = "low-level",
        CancellationToken? lifetimeCaller = null
    )
    {
        caller.ThrowIfCancellationRequested();
        var url = new UriBuilder(endpoint);
        url.Scheme = endpoint.Scheme switch
        {
            "https" => "wss",
            "http" => "ws",
            "ws" or "wss" => endpoint.Scheme,
            _ => throw new ModelPreparationException(
                "WebSocket provider requires an HTTP(S) or WS(S) URL."
            ),
        };
        var uri = url.Uri;
        var headerData = new JsonObject();
        foreach (var (name, value) in headers)
            headerData[name] = value;
        var connection = ModelRoutingFingerprint.Hash(
            new JsonObject
            {
                ["url"] = uri.ToString(),
                ["headers"] = headerData,
                ["concreteIdentity"] = concreteIdentity,
            }
        );
        var fingerprint = ResponsesWsState.Fingerprint(body);
        var matched = Take(connection, fingerprint);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(caller);
        using var watchdog = new StreamActivityWatchdog(deadline, inactivityMs, Clock);
        var watched = new ResponsesStreamCallbacks
        {
            OnProgress = callbacks.OnProgress,
            OnOutputItemDone = callbacks.OnOutputItemDone,
            OnResponseCompleted = callbacks.OnResponseCompleted,
            OnDecodedChunk = callbacks.OnDecodedChunk,
            OnSseBlock = callbacks.OnSseBlock,
            OnMeaningfulProgress = () =>
            {
                watchdog.Progress();
                callbacks.OnMeaningfulProgress?.Invoke();
            },
            OnImageGenerationActivity = () =>
            {
                watchdog.ExtendedActivity();
                callbacks.OnImageGenerationActivity?.Invoke();
            },
            OnSafetyBuffering = value =>
            {
                watchdog.ExtendedActivity();
                callbacks.OnSafetyBuffering?.Invoke(value);
            },
        };
        var resource = matched?.Resource;
        try
        {
            if (resource is null)
            {
                var socket = socketFactory?.Invoke() ?? new ClientWebSocket();
                socket.Options.KeepAliveInterval = Timeout.InfiniteTimeSpan;
                socket.Options.DangerousDeflateOptions = new WebSocketDeflateOptions();
                socket.Options.CollectHttpResponseDetails = true;
                foreach (var (name, value) in headers)
                    socket.Options.SetRequestHeader(name, value);
                var invoker = new HttpMessageInvoker(new WsHandshakeHeaders(headers));
                resource = new ResponsesWsResource(
                    this,
                    socket,
                    Guid.NewGuid().ToString("N"),
                    invoker
                );
                bool admitted;
                lock (gate)
                {
                    admitted = !disposed;
                    if (admitted)
                        resources.Add(resource);
                }
                if (!admitted)
                {
                    resource.Abort("shutdown-admission");
                    throw new ObjectDisposedException(nameof(ResponsesWsTransport));
                }
                try
                {
                    await socket.ConnectAsync(uri, invoker, deadline.Token).ConfigureAwait(false);
                }
                catch (Exception error)
                    when (!caller.IsCancellationRequested && !deadline.IsCancellationRequested)
                {
                    throw new ModelAttemptFailure(
                        "OpenAI Responses WebSocket handshake failed"
                            + (
                                socket.HttpStatusCode != 0
                                    ? " (HTTP " + (int)socket.HttpStatusCode + ")."
                                    : "."
                            ),
                        "request-error",
                        true,
                        true,
                        inner: error
                    );
                }
                resource.StartPump();
            }
            var lease = resource.Begin(watched, lifetimeCaller ?? caller, watchdog.Finish);
            using var abortDeadline = deadline.Token.Register(() =>
                resource.Abort("attempt-timeout-or-abort")
            );
            var wire = (JsonObject)body.DeepClone();
            wire.Remove("stream");
            wire.Remove("previous_response_id");
            var input = body["input"] as JsonArray ?? [];
            wire["input"] = new JsonArray(
                input
                    .Skip(matched?.Expected.ItemCount ?? 0)
                    .Select(item => item?.DeepClone())
                    .ToArray()
            );
            if (matched is not null)
            {
                wire["previous_response_id"] = matched.PreviousId;
                wire.Remove("max_output_tokens");
            }
            var envelope = new JsonObject { ["type"] = "response.create" };
            foreach (var (name, value) in wire)
                envelope[name] = value?.DeepClone();
            resource.SessionId = sessionId;
            resource.Purpose = purpose;
            resource.FullItems = input.Count;
            resource.SentItems = input.Count - (matched?.Expected.ItemCount ?? 0);
            resource.ConnectionMode = matched is null ? "fresh" : "reused";
            resource.MarkSent();
            Log(resource, "dispatch", resource.ConnectionMode);
            await resource
                .Socket.SendAsync(
                    Encoding.UTF8.GetBytes(EcmaJson.Stringify(envelope)).AsMemory(),
                    WebSocketMessageType.Text,
                    WebSocketMessageFlags.EndOfMessage | WebSocketMessageFlags.DisableCompression,
                    deadline.Token
                )
                .ConfigureAwait(false);
            var response = await lease
                .Completion.Task.WaitAsync(deadline.Token)
                .ConfigureAwait(false);
            caller.ThrowIfCancellationRequested();
            var responseId = SessionWait.Text(response["id"]);
            if (
                resource.Phase != WsPhase.Pending
                || resource.Socket.State != WebSocketState.Open
                || string.IsNullOrWhiteSpace(responseId)
                || (
                    CompletionsRequestSerializer.Truthy(response["status"])
                    && SessionWait.Text(response["status"]) != "completed"
                )
            )
                throw new IOException(
                    "OpenAI Responses WebSocket returned an incomplete completion or omitted its response id."
                );
            Log(resource, "completion", "response-completed");
            var captured = resource;
            var settled = 0;
            return new WsPendingCompletion(
                response,
                items =>
                {
                    if (Interlocked.Exchange(ref settled, 1) != 0)
                        return;
                    WsPrefix? expected = null;
                    try
                    {
                        if (items is not null)
                            expected = ResponsesWsState.Extend(fingerprint.Final, items);
                    }
                    catch
                    {
                        captured.Abort("replay-failure");
                        throw;
                    }
                    if (
                        items is null
                        || (lifetimeCaller ?? caller).IsCancellationRequested
                        || !captured.Release(lease)
                    )
                    {
                        captured.Abort("finalizer-discard");
                        return;
                    }
                    var now = Clock.GetUtcNow();
                    Release(
                        new Chain(
                            captured,
                            connection,
                            fingerprint.Invariant,
                            expected!,
                            responseId.Trim(),
                            matched?.Created ?? now,
                            now
                        )
                    );
                }
            );
        }
        catch (Exception error)
        {
            resource?.Abort("request-failure");
            if (caller.IsCancellationRequested)
                throw new OperationCanceledException(caller);
            if (deadline.IsCancellationRequested)
                throw new TimeoutException("OpenAI Responses WebSocket request timed out.", error);
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        ResponsesWsResource[] all;
        lock (gate)
        {
            disposed = true;
            all = resources.ToArray();
        }
        foreach (var resource in all)
        {
            if (resource.Phase == WsPhase.Idle)
                Close(resource, "pool-clear");
            else
                resource.Abort("shutdown");
        }
        Task[] tasks;
        lock (gate)
            tasks = closing.ToArray();
        await Task.WhenAll(tasks.Concat(all.Select(resource => resource.Pump)))
            .ConfigureAwait(false);
    }
}

internal sealed record WsPendingCompletion(
    JsonObject Response,
    Action<IReadOnlyList<JsonNode?>?> Finalize
);

internal sealed class WsHandshakeHeaders(IReadOnlyDictionary<string, string> headers)
    : DelegatingHandler(new SocketsHttpHandler { UseCookies = false })
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken token
    )
    {
        foreach (var (name, value) in headers)
        {
            if (
                request.Headers.Any(header =>
                    header.Key.Equals(name, StringComparison.OrdinalIgnoreCase)
                ) || request.Headers.TryAddWithoutValidation(name, value)
            )
                continue;
            request.Content ??= new ByteArrayContent([]);
            request.Content.Headers.Remove(name);
            request.Content.Headers.TryAddWithoutValidation(name, value);
        }
        return base.SendAsync(request, token);
    }
}
