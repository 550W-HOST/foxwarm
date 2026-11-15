using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AnthropicHostedSearchTests
{
    private static JsonObject SearchRow(long seq, params JsonObject[] blocks)
    {
        var row = AnthropicCanonicalConverter.ConvertAssistant(
            Reply("end_turn", blocks),
            "a/wire",
            seq,
            1
        )!;
        row["__meta"]!["seq"] = seq;
        return row;
    }

    [Fact]
    public void A_missing_result_closes_the_old_exchange_without_swallowing_later_local_rounds()
    {
        var history = new List<JsonObject> { SearchRow(1, Search("missing"), LocalTask()) };
        for (var round = 0; round < 40; round++)
        {
            var response = Obj(
                """{"role":"tool","parts":[{"functionResponse":{"tool_use_id":"local","name":"task","response":{"output":""}}}],"__meta":{}}"""
            );
            response["parts"]![0]!["functionResponse"]!["response"]!["output"] = new string(
                'x',
                3000
            );
            response["__meta"]!["seq"] = history.Count + 1;
            history.Add(response);
            history.Add(SearchRow(history.Count + 1, Text("Continuing local work."), LocalTask()));
        }
        var budget = 3 * CompactCandidateBuilder.RowTokens(history[1]);
        Assert.True(CompactCandidateBuilder.Split(history, budget) > history.Count - 7);
        Assert.Equal(
            history.Count - 1,
            CompactCandidateBuilder.WholeExchangeStart(history, history.Count - 1)
        );
        Assert.True(CompactCandidateBuilder.Build(history, inContext: true).Items.Count > 35);
        var repaired = ConcreteRequestHistory.PrepareRequest(history, "a/wire");
        var wire = AnthropicRequestSerializer.ConvertHistory(
            repaired,
            new Uri("https://example.invalid"),
            "a/wire"
        );
        Assert.DoesNotContain("server_tool_use", wire.ToJsonString());
        Assert.Contains("server_tool_use", history[0].ToJsonString());
    }

    [Fact]
    public void A_continuation_answers_old_search_and_keeps_its_new_pending_search_atomic()
    {
        var first = SearchRow(1, Search("first"));
        var next = SearchRow(2, Sources("first"), Search("next"));
        var completed = SearchRow(3, Sources("next"), Text("Search finished."));
        JsonObject[] history = [first, next, completed, SearchRow(4, Text("Later response."))];
        Assert.Equal(2, CompactCandidateBuilder.Build(history, inContext: true).Items.Count);
        Assert.Equal(0, CompactCandidateBuilder.WholeExchangeStart(history, 2));
        Assert.Equal(3, CompactCandidateBuilder.WholeExchangeStart(history, 3));
        var repaired = RequestHistoryRepair.SelectAndRepair(history);
        Assert.Equal(
            new JsonArray(history.Select(row => row.DeepClone()).ToArray()).ToJsonString(),
            new JsonArray(repaired.Select(row => row.DeepClone()).ToArray()).ToJsonString()
        );
    }

    [Fact]
    public async Task Abandoned_search_only_row_is_absent_from_the_next_HTTP_request()
    {
        JsonObject[] history =
        [
            Obj("""{"role":"user","parts":[{"text":"find it"}]}"""),
            SearchRow(1, Search("abandoned")),
            Obj("""{"role":"user","parts":[{"text":"never mind"}]}"""),
        ];
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            async (_, stream, request) =>
            {
                var messages = Obj(request.Body)["messages"]!.AsArray();
                Assert.DoesNotContain(messages, row => row?["role"]?.ToString() == "assistant");
                Assert.Contains("never mind", request.Body);
                await Respond(stream, Reply("end_turn", Text("Acknowledged.")), false);
            }
        );
        using var http = new HttpClient();
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 1000)
        {
            ExtraFields = Obj("""{"stream":false}"""),
        };
        var service = new ConcreteRequestHistory.ChatService(
            new AnthropicMessagesService(http, options),
            "a/wire"
        );
        await service.ChatAsync("s", history, default);
        Assert.Single(history[1]["parts"]!.AsArray());
    }

    [Fact]
    public async Task Stream_context_keeps_measured_input_and_estimates_only_new_content_with_iteration_precedence()
    {
        var calls = new List<JsonObject>();
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, request) =>
            {
                calls.Add(Obj(request.Body));
                var reply = Reply(
                    "end_turn",
                    Search($"search-{index}"),
                    Sources($"search-{index}"),
                    Cited()
                );
                if (index < 2)
                    reply["usage"]!.AsObject().Remove("iterations");
                var initial = Obj(
                    """{"input_tokens":90000,"cache_read_input_tokens":30000,"cache_creation_input_tokens":2000,"output_tokens":0}"""
                );
                if (index == 1)
                    initial["input_tokens"] = 150000;
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(Sse(reply, initial))
                );
            }
        );
        using var http = new HttpClient();
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 1000)
        {
            WebSearch = Obj("""{"enabled":true}"""),
        };
        var service = new AnthropicMessagesService(http, options);
        await using var fixture = new AdmissionFixture(peer.BaseUri);
        var history = new List<JsonObject>();
        for (var index = 0; index < 3; index++)
        {
            history.Add(Obj("""{"role":"user","parts":[{"text":"search again"}]}"""));
            var result = await service.ChatAsync("s", history, default);
            var usage = result.Usage!;
            Assert.Equal(300010, usage["inputTokens"]!.GetValue<double>());
            Assert.Equal(20, usage["cachedTokens"]!.GetValue<double>());
            Assert.Equal(40, usage["outputTokens"]!.GetValue<double>());
            if (index < 2)
            {
                var appendedEstimate = HostedSearchSources
                    .Project([result.AssistantMessage!])
                    .Sum(row => Foxwarm.Images.ImageTokenEstimate.Message(row).Tokens);
                Assert.Equal(
                    (index == 0 ? 122000d : 182000d) + appendedEstimate,
                    usage["contextTokens"]!.GetValue<double>()
                );
                Assert.Equal(
                    "reported-input-plus-estimate",
                    usage["contextTokensSource"]!.ToString()
                );
            }
            else
            {
                Assert.Equal(10070d, usage["contextTokens"]!.GetValue<double>());
                Assert.Equal("reported-iteration", usage["contextTokensSource"]!.ToString());
            }
            // The real compaction threshold consumer must not treat the cumulative
            // 300k bill as this request's over-limit context and reject continuation.
            var consumed = false;
            await fixture.Owner.Compactor.BeforeContinuationAsync(
                result,
                async safe =>
                {
                    consumed = true;
                    await safe();
                },
                default
            );
            Assert.True(consumed);
            history.Add(result.AssistantMessage!);
        }
        Assert.Contains("opaque-result", calls[1]["messages"]!.ToJsonString());
        Assert.True(JsonNode.DeepEquals(calls[0]["messages"]![0], calls[1]["messages"]![0]));
    }
}
