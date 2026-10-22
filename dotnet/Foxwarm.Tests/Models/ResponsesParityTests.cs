using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class ResponsesParityTests
{
    [Theory]
    [InlineData("openai", false)]
    [InlineData("openai", true)]
    [InlineData("openai-responses", false)]
    [InlineData("openai-responses", true)]
    public async Task Http_owner_sends_lineage_cache_key_with_normal_extra_field_precedence(
        string providerType,
        bool overrideKey
    )
    {
        var provider = Obj("""{"models":["m"],"baseUrl":"http://127.0.0.1:1/v1"}""");
        provider["providerType"] = providerType;
        if (overrideKey)
            provider["extraFields"] = Obj("""{"prompt_cache_key":"override-${SESSION_CACHE_KEY}"}""");
        var catalog = HostModels.Parse(
            new JsonObject { ["default"] = "p", ["providers"] = new JsonObject { ["p"] = provider } },
            new JsonObject()
        );
        using var handler = new Handler(SummaryStream());
        using var http = new HttpClient(handler);
        var owner = new ModelRequestOwner(
            http,
            new ResponsesClientOptions(new Uri("http://127.0.0.1:1/v1"), "m", "p/m", "", "", 100),
            new ModelRouting()
        );
        var result = await owner.RequestAsync(
            "fixture/session",
            catalog,
            "p",
            null,
            "lineage-key",
            "turn-key",
            [],
            (_, _) => Task.FromResult("prompt"),
            null,
            null,
            null,
            null,
            CancellationToken.None
        );
        var request = Assert.Single(handler.Requests);
        Assert.Equal(
            overrideKey ? "override-lineage-key" : "lineage-key",
            request["prompt_cache_key"]!.GetValue<string>()
        );
        var parts = result.AssistantMessage!["parts"]!.AsArray();
        Assert.Equal("thought", parts[0]!["thinking"]!.GetValue<string>());
        Assert.Equal("synthetic-cipher", parts[0]!["providerMeta"]!["encryptedThinking"]!.GetValue<string>());
        Assert.Equal("answer", parts[1]!["text"]!.GetValue<string>());
        var replay = ResponsesRequestSerializer.BuildRequest(
            [result.AssistantMessage], "m", "p/m", "prompt", 100
        );
        Assert.Equal("synthetic-cipher", replay["input"]![0]!["encrypted_content"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("response.reasoning_summary_part.added")]
    [InlineData("response.reasoning_summary_part.done")]
    [InlineData("response.reasoning_summary_text.delta")]
    [InlineData("response.reasoning_summary_text.done")]
    public async Task Indexed_summary_events_synthesize_reasoning_and_align_final_output(string eventType)
    {
        var summary = new JsonObject
        {
            ["type"] = eventType,
            ["output_index"] = 0,
            ["summary_index"] = 1,
        };
        if (eventType.Contains("_part.", StringComparison.Ordinal))
            summary["part"] = Obj("""{"type":"summary_text","text":"second"}""");
        else
            summary[eventType.EndsWith("delta", StringComparison.Ordinal) ? "delta" : "text"] = "second";
        var progress = new List<ResponsesStreamProgress>();
        var stream = Sse(
            summary,
            Obj("""{"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"first"}"""),
            Obj("""{"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"answer"}"""),
            Obj("""{"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"condensed"}],"encrypted_content":"synthetic-cipher"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}]}}""")
        );
        using var bytes = new MemoryStream(Encoding.UTF8.GetBytes(stream));
        var result = await ResponsesSseCollector.CollectAsync(
            bytes,
            CancellationToken.None,
            new ResponsesStreamCallbacks { OnProgress = progress.Add }
        );
        var output = result["output"]!.AsArray();
        Assert.Equal(2, output.Count);
        Assert.Equal("reasoning", output[0]!["type"]!.GetValue<string>());
        Assert.Equal("synthetic-cipher", output[0]!["encrypted_content"]!.GetValue<string>());
        Assert.Equal(new[] { "first", "second" }, output[0]!["summary"]!.AsArray().Select(part => part!["text"]!.GetValue<string>()));
        Assert.Equal("answer", output[1]!["content"]![0]!["text"]!.GetValue<string>());
        Assert.Collection(
            progress[^1].Parts!,
            part => Assert.Equal((0, "reasoning", 0, "first"), (part.OutputIndex, part.Kind, part.SummaryIndex, part.Text)),
            part => Assert.Equal((0, "reasoning", 1, "second"), (part.OutputIndex, part.Kind, part.SummaryIndex, part.Text)),
            part => Assert.Equal((1, "text", "answer"), (part.OutputIndex, part.Kind, part.Text))
        );
    }

    [Fact]
    public async Task Summary_part_added_seeds_following_deltas_with_condensed_completion()
    {
        var stream = Sse(
            Obj("""{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","summary":[]}}"""),
            Obj("""{"type":"response.reasoning_summary_part.added","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":"seed"}}"""),
            Obj("""{"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":" tail"}"""),
            Obj("""{"type":"response.completed","response":{"output":[]}}""")
        );
        using var bytes = new MemoryStream(Encoding.UTF8.GetBytes(stream));
        var result = await ResponsesSseCollector.CollectAsync(bytes, CancellationToken.None);
        Assert.Equal("seed tail", result["output"]![0]!["summary"]![0]!["text"]!.GetValue<string>());
    }

    [Fact]
    public async Task Empty_part_done_clears_text_while_empty_text_done_retains_it()
    {
        var progress = new List<ResponsesStreamProgress>();
        using var bytes = new MemoryStream(Encoding.UTF8.GetBytes(Sse(
            Obj("""{"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"kept"}"""),
            Obj("""{"type":"response.reasoning_summary_text.done","output_index":0,"summary_index":0,"text":""}"""),
            Obj("""{"type":"response.reasoning_summary_part.done","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":""}}"""),
            Obj("""{"type":"response.completed","response":{"output":[]}}""")
        )));
        var result = await ResponsesSseCollector.CollectAsync(
            bytes, CancellationToken.None, new ResponsesStreamCallbacks { OnProgress = progress.Add }
        );
        Assert.Equal(new[] { "kept", "", "" }, progress.Select(snapshot => snapshot.Reasoning));
        Assert.Empty(result["output"]![0]!["summary"]!.AsArray());
    }

    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();

    private static string Sse(params JsonObject[] events) =>
        string.Concat(events.Select(item => "data: " + item.ToJsonString() + "\n\n"));

    private static string SummaryStream() => Sse(
        Obj("""{"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"thought"}"""),
        Obj("""{"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"answer"}"""),
        Obj("""{"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"thought"}],"encrypted_content":"synthetic-cipher"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}]}}""")
    );

    private sealed class Handler(string response) : HttpMessageHandler
    {
        public List<JsonObject> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            Requests.Add(Obj(await request.Content!.ReadAsStringAsync(cancellationToken)));
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(response, Encoding.UTF8, "text/event-stream"),
            };
        }
    }
}
