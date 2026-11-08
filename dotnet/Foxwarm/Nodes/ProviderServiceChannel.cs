using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

/// <summary>
/// The optional persistent Code/Terminal service channel of one executable-Provider Node.
/// One child process per transport generation: Main sends a <c>connect</c> envelope, then both
/// sides exchange the resident <c>node_service_*</c> frames as NDJSON until the pipe closes.
/// A closed or failed channel ends that generation; the next use starts a new one and never
/// replays a request.
/// </summary>
internal sealed class ProviderServiceChannel : IAsyncDisposable
{
    /// <summary>Largest frame in either direction; contains a 50 MiB file as base64 with its envelope.</summary>
    internal const int FrameLimit = 72 * 1024 * 1024;
    private const int HandshakeLimit = 64 * 1024;
    private static readonly TimeSpan RequestDeadline = TimeSpan.FromSeconds(30);

    private readonly ExecutableNodeProvider provider;
    private readonly string localId;
    private readonly string qualifiedId;
    private readonly object gate = new();
    private readonly CancellationTokenSource shutdown = new();
    private readonly ConcurrentDictionary<string, Invocation> calls = new(StringComparer.Ordinal);
    private Generation? current;
    private Task<Generation>? starting;
    private bool disposed;

    internal event Action<NodeServiceEvent>? ServiceReceived;
    internal event Action<Guid, string>? Disconnected;

    private sealed record Invocation(
        Generation Generation,
        NodeServiceTarget Target,
        TaskCompletionSource<JsonObject> Result,
        Action<JsonObject>? Receive
    );

    internal ProviderServiceChannel(
        ExecutableNodeProvider provider,
        string localId,
        string qualifiedId
    )
    {
        this.provider = provider;
        this.localId = localId;
        this.qualifiedId = qualifiedId;
    }

    internal sealed class Generation(Process child, JsonObject services)
    {
        internal readonly Guid Id = Guid.NewGuid();
        internal readonly Process Child = child;
        internal readonly SemaphoreSlim SendGate = new(1, 1);
        internal JsonObject Services = services;
        internal volatile bool Ended;
        internal NdjsonLineReader Reader = null!;

        internal int Version(string service) =>
            SessionWait.Number(Services[service]) is double version
            && version >= 1
            && version <= int.MaxValue
            && version == Math.Truncate(version)
                ? (int)version
                : 0;
    }

    /// <summary>The live generation, if any; it does not start a process.</summary>
    internal Generation? Live
    {
        get
        {
            lock (gate)
                return current is { Ended: false } generation ? generation : null;
        }
    }

    internal Task<Generation> EnsureAsync(CancellationToken token)
    {
        lock (gate)
        {
            if (disposed)
                throw Unavailable("Node service channel is closed.");
            if (current is { Ended: false } live)
                return Task.FromResult(live);
            starting ??= StartAndPublishAsync();
            return starting.WaitAsync(token);
        }
    }

    private async Task<Generation> StartAndPublishAsync()
    {
        try
        {
            var generation = await ConnectAsync();
            bool closed;
            lock (gate)
            {
                closed = disposed;
                if (!closed)
                    current = generation;
            }
            if (closed)
            {
                End(generation, "Node service channel is closed.");
                throw Unavailable("Node service channel is closed.");
            }
            _ = Task.Run(() => PumpAsync(generation));
            return generation;
        }
        finally
        {
            lock (gate)
                starting = null;
        }
    }

    private async Task<Generation> ConnectAsync()
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(shutdown.Token);
        deadline.CancelAfter(TimeSpan.FromSeconds(provider.TimeoutSeconds));
        Process child;
        try
        {
            child = provider.StartProcess();
        }
        catch (NodeProviderException error)
        {
            throw Unavailable("Node service channel could not be started: " + error.Code);
        }
        var generation = new Generation(child, new());
        // Diagnostics are drained and discarded: a long-lived process must not stall on stderr,
        // and raw provider diagnostics are never returned to callers.
        _ = Task.Run(() => DrainAsync(child.StandardError.BaseStream));
        var envelope = new JsonObject
        {
            ["protocol"] = ExecutableNodeProvider.Protocol,
            ["providerId"] = provider.Id,
            ["requestId"] = Guid.NewGuid().ToString(),
            ["operation"] = "connect",
            ["request"] = new JsonObject { ["nodeId"] = localId },
        };
        try
        {
            generation.Reader = new NdjsonLineReader(child.StandardOutput.BaseStream, FrameLimit);
            await NdjsonLineReader
                .WriteAsync(
                    child.StandardInput.BaseStream,
                    Encoding.UTF8.GetBytes(envelope.ToJsonString()),
                    deadline.Token
                )
                .WaitAsync(deadline.Token);
            var frame =
                await generation
                    .Reader.ReadAsync(deadline.Token, HandshakeLimit)
                    .WaitAsync(deadline.Token)
                ?? throw new NodeProviderException(
                    "NODE_PROVIDER_PROCESS_EXIT",
                    "Provider exited before confirming the service channel.",
                    true
                );
            var result = ExecutableNodeProvider.Object(
                ExecutableNodeProvider.ParseResponse(
                    "connect",
                    envelope,
                    ExecutableNodeProvider.Object(ParseFrame(frame))
                )
            );
            ExecutableNodeProvider.Keys(result, ["nodeId", "services"]);
            if (SessionWait.Text(result["nodeId"]) != localId)
                throw new NodeProviderException(
                    "NODE_PROVIDER_NODE_MISMATCH",
                    "Provider confirmed a different Node."
                );
            if (result["services"] is not JsonObject confirmed || confirmed.Count > 16)
                throw ExecutableNodeProvider.Invalid("Provider connect must confirm services.");
            var services = new JsonObject();
            foreach (var (name, value) in confirmed)
            {
                if (
                    SessionWait.Number(value) is not double version
                    || version < 1
                    || version > 1000
                    || version != Math.Truncate(version)
                )
                    throw ExecutableNodeProvider.Invalid("Provider service version is invalid.");
                if (NodeServiceReplies.FixedServices.Contains(name))
                    services[name] = (int)version;
            }
            generation.Services = services;
            return generation;
        }
        catch (Exception error)
        {
            End(generation, "Node service channel could not be started.");
            throw error switch
            {
                NodeProviderException provided => Unavailable(
                    provided.Code == "NODE_PROVIDER_REPORTED_ERROR"
                        ? provided.Message
                        : "Node service channel could not be started: " + provided.Code
                ),
                OperationCanceledException => Unavailable(
                    "Node service channel did not become ready before its deadline."
                ),
                _ => Unavailable("Node service channel could not be started."),
            };
        }
    }

    private static JsonNode? ParseFrame(byte[] frame)
    {
        try
        {
            return JsonNode.Parse(frame);
        }
        catch (JsonException)
        {
            throw ExecutableNodeProvider.Invalid("Provider frame is not valid JSON.");
        }
    }

    private static async Task DrainAsync(Stream stream)
    {
        var buffer = new byte[8192];
        try
        {
            while (await stream.ReadAsync(buffer) > 0) { }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException) { }
    }

    private async Task PumpAsync(Generation generation)
    {
        // Output written just before exit is still in the pipe; allow it to drain before ending.
        _ = Task.Run(async () =>
        {
            try
            {
                await generation.Child.WaitForExitAsync();
                await Task.Delay(TimeSpan.FromSeconds(2));
            }
            catch (InvalidOperationException) { }
            End(generation, "Provider service channel closed.");
        });
        try
        {
            while (!generation.Ended)
            {
                var frame = await generation.Reader.ReadAsync(shutdown.Token);
                if (frame is null)
                {
                    End(generation, "Provider service channel closed.");
                    return;
                }
                if (!Dispatch(generation, frame))
                {
                    End(generation, "Provider service channel sent an invalid frame.");
                    return;
                }
            }
        }
        catch (Exception error)
            when (error
                    is InvalidDataException
                        or IOException
                        or JsonException
                        or ObjectDisposedException
                        or OperationCanceledException
            )
        {
            End(generation, "Provider service channel failed.");
        }
    }

    // False is a protocol violation that ends the generation; unknown or late replies are ignored.
    private bool Dispatch(Generation generation, byte[] frame)
    {
        JsonObject message;
        try
        {
            message = ExecutableNodeProvider.Object(JsonNode.Parse(frame));
        }
        catch (Exception error) when (error is JsonException or NodeProviderException)
        {
            return false;
        }
        if (generation.Ended)
            return true;
        var type = SessionWait.Text(message["type"]);
        switch (type)
        {
            case "node_service_response":
            case "node_service_error":
                var id = SessionWait.Text(message["requestId"]);
                if (
                    id is null
                    || !calls.TryGetValue(id, out var invocation)
                    || !ReferenceEquals(invocation.Generation, generation)
                    || (
                        message.ContainsKey("service")
                        && SessionWait.Text(message["service"]) != invocation.Target.Service
                    )
                    || !calls.TryRemove(id, out _)
                )
                    return true;
                NodeServiceReplies.Complete(
                    message,
                    type == "node_service_response",
                    invocation.Result,
                    invocation.Receive
                );
                return true;
            case "node_service_event":
                var service = SessionWait.Text(message["service"]);
                if (
                    service is null
                    || !NodeServiceReplies.FixedServices.Contains(service)
                    || message["event"] is not JsonObject payload
                    || generation.Version(service) < 1
                )
                    return true;
                ServiceReceived?.Invoke(
                    new(
                        new(qualifiedId, service, generation.Id, generation.Version(service)),
                        (JsonObject)payload.DeepClone()
                    )
                );
                return true;
            default:
                return false;
        }
    }

    internal NodeServiceTarget Target(Generation generation, string service, int minimumVersion)
    {
        var version = generation.Version(service);
        if (version < minimumVersion)
            throw new CodeServiceException(
                "UnsupportedService",
                $"Node '{qualifiedId}' does not advertise '{service}' version {minimumVersion} or newer.",
                501
            );
        return new(qualifiedId, service, generation.Id, version);
    }

    private Generation Require(NodeServiceTarget target)
    {
        var generation = Live;
        if (generation is null)
            throw Unavailable("Node service channel is closed.");
        if (generation.Id != target.ConnectionId)
            throw Unavailable("Node connection was replaced; the operation was not retried.");
        if (generation.Version(target.Service) < target.Version)
            throw new CodeServiceException(
                "UnsupportedService",
                $"Node '{qualifiedId}' does not advertise '{target.Service}'.",
                501
            );
        return generation;
    }

    internal async Task<JsonObject> RequestAsync(
        NodeServiceTarget target,
        string operation,
        JsonObject args,
        CancellationToken token,
        Action<JsonObject>? receive,
        Action? beforeSend
    )
    {
        var generation = Require(target);
        var requestId = "service_" + Guid.NewGuid().ToString("N");
        var invocation = new Invocation(
            generation,
            target,
            new(TaskCreationOptions.RunContinuationsAsynchronously),
            receive
        );
        calls[requestId] = invocation;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token, shutdown.Token);
        deadline.CancelAfter(RequestDeadline);
        try
        {
            await SendAsync(
                generation,
                new JsonObject
                {
                    ["type"] = "node_service_request",
                    ["requestId"] = requestId,
                    ["service"] = target.Service,
                    ["operation"] = operation,
                    ["args"] = args.DeepClone(),
                },
                deadline.Token,
                beforeSend
            );
            return await invocation.Result.Task.WaitAsync(deadline.Token);
        }
        catch (OperationCanceledException)
            when (!token.IsCancellationRequested && !shutdown.IsCancellationRequested)
        {
            throw new CodeServiceException(
                "NodeTimeout",
                "Node service request timed out. Effects may have occurred; the request was not retried.",
                504
            );
        }
        finally
        {
            calls.TryRemove(requestId, out _);
        }
    }

    internal Task CommandAsync(
        NodeServiceTarget target,
        string operation,
        JsonObject args,
        CancellationToken token
    ) =>
        SendAsync(
            Require(target),
            new JsonObject
            {
                ["type"] = "node_service_command",
                ["service"] = target.Service,
                ["operation"] = operation,
                ["args"] = args.DeepClone(),
            },
            token,
            null
        );

    private async Task SendAsync(
        Generation generation,
        JsonObject message,
        CancellationToken token,
        Action? beforeSend
    )
    {
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        if (bytes.Length > FrameLimit)
            throw new CodeServiceException(
                "PayloadTooLarge",
                "Node service request exceeds the channel frame limit.",
                413
            );
        await generation.SendGate.WaitAsync(token);
        try
        {
            if (generation.Ended || !ReferenceEquals(generation, Live))
                throw Unavailable("Node connection changed.");
            beforeSend?.Invoke();
            try
            {
                await NdjsonLineReader.WriteAsync(
                    generation.Child.StandardInput.BaseStream,
                    bytes,
                    token
                );
            }
            catch (Exception error)
                when (error is IOException or ObjectDisposedException or OperationCanceledException)
            {
                // A partial line would corrupt framing, so a failed or interrupted write ends the generation.
                End(generation, "Provider service channel write failed.");
                if (error is OperationCanceledException)
                    throw;
                throw Unavailable("Provider service channel write failed.");
            }
        }
        finally
        {
            generation.SendGate.Release();
        }
    }

    /// <summary>Closes the live generation; pending requests fail and its terminals are disconnected.</summary>
    internal void Retire(string reason)
    {
        var generation = Live;
        if (generation is not null)
            End(generation, reason);
    }

    private void End(Generation generation, string reason)
    {
        lock (gate)
        {
            if (generation.Ended)
                return;
            generation.Ended = true;
            if (ReferenceEquals(current, generation))
                current = null;
        }
        foreach (var pair in calls)
            if (
                ReferenceEquals(pair.Value.Generation, generation)
                && calls.TryRemove(pair.Key, out var invocation)
            )
                invocation.Result.TrySetException(
                    Unavailable(reason.TrimEnd('.') + ". Effects were not retried.")
                );
        Disconnected?.Invoke(generation.Id, reason);
        _ = Task.Run(() => TerminateAsync(generation));
    }

    // EOF on stdin is the normal disconnect; a child that ignores it is terminated.
    private static async Task TerminateAsync(Generation generation)
    {
        var child = generation.Child;
        try
        {
            try
            {
                child.StandardInput.Close();
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException) { }
            if (!child.HasExited)
                await Task.WhenAny(child.WaitForExitAsync(), Task.Delay(1000));
            if (!child.HasExited)
                await ExecutableNodeProvider.TerminateAsync(child);
        }
        catch (Exception error) when (error is NodeProviderException or InvalidOperationException)
        { }
        finally
        {
            child.Dispose();
        }
    }

    private static CodeServiceException Unavailable(string message) =>
        new("NodeUnavailable", message, 503);

    public async ValueTask DisposeAsync()
    {
        Generation? generation;
        lock (gate)
        {
            disposed = true;
            generation = current;
        }
        shutdown.Cancel();
        if (generation is not null)
            End(generation, "Node service channel is closed.");
        await Task.CompletedTask;
    }
}
