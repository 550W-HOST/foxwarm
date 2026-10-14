using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Foxwarm.Tests;

public sealed class ResponsesWsTests
{
    [Fact]
    public async Task Empty_completed_socket_response_retains_usage_without_fabricating_an_assistant()
    {
        await using var peer = await WsPeer.StartAsync(
            (_, number) =>
            {
                var response = Response(number);
                response["output"] = new JsonArray();
                response["usage"] = new JsonObject { ["input_tokens"] = 13, ["output_tokens"] = 2 };
                return response;
            }
        );
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var service = new ResponsesWsChatService(
            Options(peer.Uri),
            transport,
            ModelRequestScope.Canonical,
            false,
            "lineage"
        );
        var result = await service.ChatAsync(
            "session",
            [Message("user", "input")],
            CancellationToken.None
        );
        Assert.Null(result.AssistantMessage);
        Assert.Equal(13, result.Usage!["inputTokens"]!.GetValue<long>());
        Assert.Equal(2, result.Usage["outputTokens"]!.GetValue<long>());
        result.FinalizeHistory(null);
    }

    [Fact]
    public void Fixed_source_item_boundary_hash_vector_includes_tagged_invariant_and_ignores_transport_fields()
    {
        var body = JsonNode
            .Parse(
                """{"model":"model","max_output_tokens":713,"input":[{"role":"user","content":[{"text":"Ω","type":"input_text"}]}],"stream":true,"previous_response_id":"ignored"}"""
            )!
            .AsObject();
        var value = ResponsesWsState.Fingerprint(body);
        Assert.Equal(
            "sha256:c9f4aebc8183834a1f6145005cedbf4f1aa10fd806ae812a0d20779d522d02e9",
            value.Invariant
        );
        Assert.Equal(
            "7432d05128fa4380ec30c67119afa806b4e1eba62c23a6f355651b345274eff8",
            value.Final.Hash
        );
        Assert.Equal(1, value.Final.ItemCount);
        body.Remove("stream");
        body.Remove("previous_response_id");
        Assert.Equal(value.Final, ResponsesWsState.Fingerprint(body).Final);
        body["max_output_tokens"] = 714;
        Assert.NotEqual(value.Invariant, ResponsesWsState.Fingerprint(body).Invariant);
    }

    [Theory]
    [InlineData("true")]
    [InlineData("17")]
    [InlineData("\"incomplete\"")]
    public async Task Truthy_noncompleted_provider_status_is_not_reusable(string status)
    {
        await using var peer = await WsPeer.StartAsync(
            (_, number) =>
            {
                var response = Response(number);
                response["status"] = JsonNode.Parse(status);
                return response;
            }
        );
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var service = new ResponsesWsChatService(
            Options(peer.Uri),
            transport,
            ModelRequestScope.Canonical,
            false,
            "lineage"
        );
        await Assert.ThrowsAsync<IOException>(() =>
            service.ChatAsync("session", [Message("user", "input")], CancellationToken.None)
        );
        await UntilAsync(() => transport.ResourceCount == 0);
        Assert.Equal(0, transport.IdleCount);
    }

    [Fact]
    public async Task Real_socket_full_then_owned_append_suffix_preserves_headers_and_compressed_events()
    {
        await using var peer = await WsPeer.StartAsync();
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var options = Options(peer.Uri) with
        {
            ExtraHeaders = new JsonObject
            {
                ["X-Auth"] = "synthetic",
                ["Content-Type"] = "application/vendor-json",
            },
        };
        var service = new ResponsesWsChatService(
            options,
            transport,
            ModelRequestScope.Canonical,
            false,
            "lineage"
        );
        var history = new List<JsonObject> { Message("user", "first") };
        var first = await service.ChatAsync("same-session", history, CancellationToken.None);
        Assert.Equal(0, transport.IdleCount);
        Assert.Equal(1, transport.ResourceCount);
        history.Add(first.AssistantMessage!);
        first.FinalizeHistory([first.AssistantMessage!]);
        Assert.Equal(1, transport.IdleCount);
        history.Add(Message("user", "next"));
        var second = await service.ChatAsync("same-session", history, CancellationToken.None);
        second.FinalizeHistory([second.AssistantMessage!]);
        Assert.Equal(1, peer.Connections);
        Assert.Equal(2, peer.Requests.Count);
        Assert.False(peer.Requests[0].ContainsKey("previous_response_id"));
        Assert.Equal(713, peer.Requests[0]["max_output_tokens"]!.GetValue<int>());
        Assert.Equal("response-1", peer.Requests[1]["previous_response_id"]!.GetValue<string>());
        Assert.Single((JsonArray)peer.Requests[1]["input"]!);
        Assert.False(peer.Requests[1].ContainsKey("max_output_tokens"));
        Assert.Equal(
            ProviderPromptCache.Resolve("openai-ws", "same-session", "different-lineage"),
            peer.Requests[0]["prompt_cache_key"]!.GetValue<string>()
        );
        Assert.Equal("application/vendor-json", peer.Headers[0]["Content-Type"]);
        Assert.Equal("0", peer.Headers[0]["Content-Length"]);
        Assert.Equal("Bearer synthetic", peer.Headers[0]["Authorization"]);
        Assert.Equal("codex-tui", peer.Headers[0]["originator"]);
        Assert.Contains("permessage-deflate", peer.Headers[0]["Sec-WebSocket-Extensions"]);
        Assert.Contains("answer", first.AssistantMessage!.ToJsonString());
    }

    [Fact]
    public async Task Pending_caller_stop_discards_without_poisoning_other_sessions_and_lowlevel_never_reuses()
    {
        await using var peer = await WsPeer.StartAsync();
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var service = new ResponsesWsChatService(
            Options(peer.Uri),
            transport,
            ModelRequestScope.Canonical,
            false,
            "lineage"
        );
        using var caller = new CancellationTokenSource();
        var stopped = await service.ChatAsync("stopped", [Message("user", "first")], caller.Token);
        var other = await service.ChatAsync(
            "other",
            [Message("user", "second")],
            CancellationToken.None
        );
        other.FinalizeHistory([other.AssistantMessage!]);
        caller.Cancel();
        stopped.FinalizeHistory([stopped.AssistantMessage!]);
        Assert.Equal(1, transport.IdleCount);
        var next = await service.ChatAsync(
            "other",
            [Message("user", "second"), other.AssistantMessage!, Message("user", "next")],
            CancellationToken.None
        );
        next.FinalizeHistory([next.AssistantMessage!]);
        Assert.Equal("response-2", peer.Requests[2]["previous_response_id"]!.GetValue<string>());
        var low = new ResponsesWsChatService(
            Options(peer.Uri),
            transport,
            ModelRequestScope.LowLevel,
            false,
            "lineage"
        );
        await low.ChatAsync("low", [Message("user", "direct")], CancellationToken.None);
        await low.ChatAsync("low", [Message("user", "direct")], CancellationToken.None);
        Assert.False(peer.Requests[^1].ContainsKey("previous_response_id"));
        Assert.Equal(4, peer.Connections);
    }

    [Fact]
    public async Task Unusable_completion_and_ambiguous_close_discard_only_own_resource()
    {
        await using var peer = await WsPeer.StartAsync(
            (wire, number) =>
                number == 1
                    ? new JsonObject { ["status"] = "completed", ["output"] = new JsonArray() }
                    : Response(number)
        );
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var service = new ResponsesWsChatService(
            Options(peer.Uri),
            transport,
            ModelRequestScope.Canonical,
            false,
            "lineage"
        );
        await Assert.ThrowsAsync<IOException>(() =>
            service.ChatAsync("one", [Message("user", "first")], CancellationToken.None)
        );
        Assert.Equal(0, transport.IdleCount);
        var next = await service.ChatAsync(
            "one",
            [Message("user", "first")],
            CancellationToken.None
        );
        next.FinalizeHistory([next.AssistantMessage!]);
        Assert.Equal(2, peer.Connections);
        Assert.False(peer.Requests[1].ContainsKey("previous_response_id"));
    }

    [Fact]
    public async Task Source_idle_age_and_lru_defaults_close_real_sockets_and_stale_timer_cannot_close_pending()
    {
        await using var peer = await WsPeer.StartAsync();
        var clock = new ManualWsClock();
        await using var transport = new ResponsesWsTransport(clock, diagnostics: _ => { });
        var service = new ResponsesWsChatService(
            Options(peer.Uri),
            transport,
            ModelRequestScope.Canonical,
            false,
            "lineage"
        );
        var history = new List<JsonObject> { Message("user", "first") };
        var result = await service.ChatAsync("same", history, CancellationToken.None);
        history.Add(result.AssistantMessage!);
        result.FinalizeHistory([result.AssistantMessage!]);
        var oldTimer = clock.LastTimer!;
        history.Add(Message("user", "second"));
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.BeforeResponse = _ => held.Task;
        var active = service.ChatAsync("same", history, CancellationToken.None);
        await UntilAsync(() => peer.Requests.Count == 2);
        oldTimer.Fire();
        Assert.Equal(1, transport.ResourceCount);
        held.TrySetResult();
        result = await active;
        peer.BeforeResponse = null;
        oldTimer.Fire();
        Assert.Equal(0, transport.IdleCount);
        Assert.Equal(1, transport.ResourceCount);
        history.Add(result.AssistantMessage!);
        result.FinalizeHistory([result.AssistantMessage!]);
        clock.Advance(TimeSpan.FromMinutes(10));
        await UntilAsync(() => transport.ResourceCount == 0);
        Assert.Contains(1000, peer.CloseCodes);
        for (var i = 0; i < 6; i++)
        {
            var row = await service.ChatAsync(
                "unique" + i,
                [Message("user", "request")],
                CancellationToken.None
            );
            row.FinalizeHistory([row.AssistantMessage!]);
        }
        await UntilAsync(() => transport.ResourceCount == 5);
        Assert.Equal(5, transport.IdleCount);
        Assert.Equal(7, peer.Connections);
    }

    [Fact]
    public async Task Reused_chain_age_starts_at_first_committed_completion_and_expires_at_sixty_minutes()
    {
        await using var peer = await WsPeer.StartAsync();
        var clock = new ManualWsClock();
        await using var transport = new ResponsesWsTransport(clock, diagnostics: _ => { });
        var service = new ResponsesWsChatService(
            Options(peer.Uri),
            transport,
            ModelRequestScope.CompactPlan,
            false,
            "lineage"
        );
        var history = new List<JsonObject> { Message("user", "first") };
        for (var i = 0; i < 7; i++)
        {
            var result = await service.ChatAsync("same", history, CancellationToken.None);
            history.Add(result.AssistantMessage!);
            result.FinalizeHistory([result.AssistantMessage!]);
            history.Add(Message("user", "round" + i));
            if (i < 6)
                clock.Advance(TimeSpan.FromMinutes(9));
        }
        Assert.Equal(1, peer.Connections);
        clock.Advance(TimeSpan.FromMinutes(6));
        var final = await service.ChatAsync("same", history, CancellationToken.None);
        final.FinalizeHistory([final.AssistantMessage!]);
        Assert.Equal(2, peer.Connections);
        Assert.False(peer.Requests[^1].ContainsKey("previous_response_id"));
        Assert.Equal(713, peer.Requests[^1]["max_output_tokens"]!.GetValue<int>());
        await UntilAsync(() => peer.CloseCodes.Contains(1000));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Normal_owner_assistant_append_failure_discards_pending_without_provider_or_effect_reissue(
        bool postrename
    )
    {
        await using var peer = await WsPeer.StartAsync((_, number) => ToolResponse(number));
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var store = new AssistantAppendStore(postrename);
        var tools = new EffectCounter();
        var registry = new SessionRegistry(
            store,
            new ResponsesWsChatService(
                Options(peer.Uri),
                transport,
                ModelRequestScope.Canonical,
                false,
                "lineage"
            ),
            tools
        );
        registry.TriggerOverride = _ => Task.CompletedTask;
        registry.Add("session");
        await registry.Ingress.EnqueueAsync("session", QueueItem.UserText("input"));
        if (postrename)
            await Assert.ThrowsAsync<AuthorityCommittedException>(() =>
                registry.Runner.ProcessQueueAsync("session")
            );
        else
            await registry.Runner.ProcessQueueAsync("session");
        await UntilAsync(() => transport.ResourceCount == 0);
        Assert.Single(peer.Requests);
        Assert.Equal(0, tools.Count);
        Assert.Equal(0, transport.IdleCount);
        if (!postrename)
            Assert.IsAssignableFrom<IOException>(
                registry.GetRequired("session").LastBackgroundProcessorFailure
            );
        Assert.Equal(
            postrename ? 1 : 0,
            registry
                .GetRequired("session")
                .Snapshot()
                .History.Count(row => row["role"]!.GetValue<string>() == "model")
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Actual_normal_append_barrier_releases_only_after_owned_commit_or_discards_on_pending_stop(
        bool stop
    )
    {
        await using var peer = await WsPeer.StartAsync(
            (_, number) => number == 1 ? ToolResponse(number) : Response(number)
        );
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var store = new AssistantAppendStore(null);
        var tools = new EffectCounter();
        var registry = new SessionRegistry(
            store,
            new ResponsesWsChatService(
                Options(peer.Uri),
                transport,
                ModelRequestScope.Canonical,
                false,
                "lineage"
            ),
            tools
        );
        registry.TriggerOverride = _ => Task.CompletedTask;
        registry.Add("session");
        await registry.Ingress.EnqueueAsync("session", QueueItem.UserText("input"));
        var processing = registry.Runner.ProcessQueueAsync("session");
        await store.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, transport.IdleCount);
        Assert.Equal(1, transport.ResourceCount);
        Assert.Equal(0, tools.Count);
        Task? stopping = stop ? registry.Control.StopAsync("session") : null;
        store.Release.TrySetResult();
        await processing;
        if (stopping is not null)
            await stopping;
        if (stop)
        {
            await UntilAsync(() => transport.ResourceCount == 0);
            Assert.Single(peer.Requests);
            Assert.Equal(0, tools.Count);
        }
        else
        {
            Assert.Equal(1, tools.Count);
            Assert.Equal(2, peer.Requests.Count);
            Assert.Equal(
                "response-1",
                peer.Requests[1]["previous_response_id"]!.GetValue<string>()
            );
            Assert.Equal(1, transport.IdleCount);
        }
    }

    private static JsonObject ToolResponse(int number) =>
        new()
        {
            ["id"] = "response-" + number,
            ["status"] = "completed",
            ["output"] = new JsonArray(
                new JsonObject
                {
                    ["type"] = "function_call",
                    ["id"] = "output-call",
                    ["call_id"] = "call",
                    ["name"] = "write",
                    ["arguments"] = "{}",
                }
            ),
        };

    private sealed class EffectCounter : ITurnToolExecutor
    {
        internal int Count;

        public Task<JsonNode?> ExecuteAsync(JsonObject call, CancellationToken token)
        {
            Count++;
            return Task.FromResult<JsonNode?>(new JsonObject { ["output"] = "effect" });
        }
    }

    private sealed class AssistantAppendStore(bool? postrename)
        : ISessionAuthorityStore,
            ICanonicalAppendAuthorityStore
    {
        internal TaskCompletionSource Entered =
                new(TaskCreationOptions.RunContinuationsAsynchronously),
            Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int held;

        public Task CommitAsync(
            SessionSnapshot snapshot,
            SaveKind kind,
            CancellationToken token = default
        ) => Task.CompletedTask;

        public Task<SessionSnapshot?> LoadAsync(string id, CancellationToken token = default) =>
            Task.FromResult<SessionSnapshot?>(null);

        public async Task CommitCanonicalAppendAsync(
            SessionSnapshot snapshot,
            IReadOnlyList<JsonObject> rows,
            CancellationToken token = default
        )
        {
            if (!rows.Any(row => row["role"]!.GetValue<string>() == "model"))
                return;
            if (postrename == true)
                throw new AuthorityCommittedException(
                    "owned rename committed",
                    new IOException("directory sync failed")
                );
            if (postrename == false)
                throw new IOException("assistant append failed");
            if (Interlocked.Exchange(ref held, 1) != 0)
                return;
            Entered.TrySetResult();
            await Release.Task;
        }
    }

    [Fact]
    public async Task Healthy_idle_output_close_drains_for_thirty_seconds_then_aborts_unresponsive_peer()
    {
        await using var peer = await WsPeer.StartAsync();
        peer.ReplyToClose = false;
        var clock = new ManualWsClock();
        await using var transport = new ResponsesWsTransport(clock, diagnostics: _ => { });
        var service = new ResponsesWsChatService(
            Options(peer.Uri),
            transport,
            ModelRequestScope.Canonical,
            false,
            "lineage"
        );
        var result = await service.ChatAsync(
            "session",
            [Message("user", "input")],
            CancellationToken.None
        );
        result.FinalizeHistory([result.AssistantMessage!]);
        clock.Advance(TimeSpan.FromMinutes(10));
        await UntilAsync(() => peer.CloseCodes.Contains(1000));
        Assert.Equal(1, transport.ResourceCount);
        clock.Advance(TimeSpan.FromSeconds(29));
        Assert.Equal(1, transport.ResourceCount);
        clock.Advance(TimeSpan.FromSeconds(1));
        await UntilAsync(() => transport.ResourceCount == 0);
    }

    [Fact]
    public async Task Prior_finalized_caller_cannot_cancel_the_same_resource_reused_by_a_new_caller()
    {
        await using var peer = await WsPeer.StartAsync();
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var service = new ResponsesWsChatService(
            Options(peer.Uri),
            transport,
            ModelRequestScope.Canonical,
            false,
            "lineage"
        );
        using var prior = new CancellationTokenSource();
        var first = await service.ChatAsync("session", [Message("user", "first")], prior.Token);
        first.FinalizeHistory([first.AssistantMessage!]);
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.BeforeResponse = _ => held.Task;
        var next = service.ChatAsync(
            "session",
            [Message("user", "first"), first.AssistantMessage!, Message("user", "next")],
            CancellationToken.None
        );
        await UntilAsync(() => peer.Requests.Count == 2);
        prior.Cancel();
        Assert.Equal(1, transport.ResourceCount);
        Assert.False(next.IsCompleted);
        held.TrySetResult();
        var completed = await next;
        completed.FinalizeHistory([completed.AssistantMessage!]);
        Assert.Equal(1, peer.Connections);
        Assert.Equal(1, transport.IdleCount);
    }

    [Fact]
    public void Finalizer_failure_warns_once_and_cannot_poison_a_successful_result_or_settle_twice()
    {
        var settled = 0;
        var warned = 0;
        var result = new ChatResult(Message("model", "committed"))
        {
            HistoryAppend = new HistoryAppendFinalizer(_ =>
            {
                settled++;
                throw new IOException("replay callback failed");
            }),
        };
        result.FinalizeHistory(
            [result.AssistantMessage!],
            _ =>
            {
                warned++;
                throw new IOException("observer failed");
            }
        );
        result.FinalizeHistory(null, _ => warned++);
        Assert.Equal(1, settled);
        Assert.Equal(1, warned);
        Assert.Equal(
            "committed",
            result.AssistantMessage!["parts"]![0]!["text"]!.GetValue<string>()
        );
    }

    [Theory]
    [InlineData("[]", false)]
    [InlineData("", true)]
    public async Task Canonical_argument_parser_controls_reuse_including_array_error_and_allowed_empty_string(
        string arguments,
        bool reusable
    )
    {
        await using var peer = await WsPeer.StartAsync(
            (_, number) =>
            {
                if (number > 1)
                    return Response(number);
                var response = ToolResponse(number);
                response["output"]![0]!["arguments"] = arguments;
                return response;
            }
        );
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var service = new ResponsesWsChatService(
            Options(peer.Uri),
            transport,
            ModelRequestScope.Canonical,
            false,
            "lineage"
        );
        var history = new List<JsonObject> { Message("user", "request") };
        var result = await service.ChatAsync("session", history, CancellationToken.None);
        var call = result.AssistantMessage!["parts"]![0]!["functionCall"]!;
        Assert.Equal(!reusable, call["argsParseError"] is not null);
        history.Add(result.AssistantMessage);
        result.FinalizeHistory([result.AssistantMessage]);
        history.Add(
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "call",
                            ["name"] = "write",
                            ["response"] = new JsonObject { ["output"] = "paired" },
                        },
                    }
                ),
            }
        );
        var next = await service.ChatAsync("session", history, CancellationToken.None);
        next.FinalizeHistory([next.AssistantMessage!]);
        Assert.Equal(reusable, peer.Requests[1].ContainsKey("previous_response_id"));
        Assert.Equal(reusable ? 1 : 2, peer.Connections);
    }

    internal static async Task UntilAsync(Func<bool> check)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!check())
            await Task.Delay(5, timeout.Token);
    }

    internal static JsonObject Message(string role, string text) =>
        new() { ["role"] = role, ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    internal static ResponsesClientOptions Options(Uri uri) =>
        new(uri, "m", "ws/m", "synthetic", "prompt", 713, StreamInactivityTimeoutMs: 60000);

    internal static JsonObject Response(int number) =>
        new()
        {
            ["id"] = "response-" + number,
            ["status"] = "completed",
            ["output"] = new JsonArray(
                new JsonObject
                {
                    ["type"] = "message",
                    ["role"] = "assistant",
                    ["content"] = new JsonArray(
                        new JsonObject { ["type"] = "output_text", ["text"] = "answer" }
                    ),
                }
            ),
        };
}

internal sealed class WsPeer : IAsyncDisposable
{
    private readonly WebApplication app;
    private readonly CancellationTokenSource stop = new();
    private readonly object gate = new();
    private readonly Func<JsonObject, int, JsonObject> response;
    private int connections;
    internal Func<JsonObject, Task>? BeforeResponse;
    internal bool ReplyToClose = true;
    internal Uri Uri { get; private set; } = null!;
    internal int Connections => Volatile.Read(ref connections);
    internal List<JsonObject> Requests { get; } = [];
    internal List<int?> CloseCodes { get; } = [];
    internal List<Dictionary<string, string>> Headers { get; } = [];

    private WsPeer(WebApplication app, Func<JsonObject, int, JsonObject>? response)
    {
        this.app = app;
        this.response = response ?? ((_, number) => ResponsesWsTests.Response(number));
    }

    internal static async Task<WsPeer> StartAsync(
        Func<JsonObject, int, JsonObject>? response = null
    )
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();
        var peer = new WsPeer(app, response);
        app.UseWebSockets();
        app.Map("/responses", peer.HandleAsync);
        await app.StartAsync();
        peer.Uri = new Uri(app.Urls.Single());
        return peer;
    }

    private async Task HandleAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = 400;
            return;
        }
        Interlocked.Increment(ref connections);
        lock (gate)
            Headers.Add(
                context.Request.Headers.ToDictionary(
                    pair => pair.Key,
                    pair => pair.Value.ToString(),
                    StringComparer.OrdinalIgnoreCase
                )
            );
        using var socket = await context.WebSockets.AcceptWebSocketAsync(
            new WebSocketAcceptContext { DangerousEnableCompression = true }
        );
        try
        {
            var buffer = new byte[16384];
            using var bytes = new MemoryStream();
            while (!stop.IsCancellationRequested)
            {
                var read = await socket.ReceiveAsync(buffer.AsMemory(), stop.Token);
                if (read.MessageType == WebSocketMessageType.Close)
                {
                    lock (gate)
                        CloseCodes.Add((int?)socket.CloseStatus);
                    if (ReplyToClose)
                        await socket.CloseOutputAsync(
                            WebSocketCloseStatus.NormalClosure,
                            "OK",
                            stop.Token
                        );
                    else
                        await Task.Delay(Timeout.InfiniteTimeSpan, stop.Token);
                    break;
                }
                bytes.Write(buffer, 0, read.Count);
                if (!read.EndOfMessage)
                    continue;
                var wire = (JsonObject)
                    JsonNode.Parse(
                        Encoding.UTF8.GetString(bytes.GetBuffer(), 0, (int)bytes.Length)
                    )!;
                bytes.SetLength(0);
                int number;
                lock (gate)
                {
                    Requests.Add(wire);
                    number = Requests.Count;
                }
                if (BeforeResponse is not null)
                    await BeforeResponse(wire);
                var completed = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = response(wire, number),
                };
                await socket.SendAsync(
                    Encoding.UTF8.GetBytes(completed.ToJsonString()).AsMemory(),
                    WebSocketMessageType.Text,
                    WebSocketMessageFlags.EndOfMessage,
                    stop.Token
                );
            }
        }
        catch (Exception) when (stop.IsCancellationRequested || socket.State != WebSocketState.Open)
        { }
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        await app.StopAsync();
        await app.DisposeAsync();
        stop.Dispose();
    }
}

internal sealed class ManualWsClock : TimeProvider
{
    private DateTimeOffset now = DateTimeOffset.UnixEpoch;
    private readonly List<ManualTimer> timers = [];
    internal ManualTimer? LastTimer => timers.LastOrDefault();

    public override DateTimeOffset GetUtcNow() => now;

    public override ITimer CreateTimer(
        TimerCallback callback,
        object? state,
        TimeSpan due,
        TimeSpan period
    )
    {
        var timer = new ManualTimer(this, callback, state);
        timers.Add(timer);
        timer.Change(due, period);
        return timer;
    }

    internal void Advance(TimeSpan interval)
    {
        now += interval;
        foreach (var timer in timers.ToArray())
            if (!timer.Disposed && timer.Due is DateTimeOffset due && due <= now)
            {
                timer.Due = null;
                timer.Fire();
            }
    }

    internal sealed class ManualTimer(ManualWsClock clock, TimerCallback callback, object? state)
        : ITimer
    {
        internal DateTimeOffset? Due;
        internal bool Disposed;

        internal void Fire() => callback(state);

        public bool Change(TimeSpan due, TimeSpan period)
        {
            Due = due == Timeout.InfiniteTimeSpan ? null : clock.now + due;
            return !Disposed;
        }

        public void Dispose() => Disposed = true;

        public ValueTask DisposeAsync()
        {
            Dispose();
            return default;
        }
    }
}
