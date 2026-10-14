using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class AnthropicStreamingTests
{
    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();

    private static ResponsesClientOptions Options() =>
        new(new Uri("http://localhost"), "wire", "a/wire", "", "", 713);

    private static string Event(string json) => "data: " + json + "\n\n";

    private const string Start =
        """{"type":"message_start","message":{"id":"m","usage":{"input_tokens":40,"output_tokens":1,"cache_creation_input_tokens":99,"cache_read_input_tokens":12}}}""";
    private const string TextStart =
        """{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hé"}}""";
    private const string Close = """{"type":"content_block_stop","index":0}""";
    private const string Stop =
        """{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7,"output_tokens_details":{"thinking_tokens":3}}}""";
    private const string End = """{"type":"message_stop"}""";

    [Fact]
    public void Default_stream_cache_and_explicit_overrides_are_prepared_before_attempt_start()
    {
        var body = AnthropicRequestSerializer.BuildRequest([], Options());
        Assert.True(body["stream"]!.GetValue<bool>());
        Assert.Equal("ephemeral", body["cache_control"]!["type"]!.ToString());
        var overridden = AnthropicRequestSerializer.BuildRequest(
            [],
            Options() with
            {
                ExtraFields = Obj("""{"stream":false,"cache_control":null,"max_tokens":91}"""),
            }
        );
        Assert.False(overridden["stream"]!.GetValue<bool>());
        Assert.Null(overridden["cache_control"]);
        Assert.Equal(91, overridden["max_tokens"]!.GetValue<int>());
        foreach (var raw in new[] { "null", "1", "\"false\"", "{}" })
            Assert.Throws<ModelPreparationException>(() =>
                AnthropicRequestSerializer.BuildRequest(
                    [],
                    Options() with
                    {
                        ExtraFields = Obj("{\"stream\":" + raw + "}"),
                    }
                )
            );
    }

    [Fact]
    public async Task Indexed_stream_orders_blocks_preserves_opaque_evidence_and_replaces_cumulative_usage_before_socket_EOF()
    {
        var stream = new PushStream();
        var updates = new List<ResponsesStreamProgress>();
        using var client = Client(stream);
        var service = new AnthropicMessagesService(
            client,
            Options(),
            progress: (_, value) => updates.Add(value)
        );
        var pending = service.ChatAsync("session", [], CancellationToken.None);
        var events = new[]
        {
            Start,
            """{"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"b","name":"read","input":{}}}""",
            """{"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\"filePath\":"}}""",
            """{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-signature"}}""",
            Close,
            """{"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque-redacted"}}""",
            """{"type":"content_block_stop","index":1}""",
            """{"type":"content_block_start","index":2,"content_block":{"type":"text","text":"hé"}}""",
            """{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"llo"}}""",
            """{"type":"content_block_stop","index":2}""",
            """{"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"\"file\"}"}}""",
            """{"type":"content_block_stop","index":3}""",
            Stop,
            """{"type":"message_delta","delta":{},"usage":{"output_tokens":9,"output_tokens_details":{"thinking_tokens":4}}}""",
            End,
        };
        var bytes = Encoding.UTF8.GetBytes(
            string.Concat(events.Select(Event)) + "data: not part of the message\n\n"
        );
        // Split a non-ASCII scalar across actual ReadAsync chunks.
        for (var offset = 0; offset < bytes.Length; offset += 7)
            stream.Push(bytes[offset..Math.Min(offset + 7, bytes.Length)]);
        var result = await pending.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.True(stream.Disposed);
        var parts = result.AssistantMessage!["parts"]!.AsArray();
        Assert.Equal("reason", parts[0]!["thinking"]!.ToString());
        Assert.Equal("opaque-signature", parts[0]!["providerMeta"]!["signature"]!.ToString());
        Assert.Equal("opaque-redacted", parts[1]!["providerMeta"]!["redactedThinking"]!.ToString());
        Assert.Equal("héllo", parts[2]!["text"]!.ToString());
        Assert.Equal("file", parts[3]!["functionCall"]!["args"]!["filePath"]!.ToString());
        Assert.Equal(139, result.Usage!["inputTokens"]!.GetValue<double>());
        Assert.Equal(12, result.Usage["cachedTokens"]!.GetValue<double>());
        Assert.Equal(9, result.Usage["outputTokens"]!.GetValue<double>());
        Assert.Equal(4, result.Usage["reasoningTokens"]!.GetValue<double>());
        Assert.Contains(updates, update => update.Reasoning == "reason");
        Assert.Contains(updates, update => update.Text == "héllo");
        Assert.Contains(
            updates,
            update =>
                update.ToolCalls.Any(call =>
                    call.Index == 3 && call.Arguments == "{\"filePath\":\"file\"}"
                )
        );
        Assert.DoesNotContain("opaque-", System.Text.Json.JsonSerializer.Serialize(updates));
    }

    [Fact]
    public async Task Final_event_without_blank_line_is_flushed_at_EOF_and_partial_boundaries_fail()
    {
        var complete =
            Event(Start) + Event(TextStart) + Event(Close) + Event(Stop) + "data: " + End;
        using (var client = Client(new MemoryStream(Encoding.UTF8.GetBytes(complete))))
            Assert.Equal(
                "hé",
                (
                    await new AnthropicMessagesService(client, Options()).ChatAsync(
                        "s",
                        [],
                        CancellationToken.None
                    )
                ).AssistantMessage!["parts"]![0]!["text"]!.ToString()
            );
        foreach (
            var partial in new[]
            {
                Event(Start) + Event(TextStart) + Event(Close) + Event(Stop),
                Event(Start) + Event(TextStart) + Event(Stop) + Event(End),
                Event(Start) + Event(TextStart) + Event(Close) + Event(End),
                Event(Stop) + Event(End),
                Event(Start) + "data: {broken}\n\n",
                Event(Start)
                    + Event(
                        """{"type":"error","error":{"type":"overloaded_error","message":"busy"}}"""
                    ),
            }
        )
        {
            using var client = Client(new MemoryStream(Encoding.UTF8.GetBytes(partial)));
            await Assert.ThrowsAnyAsync<Exception>(() =>
                new AnthropicMessagesService(client, Options()).ChatAsync(
                    "s",
                    [],
                    CancellationToken.None
                )
            );
        }
    }

    [Theory]
    [InlineData("refusal", "text")]
    [InlineData("pause_turn", "text")]
    [InlineData("end_turn", "server_tool_use")]
    [InlineData("end_turn", "mcp_tool_use")]
    [InlineData("end_turn", "web_search_tool_result")]
    public async Task JSON_and_SSE_terminal_failures_are_nonretryable_and_noncountable(
        string reason,
        string type
    )
    {
        var block = new JsonObject
        {
            ["type"] = type,
            ["text"] = "must not publish",
            ["id"] = "call",
            ["name"] = "write",
            ["input"] = new JsonObject(),
        };
        foreach (var streaming in new[] { false, true })
        {
            var raw = streaming
                ? Event(Start)
                    + Event(
                        new JsonObject
                        {
                            ["type"] = "content_block_start",
                            ["index"] = 0,
                            ["content_block"] = block.DeepClone(),
                        }.ToJsonString()
                    )
                    + Event(Close)
                    + Event(
                        new JsonObject
                        {
                            ["type"] = "message_delta",
                            ["delta"] = new JsonObject { ["stop_reason"] = reason },
                        }.ToJsonString()
                    )
                    + Event(End)
                : new JsonObject
                {
                    ["content"] = new JsonArray(block.DeepClone()),
                    ["stop_reason"] = reason,
                }.ToJsonString();
            using var client = Client(new MemoryStream(Encoding.UTF8.GetBytes(raw)));
            var failure = await Assert.ThrowsAsync<ModelAttemptFailure>(() =>
                new AnthropicMessagesService(
                    client,
                    Options() with
                    {
                        ExtraFields = new JsonObject { ["stream"] = streaming },
                    }
                ).ChatAsync("s", [], CancellationToken.None)
            );
            Assert.False(failure.Retryable);
            Assert.False(failure.Countable);
        }
    }

    [Theory]
    [InlineData("max_tokens")]
    [InlineData("model_context_window_exceeded")]
    public async Task Truncation_keeps_text_and_complete_ordered_tools_but_marks_incomplete_or_nonobject_arguments(
        string reason
    )
    {
        var events = new List<string> { Start, TextStart, Close };
        foreach (
            var (index, raw) in new[]
            {
                (1, "{\"filePath\":\"ok\"}"),
                (2, "{\"filePath\":"),
                (3, "[1]"),
                (4, "true"),
            }
        )
        {
            events.Add(
                new JsonObject
                {
                    ["type"] = "content_block_start",
                    ["index"] = index,
                    ["content_block"] = new JsonObject
                    {
                        ["type"] = "tool_use",
                        ["id"] = "call" + index,
                        ["name"] = "write",
                        ["input"] = new JsonObject(),
                    },
                }.ToJsonString()
            );
            events.Add(
                new JsonObject
                {
                    ["type"] = "content_block_delta",
                    ["index"] = index,
                    ["delta"] = new JsonObject
                    {
                        ["type"] = "input_json_delta",
                        ["partial_json"] = raw,
                    },
                }.ToJsonString()
            );
            events.Add(
                new JsonObject { ["type"] = "content_block_stop", ["index"] = index }.ToJsonString()
            );
        }
        events.Add(
            new JsonObject
            {
                ["type"] = "message_delta",
                ["delta"] = new JsonObject { ["stop_reason"] = reason },
            }.ToJsonString()
        );
        events.Add(End);
        using var client = Client(
            new MemoryStream(Encoding.UTF8.GetBytes(string.Concat(events.Select(Event))))
        );
        var result = await new AnthropicMessagesService(client, Options()).ChatAsync(
            "s",
            [],
            CancellationToken.None
        );
        Assert.Equal(reason, result.TruncatedStopReason);
        var calls = result.AssistantMessage!["parts"]!
            .AsArray()
            .OfType<JsonObject>()
            .Select(part => part["functionCall"])
            .OfType<JsonObject>()
            .ToArray();
        Assert.Equal(
            new[] { "call1", "call2", "call3", "call4" },
            calls.Select(call => call["id"]!.ToString())
        );
        Assert.Null(calls[0]["argsParseError"]);
        Assert.All(
            calls.Skip(1),
            call =>
            {
                Assert.Contains(reason, call["argsParseError"]!.ToString());
                Assert.Empty(call["args"]!.AsObject());
            }
        );
        var replay = AnthropicRequestSerializer.ConvertHistory(
            [result.AssistantMessage],
            new Uri("http://localhost")
        );
        Assert.Contains("Invalid tool arguments JSON", replay.ToJsonString());
        // Native JSON non-object input has the same argument-error boundary.
        foreach (var value in new[] { "[]", "true", "17" })
            Assert.NotNull(
                AnthropicCanonicalConverter.ConvertAssistant(
                    Obj(
                        "{\"content\":[{\"type\":\"tool_use\",\"id\":\"bad\",\"name\":\"write\",\"input\":"
                            + value
                            + "}]}"
                    ),
                    "a/wire",
                    0,
                    0
                )!["parts"]![0]!["functionCall"]!["argsParseError"]
            );
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Normal_turn_commits_limit_notice_and_pairs_errors_without_invoking_invalid_tools(
        bool streaming
    )
    {
        var calls = 0;
        var store = new InMemorySessionAuthorityStore();
        var tools = new RecordingToolExecutor(new JsonObject { ["output"] = "effect" });
        using var client = new HttpClient(
            new Handler(
                async (request, token) =>
                {
                    var body = Obj(await request.Content!.ReadAsStringAsync(token));
                    var content = new JsonArray();
                    if (++calls == 1)
                    {
                        content.Add(Obj("""{"type":"text","text":"usable partial"}"""));
                        content.Add(
                            Obj("""{"type":"tool_use","id":"valid","name":"write","input":{}}""")
                        );
                        content.Add(
                            Obj(
                                """{"type":"tool_use","id":"array","name":"write","input":[{"filePath":"never","content":"bad"}]}"""
                            )
                        );
                        content.Add(
                            Obj(
                                """{"type":"tool_use","id":"partial","name":"write","input":"{broken"}"""
                            )
                        );
                    }
                    else
                    {
                        Assert.Equal(1, tools.Invocations);
                        Assert.DoesNotContain(
                            "The response stopped at the output limit.",
                            body.ToJsonString()
                        );
                        var results = body["messages"]!
                            .AsArray()
                            .OfType<JsonObject>()
                            .SelectMany(row =>
                                row["content"] is JsonArray blocks
                                    ? blocks.OfType<JsonObject>()
                                    : []
                            )
                            .Where(block => SessionWait.Text(block["type"]) == "tool_result")
                            .ToArray();
                        Assert.Equal(
                            new[] { "valid", "array", "partial" },
                            results.Select(block => SessionWait.Text(block["tool_use_id"]))
                        );
                        Assert.All(
                            results.Skip(1),
                            block => Assert.Contains("invalid_tool_arguments", block.ToJsonString())
                        );
                        content.Add(Obj("""{"type":"text","text":"final"}"""));
                    }
                    var reason = calls == 1 ? "max_tokens" : "end_turn";
                    string raw;
                    if (streaming)
                    {
                        var events = new List<string> { Start };
                        for (var index = 0; index < content.Count; index++)
                        {
                            var block = (JsonObject)content[index]!.DeepClone();
                            var input = block["input"];
                            var tool = SessionWait.Text(block["type"]) == "tool_use";
                            var partial = SessionWait.Text(input) ?? input?.ToJsonString();
                            if (tool)
                                block["input"] = new JsonObject();
                            events.Add(
                                new JsonObject
                                {
                                    ["type"] = "content_block_start",
                                    ["index"] = index,
                                    ["content_block"] = block,
                                }.ToJsonString()
                            );
                            if (tool)
                                events.Add(
                                    new JsonObject
                                    {
                                        ["type"] = "content_block_delta",
                                        ["index"] = index,
                                        ["delta"] = new JsonObject
                                        {
                                            ["type"] = "input_json_delta",
                                            ["partial_json"] = partial,
                                        },
                                    }.ToJsonString()
                                );
                            events.Add(
                                new JsonObject
                                {
                                    ["type"] = "content_block_stop",
                                    ["index"] = index,
                                }.ToJsonString()
                            );
                        }
                        events.Add(
                            new JsonObject
                            {
                                ["type"] = "message_delta",
                                ["delta"] = new JsonObject { ["stop_reason"] = reason },
                            }.ToJsonString()
                        );
                        events.Add(End);
                        raw = string.Concat(events.Select(Event));
                    }
                    else
                        raw = new JsonObject
                        {
                            ["content"] = content,
                            ["stop_reason"] = reason,
                        }.ToJsonString();
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(raw),
                    };
                }
            )
        );
        var chat = new AnthropicMessagesService(
            client,
            Options() with
            {
                ExtraFields = new JsonObject { ["stream"] = streaming },
            }
        );
        var registry = new SessionRegistry(store, chat, tools);
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.UserText("tools"));
        await registry.Runner.ProcessQueueAsync("s");
        var history = (await store.LoadAsync("s"))!.History;
        Assert.Equal(2, calls);
        Assert.Equal(1, tools.Invocations);
        Assert.Equal(
            new[] { "user", "model", "model", "tool", "model" },
            history.Select(row => SessionWait.Text(row["role"]))
        );
        Assert.False(history[2]["modelVisible"]!.GetValue<bool>());
        Assert.Equal("llm-stop", history[2]["__meta"]!["noticeType"]!.ToString());
        Assert.Equal("max_tokens", history[2]["__meta"]!["stopReason"]!.ToString());
        Assert.Equal("usable partial", history[1]["parts"]![0]!["text"]!.ToString());
        Assert.Equal("final", history[4]["parts"]![0]!["text"]!.ToString());
    }

    [Fact]
    public async Task Caller_Stop_and_progress_callback_error_dispose_without_publishing_partial_result()
    {
        foreach (var callbackFailure in new[] { false, true })
        {
            var stream = new PushStream();
            using var client = Client(stream);
            using var stop = new CancellationTokenSource();
            var observed = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            var marker = new InvalidOperationException("synthetic callback failure");
            var pending = new AnthropicMessagesService(
                client,
                Options(),
                progress: (_, _) =>
                {
                    observed.TrySetResult();
                    if (callbackFailure)
                        throw marker;
                }
            ).ChatAsync("s", [], stop.Token);
            stream.Push(Event(Start) + Event(TextStart));
            await observed.Task.WaitAsync(TimeSpan.FromSeconds(3));
            if (callbackFailure)
                Assert.Same(
                    marker,
                    await Assert.ThrowsAsync<InvalidOperationException>(() => pending)
                );
            else
            {
                stop.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            }
            Assert.True(stream.Disposed);
        }
    }

    [Fact]
    public async Task Watchdog_first_output_reasoning_open_close_and_pings_follow_semantic_activity()
    {
        var clock = new ManualWsClock();
        var stream = new PushStream();
        using var client = Client(stream);
        var updates = Channel.CreateUnbounded<ResponsesStreamProgress>();
        var pending = new AnthropicMessagesService(
            client,
            Options() with
            {
                StreamInactivityTimeoutMs = 2000,
            },
            progress: (_, update) => updates.Writer.TryWrite(update),
            clock: clock
        ).ChatAsync("s", [], CancellationToken.None);
        clock.Advance(TimeSpan.FromSeconds(179));
        stream.Push(Event("""{"type":"ping"}""") + Event(Start));
        await stream.WaitForReads(2);
        clock.Advance(TimeSpan.FromSeconds(1));
        await Assert.ThrowsAsync<TimeoutException>(() => pending);
        Assert.True(stream.Disposed);

        clock = new ManualWsClock();
        stream = new PushStream();
        using var reasoningClient = Client(stream);
        pending = new AnthropicMessagesService(
            reasoningClient,
            Options() with
            {
                StreamInactivityTimeoutMs = 2000,
            },
            progress: (_, update) => updates.Writer.TryWrite(update),
            clock: clock
        ).ChatAsync("s", [], CancellationToken.None);
        stream.Push(
            Event(Start)
                + Event(
                    """{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"""
                )
        );
        await updates.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(3));
        clock.Advance(TimeSpan.FromSeconds(599));
        Assert.False(pending.IsCompleted);
        stream.Push(
            Event("""{"type":"ping"}""")
                + Event(
                    """{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"hidden"}}"""
                )
        );
        await stream.WaitForReads(3);
        clock.Advance(TimeSpan.FromSeconds(1));
        await Assert.ThrowsAsync<TimeoutException>(() => pending);

        clock = new ManualWsClock();
        stream = new PushStream();
        using var closingClient = Client(stream);
        pending = new AnthropicMessagesService(
            closingClient,
            Options() with
            {
                StreamInactivityTimeoutMs = 2000,
            },
            progress: (_, update) => updates.Writer.TryWrite(update),
            clock: clock
        ).ChatAsync("s", [], CancellationToken.None);
        stream.Push(
            Event(Start)
                + Event(
                    """{"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque"}}"""
                )
        );
        await updates.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(3));
        clock.Advance(TimeSpan.FromSeconds(400));
        stream.Push(Event(Close));
        await stream.WaitForReads(3);
        Assert.Equal(clock.GetUtcNow().AddSeconds(2), clock.LastTimer!.Due);
        clock.Advance(TimeSpan.FromSeconds(2));
        await Assert.ThrowsAsync<TimeoutException>(() => pending);
        Assert.True(stream.Disposed);
    }

    private static HttpClient Client(Stream stream) =>
        new(
            new Handler(
                (_, _) =>
                    Task.FromResult(
                        new HttpResponseMessage(HttpStatusCode.OK)
                        {
                            Content = new StreamContent(stream),
                        }
                    )
            )
        )
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };

    private sealed class Handler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send
    ) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken token
        ) => send(request, token);
    }

    private sealed class PushStream : Stream
    {
        private readonly Channel<byte[]> chunks = Channel.CreateUnbounded<byte[]>();
        private int reads;
        internal bool Disposed { get; private set; }

        internal void Push(string text) => Push(Encoding.UTF8.GetBytes(text));

        internal void Push(byte[] bytes) => chunks.Writer.TryWrite(bytes);

        internal async Task WaitForReads(int count)
        {
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            while (Volatile.Read(ref reads) < count)
                await Task.Delay(1, limit.Token);
        }

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken token = default
        )
        {
            Interlocked.Increment(ref reads);
            var bytes = await chunks.Reader.ReadAsync(token);
            bytes.CopyTo(buffer);
            return bytes.Length;
        }

        protected override void Dispose(bool disposing)
        {
            Disposed = true;
            chunks.Writer.TryComplete();
            base.Dispose(disposing);
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush() => throw new NotSupportedException();

        public override int Read(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) =>
            throw new NotSupportedException();

        public override void SetLength(long length) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();
    }
}
