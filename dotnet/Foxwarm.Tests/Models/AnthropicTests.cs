using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class AnthropicTests
{
    private static JsonObject Obj(string value) => JsonNode.Parse(value)!.AsObject();

    private static ResponsesClientOptions Options() =>
        new(
            new Uri("http://localhost"),
            "wire",
            "a/wire",
            "synthetic-token",
            Instructions: "system",
            MaxOutputTokens: 713,
            Effort: "high"
        );

    [Fact]
    public void Projection_preserves_field_order_signature_timing_and_only_wire_role_merge()
    {
        var user = Obj("""{"role":"user","parts":[{"text":"one"}]}""");
        var second = Obj(
            """{"role":"user","parts":[{"system":"current time = old","text":"two","imageMeta":{"opaque":true}}]}"""
        );
        var model = Obj(
            """{"role":"model","parts":[{"thinking":"signed","providerMeta":{"signature":"sig"},"system":"notice","text":"answer","functionCall":{"id":"stable","name":"read","args":{"path":"file"}}},{"thinking":"unsigned"}]}"""
        );
        var tool = Obj(
            """{"role":"tool","parts":[{"functionResponse":{"tool_use_id":"stable","response":{"output":"done"},"previousLlmRequest":{"time":"old","durationMs":1050}}}]}"""
        );
        var rows = new[] { user, second, model, tool };
        var originals = rows.Select(row => row.ToJsonString()).ToArray();
        var wire = AnthropicRequestSerializer.ConvertHistory(
            rows,
            new Uri("https://api.kimi.com/v1")
        );
        Assert.Equal(3, wire.Count);
        Assert.Equal(3, wire[0]!["content"]!.AsArray().Count);
        Assert.Equal("one", wire[0]!["content"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("thinking", wire[1]!["content"]![0]!["type"]!.GetValue<string>());
        Assert.Equal("sig", wire[1]!["content"]![0]!["signature"]!.GetValue<string>());
        Assert.Equal("tool_use", wire[1]!["content"]![3]!["type"]!.GetValue<string>());
        Assert.Equal(4, wire[1]!["content"]!.AsArray().Count);
        Assert.Contains("prevLLMReqTime", wire[2]!["content"]![0]!["content"]!.GetValue<string>());
        Assert.Equal("", wire[2]!["content"]![0]!["reasoning_content"]!.GetValue<string>());
        Assert.Equal(originals, rows.Select(row => row.ToJsonString()).ToArray());
        Assert.Throws<ModelPreparationException>(() =>
            AnthropicRequestSerializer.ConvertHistory(
                [Obj("""{"role":"user","parts":[{"inlineDataRef":{"id":"blob"}}]}""")],
                new Uri("http://localhost")
            )
        );
    }

    [Fact]
    public void Effort_follows_overrides_none_disables_thinking_without_erasing_unrelated_output_config()
    {
        var options = Options() with
        {
            Effort = "none",
            ExtraFields = Obj(
                """{"max_tokens":333,"thinking":{"type":"enabled","budget_tokens":500},"output_config":{"effort":"max","vendor":7}}"""
            ),
            Tools = new JsonArray(
                Obj(
                    """{"name":"fixture","description":"Synthetic","parameters":{"type":"object"}}"""
                )
            ),
        };
        var body = AnthropicRequestSerializer.BuildRequest([], options);
        Assert.Equal(333, body["max_tokens"]!.GetValue<int>());
        Assert.Equal("disabled", body["thinking"]!["type"]!.GetValue<string>());
        Assert.Single(body["thinking"]!.AsObject());
        Assert.False(body["output_config"]!.AsObject().ContainsKey("effort"));
        Assert.Equal(7, body["output_config"]!["vendor"]!.GetValue<int>());
        Assert.NotNull(body["tools"]![0]!["input_schema"]);
        Assert.False(body.ContainsKey("stream"));
        Assert.False(body.ContainsKey("prompt_cache_key"));
        options = options with { Effort = "high" };
        body = AnthropicRequestSerializer.BuildRequest([], options);
        Assert.Equal("high", body["output_config"]!["effort"]!.GetValue<string>());
        Assert.Equal("enabled", body["thinking"]!["type"]!.GetValue<string>());
    }

    [Fact]
    public void Parser_preserves_order_tagged_thinking_native_signature_and_input_without_subtracting_cached()
    {
        var response = Obj(
            """{"content":[{"type":"text","text":"before\n<thinking>\ninternal\n</thinking>\nafter"},{"type":"thinking","thinking":"native","signature":"signature"},{"type":"tool_use","id":"call","name":"read","input":{"path":"file"}},{"type":"future","metadata":{"image":true}}],"usage":{"input_tokens":40,"output_tokens":4,"cache_read_input_tokens":12,"cache_creation_input_tokens":99}}"""
        );
        var message = AnthropicCanonicalConverter.ConvertAssistant(response, "a/wire", 500, 123)!;
        Assert.Equal(5, message["parts"]!.AsArray().Count);
        Assert.Equal("before", message["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("internal", message["parts"]![1]!["thinking"]!.GetValue<string>());
        Assert.Equal("after", message["parts"]![2]!["text"]!.GetValue<string>());
        Assert.Equal(
            "signature",
            message["parts"]![3]!["providerMeta"]!["signature"]!.GetValue<string>()
        );
        Assert.Equal(
            "file",
            message["parts"]![4]!["functionCall"]!["args"]!["path"]!.GetValue<string>()
        );
        Assert.Equal(139, message["__meta"]!["usage"]!["inputTokens"]!.GetValue<double>());
        Assert.Equal(12, message["__meta"]!["usage"]!["cachedTokens"]!.GetValue<int>());
        Assert.Null(
            AnthropicCanonicalConverter.ConvertAssistant(
                Obj("""{"content":[],"usage":{"input_tokens":30,"output_tokens":0}}"""),
                "a/wire",
                0,
                0
            )
        );
        Assert.NotNull(
            AnthropicCanonicalConverter.Usage(
                Obj("""{"content":[],"usage":{"input_tokens":30,"output_tokens":0}}""")
            )
        );
        Assert.Single(
            AnthropicCanonicalConverter.ConvertAssistant(
                Obj("""{"content":[{"type":"text","text":""}]}"""),
                "a/wire",
                0,
                0
            )!["parts"]!.AsArray()
        );
    }

    [Fact]
    public void Usage_accepts_only_finite_reported_numbers_and_does_not_invent_missing_input()
    {
        var usage = AnthropicCanonicalConverter.Usage(Obj(
            """{"usage":{"input_tokens":0,"cache_creation_input_tokens":12.5,"output_tokens":"bad","cache_read_input_tokens":"bad"}}"""
        ))!;
        Assert.Equal(12.5, usage["inputTokens"]!.GetValue<double>());
        Assert.Null(usage["outputTokens"]);
        Assert.Equal(0, usage["cachedTokens"]!.GetValue<int>());
        var missing = AnthropicCanonicalConverter.Usage(Obj(
            """{"usage":{"cache_creation_input_tokens":55,"output_tokens":0}}"""
        ))!;
        Assert.Null(missing["inputTokens"]);
        Assert.Equal(0, missing["outputTokens"]!.GetValue<int>());
    }

    [Fact]
    public async Task Header_arrival_and_each_real_body_read_reset_idle_without_a_total_body_deadline()
    {
        var body = Encoding.UTF8.GetBytes("{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}");
        using var client = new HttpClient(
            new Handler(
                async (request, token) =>
                {
                    Assert.Equal("/v1/messages", request.RequestUri!.AbsolutePath);
                    Assert.Equal(
                        "synthetic-token",
                        request.Headers.GetValues("x-api-key").Single()
                    );
                    Assert.False(request.Headers.Contains("Authorization"));
                    await Task.Delay(250, token);
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StreamContent(new DelayedStream(body, 250, 12)),
                    };
                }
            )
        )
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var result = await new AnthropicMessagesService(client, Options(), 600).ChatAsync(
            "session",
            [],
            CancellationToken.None
        );
        Assert.True(watch.ElapsedMilliseconds > 600);
        Assert.Equal("done", result.AssistantMessage!["parts"]![0]!["text"]!.GetValue<string>());
    }

    [Fact]
    public async Task Header_timeout_and_caller_stop_are_distinct_and_do_not_publish_partial_output()
    {
        using var client = new HttpClient(
            new Handler(
                async (_, token) =>
                {
                    await Task.Delay(5000, token);
                    return new HttpResponseMessage(HttpStatusCode.OK);
                }
            )
        )
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        await Assert.ThrowsAsync<TimeoutException>(() =>
            new AnthropicMessagesService(client, Options(), 60).ChatAsync(
                "session",
                [],
                CancellationToken.None
            )
        );
        using var stop = new CancellationTokenSource(60);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new AnthropicMessagesService(client, Options(), 5000).ChatAsync(
                "session",
                [],
                stop.Token
            )
        );
    }

    [Fact]
    public async Task Fixed_non_json_transform_has_no_default_row_but_empty_guard_rejects()
    {
        using var client = new HttpClient(
            new Handler(
                (_, _) =>
                    Task.FromResult(
                        new HttpResponseMessage(HttpStatusCode.OK)
                        {
                            Content = new StringContent("not-json"),
                        }
                    )
            )
        );
        Assert.Null(
            (
                await new AnthropicMessagesService(client, Options()).ChatAsync(
                    "session",
                    [],
                    CancellationToken.None
                )
            ).AssistantMessage
        );
        await Assert.ThrowsAsync<ModelAttemptFailure>(() =>
            new AnthropicMessagesService(
                client,
                Options() with
                {
                    DisallowEmptyResponse = true,
                }
            ).ChatAsync("session", [], CancellationToken.None)
        );
    }

    [Fact]
    public void Reversed_tool_results_keep_visible_canonical_boundaries_and_order_in_merged_wire_user()
    {
        var model = Obj(
            """{"role":"model","parts":[{"functionCall":{"id":"a","name":"read","args":{}}},{"functionCall":{"id":"b","name":"read","args":{}}}]}"""
        );
        var tool = Obj(
            """{"role":"tool","parts":[{"functionResponse":{"tool_use_id":"b","response":{"output":"B"}}},{"functionResponse":{"tool_use_id":"a","response":{"output":"A"}}}]}"""
        );
        var user = Obj("""{"role":"user","parts":[{"text":"next input"}]}""");
        var before = tool.ToJsonString();
        var wire = AnthropicRequestSerializer.ConvertHistory(
            [model, tool, user],
            new Uri("http://localhost")
        );
        Assert.Equal(2, wire.Count);
        var blocks = wire[1]!["content"]!.AsArray();
        Assert.Equal(
            new[] { "b", "a" },
            blocks.Take(2).Select(block => block!["tool_use_id"]!.GetValue<string>())
        );
        Assert.Equal("next input", blocks[2]!["text"]!.GetValue<string>());
        Assert.Equal("tool", tool["role"]!.GetValue<string>());
        Assert.Equal(before, tool.ToJsonString());
        Assert.Equal("user", user["role"]!.GetValue<string>());
    }

    [Fact]
    public async Task Caller_stop_during_raw_body_read_cancels_the_owned_stream()
    {
        using var client = new HttpClient(
            new Handler(
                (_, _) =>
                    Task.FromResult(
                        new HttpResponseMessage(HttpStatusCode.OK)
                        {
                            Content = new StreamContent(
                                new DelayedStream(Encoding.UTF8.GetBytes("{}"), 5000, 1)
                            ),
                        }
                    )
            )
        )
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        using var stop = new CancellationTokenSource(60);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new AnthropicMessagesService(client, Options(), 5000).ChatAsync(
                "session",
                [],
                stop.Token
            )
        );
    }

    [Fact]
    public async Task Configured_headers_override_auth_defaults_then_actual_compression_wins_and_client_is_unchanged()
    {
        using var client = new HttpClient(
            new Handler(
                async (request, token) =>
                {
                    Assert.Equal("configured-key", request.Headers.GetValues("x-api-key").Single());
                    Assert.Equal(
                        "configured-version",
                        request.Headers.GetValues("anthropic-version").Single()
                    );
                    Assert.Equal("gzip", request.Content!.Headers.ContentEncoding.Single());
                    var bytes = await request.Content.ReadAsByteArrayAsync(token);
                    Assert.Equal(bytes.LongLength, request.Content.Headers.ContentLength);
                    using var compressed = new MemoryStream(bytes);
                    using var decoder = new System.IO.Compression.GZipStream(
                        compressed,
                        System.IO.Compression.CompressionMode.Decompress
                    );
                    using var reader = new StreamReader(decoder);
                    var body = Obj(await reader.ReadToEndAsync(token));
                    Assert.Equal("wire", body["model"]!.GetValue<string>());
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(
                            "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}"
                        ),
                    };
                }
            )
        )
        {
            Timeout = TimeSpan.FromSeconds(73),
        };
        var options = Options() with
        {
            RequestCompression = "gzip",
            ExtraHeaders = Obj(
                """{"x-api-key":"configured-key","anthropic-version":"configured-version","Content-Length":"1","Content-Encoding":"overridden"}"""
            ),
        };
        Assert.NotNull(
            (
                await new AnthropicMessagesService(client, options).ChatAsync(
                    "session",
                    [],
                    CancellationToken.None
                )
            ).AssistantMessage
        );
        Assert.Equal(TimeSpan.FromSeconds(73), client.Timeout);
    }

    [Fact]
    public async Task Valid_content_with_non_200_status_cannot_become_an_assistant_or_tool_effect()
    {
        using var client = new HttpClient(
            new Handler(
                (_, _) =>
                    Task.FromResult(
                        new HttpResponseMessage(HttpStatusCode.Created)
                        {
                            Content = new StringContent(
                                "{\"content\":[{\"type\":\"tool_use\",\"id\":\"call\",\"name\":\"write\",\"input\":{}}]}"
                            ),
                        }
                    )
            )
        );
        await Assert.ThrowsAsync<ModelAttemptFailure>(() =>
            new AnthropicMessagesService(client, Options()).ChatAsync(
                "session",
                [],
                CancellationToken.None
            )
        );
    }

    private sealed class Handler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send
    ) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken token
        ) => send(request, token);
    }

    private sealed class DelayedStream(byte[] bytes, int delay, int size) : MemoryStream(bytes)
    {
        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken token = default
        )
        {
            await Task.Delay(delay, token);
            return await base.ReadAsync(buffer[..Math.Min(size, buffer.Length)], token);
        }
    }
}
