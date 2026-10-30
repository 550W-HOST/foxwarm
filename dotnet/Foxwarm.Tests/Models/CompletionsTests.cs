using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class CompletionsTests
{
    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();

    private static JsonObject Event(string json) =>
        Obj("{\"choices\":[{\"index\":0,\"delta\":" + json + "}]}");

    [Fact]
    public void Serializer_preserves_mixed_order_last_thinking_exact_model_metadata_and_raw_arguments()
    {
        var user = Obj(
            """{"role":"user","parts":[{"system":"current time = old","text":"shadowed"},{"text":"actual"}]}"""
        );
        var model = Obj(
            """{"role":"model","parts":[{"thinking":"first"},{"thinking":"last","system":"notice","text":"answer","functionCall":{"id":"stable","name":"read","args":{},"rawArgsText":"{broken","argsParseError":"malformed"}}],"providerMeta":{"sourceModelId":"a/same","providerSpecificFields":{"opaque":{"list":[null,4]}}}}"""
        );
        var tool = Obj(
            """{"role":"tool","parts":[{"functionResponse":{"tool_use_id":"stable","previousLlmRequest":{"time":"1970-01-01T00:00:00.000Z","durationMs":1234},"response":{"output":"one"}}},{"functionResponse":{"tool_use_id":"other","response":{"output":"single"}}},{"functionResponse":{"tool_use_id":"stable","response":{"output":"two"}}}]}"""
        );
        var history = new[] { user, model, tool };
        var wire = CompletionsRequestSerializer.ConvertHistory(history, "a/same", "reasoning");
        Assert.Equal(
            "<foxwarm-system kind=\"time\" localTime=\"old\" />\nactual",
            wire[0]!["content"]!.GetValue<string>()
        );
        Assert.Equal("last", wire[1]!["reasoning"]!.GetValue<string>());
        Assert.Equal(
            "<foxwarm-system kind=\"system\">\nnotice\n</foxwarm-system>",
            wire[1]!["content"]![0]!["text"]!.GetValue<string>()
        );
        Assert.Equal("answer", wire[1]!["content"]![1]!["text"]!.GetValue<string>());
        var replay = Obj(wire[1]!["tool_calls"]![0]!["function"]!["arguments"]!.GetValue<string>());
        Assert.Equal("{broken", replay["rawArgsText"]!.GetValue<string>());
        Assert.Equal("malformed", replay["error"]!.GetValue<string>());
        Assert.True(
            JsonNode.DeepEquals(
                model["providerMeta"]!["providerSpecificFields"],
                wire[1]!["provider_specific_fields"]
            )
        );
        var outputs = Assert.IsType<JsonArray>(wire[2]!["content"]);
        Assert.Equal(3, outputs.Count);
        Assert.Contains("1970-01-01T00:00:00.000Z", outputs[0]!["text"]!.GetValue<string>());
        Assert.Contains("prevLLMReqTime=\"1.2s\"", outputs[0]!["text"]!.GetValue<string>());
        Assert.Equal("one", outputs[1]!["text"]!.GetValue<string>());
        Assert.Equal("two", outputs[2]!["text"]!.GetValue<string>());
        Assert.Equal("single", wire[3]!["content"]!.GetValue<string>());
        var other = CompletionsRequestSerializer.ConvertHistory(
            history,
            "b/same",
            "reasoning_content"
        );
        Assert.False(other[1]!.AsObject().ContainsKey("provider_specific_fields"));
        Assert.Equal("last", other[1]!["reasoning_content"]!.GetValue<string>());
        wire[1]!["provider_specific_fields"]!["opaque"]!["list"]![1] = 99;
        Assert.Equal(
            4,
            model["providerMeta"]!["providerSpecificFields"]!["opaque"]!["list"]![
                1
            ]!.GetValue<int>()
        );
    }

    [Fact]
    public void Request_overrides_then_first_class_effort_and_nested_function_definitions()
    {
        var options = new ResponsesClientOptions(
            new Uri("http://localhost/v1"),
            "wire",
            "a/wire",
            "synthetic",
            Instructions: "instructions",
            MaxOutputTokens: 73,
            Tools: new JsonArray(
                Obj(
                    """{"name":"fixture","description":"Synthetic description","parameters":{"type":"object"}}"""
                )
            ),
            Effort: "high",
            ExtraFields: Obj(
                """{"max_tokens":99,"reasoning_effort":"none","vendor":{"kept":null}}"""
            )
        );
        var body = CompletionsRequestSerializer.BuildRequest([], options, "reasoning", "cache");
        Assert.Equal("instructions", body["messages"]![0]!["content"]!.GetValue<string>());
        Assert.Equal(99, body["max_tokens"]!.GetValue<int>());
        Assert.Equal("high", body["reasoning_effort"]!.GetValue<string>());
        Assert.True(body["stream_options"]!["include_usage"]!.GetValue<bool>());
        Assert.False(body["tools"]![0]!["function"]!["strict"]!.GetValue<bool>());
        Assert.Equal("fixture", body["tools"]![0]!["function"]!["name"]!.GetValue<string>());
        Assert.True(body["vendor"]!.AsObject().ContainsKey("kept"));
        Assert.Null(body["vendor"]!["kept"]);
    }

    [Fact]
    public void Accumulator_separates_meaningful_activity_reused_indices_and_reasoning_channels()
    {
        var progress = new List<ResponsesStreamProgress>();
        var meaningful = 0;
        var accumulator = new CompletionsEventAccumulator(
            new ResponsesStreamCallbacks
            {
                OnProgress = progress.Add,
                OnMeaningfulProgress = () => meaningful++,
            }
        );
        accumulator.Consume(
            Obj(
                """{"choices":[{"index":1,"delta":{"content":"ignored"}}],"usage":{"prompt_tokens":40,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":12}}}"""
            )
        );
        accumulator.Consume(
            Event(
                """{"role":"assistant","provider_specific_fields":{"old":true},"tool_calls":[{"index":0,"id":"call_","type":"function","function":{"name":"wri","arguments":""}}]}"""
            )
        );
        Assert.Equal(0, meaningful);
        Assert.Single(progress);
        accumulator.Consume(
            Event(
                """{"reasoning_content":"preferred","reasoning":"compatibility","provider_specific_fields":{"nested":[null,7]},"tool_calls":[{"index":0,"id":"write","function":{"arguments":"{\"x\":1}"}}]}"""
            )
        );
        accumulator.Consume(
            Event(
                """{"tool_calls":[{"index":0,"function":{"name":"te"}},{"index":0,"id":"second","type":"function","function":{"name":"read","arguments":"{bad"}},{"index":1,"id":"third","type":"function","function":{"name":"read","arguments":"{}"}}]}"""
            )
        );
        Assert.Equal(5, meaningful);
        Assert.Equal("preferred\ncompatibility", progress[^1].Reasoning);
        Assert.Equal(3, progress[^1].ToolCalls.Select(call => call.Index).Distinct().Count());
        var response = accumulator.CompleteAtEof();
        var message = response["choices"]![0]!["message"]!;
        Assert.Equal(
            new[] { "call_write", "second", "third" },
            message["tool_calls"]!.AsArray().Select(call => call!["id"]!.GetValue<string>())
        );
        var canonical = CompletionsCanonicalConverter.ConvertAssistant(
            response,
            "a/wire",
            12345,
            22
        );
        Assert.Equal("preferred", canonical["parts"]![0]!["thinking"]!.GetValue<string>());
        Assert.Contains(
            canonical["parts"]!.AsArray(),
            part => part?["functionCall"]?["argsParseError"] is not null
        );
        Assert.True(
            canonical["providerMeta"]!["providerSpecificFields"]!.AsObject().ContainsKey("old")
        );
        Assert.Equal(28, canonical["__meta"]!["usage"]!["inputTokens"]!.GetValue<double>());
        Assert.Equal(
            12323,
            canonical["__meta"]!["llmRequestTiming"]!["startedAt"]!.GetValue<double>()
        );
    }

    [Fact]
    public async Task Collector_reads_split_utf8_ignores_done_until_eof_and_discards_unterminated_tail()
    {
        var first = Event("""{"content":"hé🙂"}""").ToJsonString();
        var second = Event("""{"content":" after"}""").ToJsonString();
        await using var stream = new OneByteStream(
            Encoding.UTF8.GetBytes(
                "\uFEFFdata: "
                    + Event("""{"content":"source-ignored"}""").ToJsonString()
                    + "\n\ndata: "
                    + first
                    + "\r\n\r\ndata: [DONE]\n\ndata: "
                    + second
                    + "\n\ndata: {unterminated"
            )
        );
        var response = await CompletionsSseCollector.CollectAsync(stream, CancellationToken.None);
        Assert.Equal(
            "hé🙂 after",
            response["choices"]![0]!["message"]!["content"]!.GetValue<string>()
        );
        Assert.True(stream.Disposed);
    }

    [Theory]
    [InlineData("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3}}\n\n", true)]
    [InlineData("data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\n", true)]
    [InlineData(": keepalive\n\ndata: [DONE]\n\n", false)]
    [InlineData("data: {malformed}\n\n", false)]
    [InlineData("data: {\"error\":{\"message\":\"synthetic error\"}}\n\n", false)]
    public async Task Collector_settles_at_eof_only_after_choices_or_usage_and_rejects_real_errors(
        string wire,
        bool valid
    )
    {
        await using var stream = new MemoryStream(Encoding.UTF8.GetBytes(wire));
        if (valid)
            Assert.NotNull(
                await CompletionsSseCollector.CollectAsync(stream, CancellationToken.None)
            );
        else
            await Assert.ThrowsAnyAsync<Exception>(() =>
                CompletionsSseCollector.CollectAsync(stream, CancellationToken.None)
            );
    }

    [Fact]
    public void Missing_stable_call_ids_fail_before_a_canonical_effect_batch()
    {
        var response = Obj(
            """{"choices":[{"message":{"tool_calls":[{"type":"function","function":{"name":"write","arguments":"{}"}}]}}]}"""
        );
        Assert.Throws<ModelPreparationException>(() =>
            CompletionsCanonicalConverter.ConvertAssistant(response, "a/wire", 1, 0)
        );
    }

    [Fact]
    public void Request_preparation_strips_only_proven_cross_concrete_artifacts_without_mutating_history()
    {
        var original = Obj(
            """{"role":"model","__meta":{"modelId":"a/same","seq":7},"providerMeta":{"opaque":"a-only"},"custom":"retained","parts":[{"thinking":"A thought","text":"text survives","providerMeta":{"thinkingSummaries":[],"encryptedThinking":"encrypted","signature":"sig","openaiResponses":{"annotations":[]},"other":{"retained":true}},"customPart":7},{"thinking":"only thought"},{"functionCall":{"id":"call","name":"read","args":{}},"providerMeta":{"signature":"sig"}}]}"""
        );
        var before = original.ToJsonString();
        var result = Assert.Single(ConcreteRequestHistory.Prepare([original], "b/same"));
        Assert.False(result.ContainsKey("__meta"));
        Assert.False(result.ContainsKey("providerMeta"));
        Assert.Equal("retained", result["custom"]!.GetValue<string>());
        Assert.Equal(2, result["parts"]!.AsArray().Count);
        var first = result["parts"]![0]!.AsObject();
        Assert.False(first.ContainsKey("thinking"));
        Assert.Equal("text survives", first["text"]!.GetValue<string>());
        Assert.Equal(7, first["customPart"]!.GetValue<int>());
        Assert.Single(first["providerMeta"]!.AsObject());
        Assert.True(first["providerMeta"]!["other"]!["retained"]!.GetValue<bool>());
        Assert.False(result["parts"]![1]!.AsObject().ContainsKey("providerMeta"));
        Assert.Equal("call", result["parts"]![1]!["functionCall"]!["id"]!.GetValue<string>());
        Assert.Equal(before, original.ToJsonString());
        var same = Assert.Single(ConcreteRequestHistory.Prepare([original], "a/same"));
        Assert.True(JsonNode.DeepEquals(original["parts"], same["parts"]));
        Assert.True(JsonNode.DeepEquals(original["providerMeta"], same["providerMeta"]));
        Assert.False(same.ContainsKey("__meta"));
        same["parts"]![0]!["text"] = "owned clone";
        Assert.Equal(before, original.ToJsonString());
    }

    [Fact]
    public void Request_preparation_keeps_unknown_provenance_and_filters_visibility_before_removing_metadata()
    {
        var unknown = Obj(
            """{"role":"model","__meta":{"modelId":" a/same "},"parts":[{"thinking":"source-less retained"}]}"""
        );
        var hidden = Obj(
            """{"role":"model","modelVisible":false,"__meta":{"modelId":"a/same"},"parts":[{"text":"hidden"}]}"""
        );
        var empty = Obj(
            """{"role":"model","__meta":{"modelId":"a/same"},"parts":[{"thinking":"drop on mismatch"}]}"""
        );
        var legacy = Obj(
            """{"role":"model","__meta":{"modelId":"a/same"},"parts":[{"thinking":"drop on mismatch"}],"content":"legacy survives"}"""
        );
        var result = ConcreteRequestHistory.Prepare([unknown, hidden, empty, legacy], "b/same");
        Assert.Equal(2, result.Count);
        Assert.Equal(
            "source-less retained",
            result[0]["parts"]![0]!["thinking"]!.GetValue<string>()
        );
        Assert.Equal("legacy survives", result[1]["content"]!.GetValue<string>());
        Assert.Empty(result[1]["parts"]!.AsArray());
        Assert.All(result, row => Assert.False(row.ContainsKey("__meta")));
        Assert.NotNull(hidden["__meta"]);
        unknown.Remove("__meta");
        Assert.Equal(
            "source-less retained",
            ConcreteRequestHistory.Prepare([unknown], "b/same")[0]["parts"]![0]![
                "thinking"
            ]!.GetValue<string>()
        );
    }

    private sealed class OneByteStream(byte[] bytes) : MemoryStream(bytes)
    {
        public bool Disposed { get; private set; }

        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken token = default
        ) => base.ReadAsync(buffer[..Math.Min(1, buffer.Length)], token);

        protected override void Dispose(bool disposing)
        {
            Disposed = true;
            base.Dispose(disposing);
        }
    }
}
