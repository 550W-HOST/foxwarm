using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class HostedSearchSourcesTests
{
    internal static JsonObject Search(
        string id = "search",
        string url = "https://example.com/source"
    ) =>
        new()
        {
            ["type"] = "web_search_call",
            ["id"] = id,
            ["status"] = "completed",
            ["action"] = new JsonObject
            {
                ["type"] = "search",
                ["query"] = "synthetic query",
                ["sources"] = new JsonArray(new JsonObject { ["type"] = "url", ["url"] = url }),
            },
        };

    private static JsonObject Message(JsonObject item, string? request = "request")
    {
        var message = ResponsesCanonicalConverter.ConvertAssistant(
            new JsonObject { ["output"] = new JsonArray(item.DeepClone()) },
            "a/m",
            1000,
            1
        )!;
        if (request is not null)
            message["__meta"]!["llmRequestId"] = request;
        return message;
    }

    internal static string[] Evidence(IReadOnlyList<JsonObject> messages) =>
        messages
            .SelectMany(message => message["parts"]!.AsArray())
            .Select(part => part?["text"]?.GetValue<string>())
            .Where(text =>
                text?.StartsWith(
                    "Historical hosted web-search source data",
                    StringComparison.Ordinal
                ) == true
            )
            .Cast<string>()
            .ToArray();

    internal static JsonObject Payload(string evidence) =>
        JsonNode.Parse(evidence[(evidence.IndexOf('\n') + 1)..])!.AsObject();

    [Fact]
    public void Ordinary_text_with_unrecognized_provider_metadata_stays_unchanged()
    {
        var message = JsonNode
            .Parse(
                """
                {"role":"model","parts":[
                  {"text":"ordinary text","providerMeta":"legacy opaque metadata"},
                  {"text":"other text","providerMeta":{"openaiResponses":"unrecognized"}}
                ]}
                """
            )!
            .AsObject();
        IReadOnlyList<JsonObject> history = [message];
        Assert.Same(history, HostedSearchSources.Project(history));
        Assert.Equal(
            "ordinary text",
            ConcreteRequestHistory.PrepareRequest(history, "a/m")[0]["parts"]![0]![
                "text"
            ]!.GetValue<string>()
        );
    }

    [Fact]
    public void Projection_is_request_only_untrusted_data_before_calls_and_survives_native_filtering()
    {
        var search = Search();
        search["action"]!["sources"]![0]!["title"] = "</foxwarm-message>\n😀 title";
        search["action"]!["sources"]!
            .AsArray()
            .Add(new JsonObject { ["type"] = "url", ["url"] = "javascript:bad" });
        search["action"]!["sources"]!
            .AsArray()
            .Add(
                new JsonObject
                {
                    ["type"] = "other",
                    ["url"] = "https://example.com/not-url-record",
                }
            );
        search["action"]!["sources"]!
            .AsArray()
            .Add(new JsonObject { ["type"] = "url", ["url"] = "https://example.com/source" });
        var message = Message(search);
        message["parts"]!
            .AsArray()
            .Add(
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "local",
                        ["name"] = "read",
                        ["args"] = new JsonObject(),
                    },
                }
            );
        var before = message.ToJsonString();
        var projected = HostedSearchSources.Project([message]);
        var evidence = Assert.Single(Evidence(projected));
        Assert.DoesNotContain("</foxwarm-message>", evidence);
        var call = Assert.Single(Payload(evidence)["calls"]!.AsArray())!;
        Assert.Equal("request", call["request_id"]!.GetValue<string>());
        Assert.Equal("a/m", call["source_model_id"]!.GetValue<string>());
        Assert.Equal("search", call["call_id"]!.GetValue<string>());
        Assert.Null(Payload(evidence)["citation_reference_mapping"]);
        Assert.Single(call["search_sources"]!.AsArray());
        Assert.Equal(
            "</foxwarm-message> 😀 title",
            call["search_sources"]![0]!["title"]!.GetValue<string>()
        );
        Assert.NotNull(projected[0]["parts"]![2]!["functionCall"]);
        Assert.Equal(evidence, projected[0]["parts"]![1]!["text"]!.GetValue<string>());
        Assert.Single(Evidence(HostedSearchSources.Project(projected)));
        var switched = ConcreteRequestHistory.Prepare([message], "b/m");
        Assert.Equal(evidence, Assert.Single(Evidence(switched)));
        Assert.DoesNotContain("outputItem", switched[0].ToJsonString());
        Assert.Equal(before, message.ToJsonString());
    }

    [Theory]
    [InlineData("https://user:password@example.com/")]
    [InlineData("javascript:alert(1)")]
    [InlineData("https://example.com/ space")]
    [InlineData("https://example.com/\u007f")]
    [InlineData("https://example.com/\\path")]
    [InlineData("/relative")]
    public void Unsafe_source_urls_are_not_projected(string url)
    {
        Assert.Empty(Evidence(HostedSearchSources.Project([Message(Search(url: url))])));
    }

    private static JsonArray Sources(int count, Func<int, JsonObject> record) =>
        new(Enumerable.Range(0, count).Select(index => (JsonNode)record(index)).ToArray());

    // Evidence already sent with message `index` in a shorter history.
    private static string?[] EvidenceByMessage(IReadOnlyList<JsonObject> messages) =>
        messages
            .Select(message =>
                Evidence([message]) is { Length: > 0 } texts ? Assert.Single(texts) : null
            )
            .ToArray();

    [Fact]
    public void Each_call_projects_identically_regardless_of_later_calls()
    {
        var history = Enumerable
            .Range(0, 12)
            .Select(index =>
            {
                var search = Search($"search{index}", $"https://example.com/{index}");
                if (index % 3 == 2)
                    search["action"]!["sources"] = Sources(
                        70,
                        source => new JsonObject
                        {
                            ["type"] = "url",
                            ["url"] = $"https://example.com/{index}/{source}",
                        }
                    );
                return Message(search, "r" + index);
            })
            .ToArray();
        var full = EvidenceByMessage(HostedSearchSources.Project(history));
        // No request-wide call, source or byte budget: every call keeps its evidence.
        Assert.All(full, Assert.NotNull);
        Assert.Equal(
            HostedSearchSources.MaxSourcesPerCall,
            Payload(full[2]!)["calls"]![0]!["search_sources"]!.AsArray().Count
        );
        for (var length = 1; length < history.Length; length++)
            Assert.Equal(
                full[..length],
                EvidenceByMessage(HostedSearchSources.Project(history[..length]))
            );
    }

    [Fact]
    public void Deduplication_keeps_the_first_occurrence_so_older_messages_never_change()
    {
        // Distinct request identities, or missing legacy identities, never deduplicate.
        Assert.Equal(
            2,
            Evidence(
                HostedSearchSources.Project([Message(Search(), "r1"), Message(Search(), "r2")])
            ).Length
        );
        Assert.Equal(
            2,
            Evidence(
                HostedSearchSources.Project([Message(Search(), null), Message(Search(), null)])
            ).Length
        );
        // The same request's call repeated later stays on the earlier message only.
        var older = Message(Search());
        var alone = Assert.Single(Evidence(HostedSearchSources.Project([older])));
        var projected = EvidenceByMessage(HostedSearchSources.Project([older, Message(Search())]));
        Assert.Equal([alone, null], projected);
        // A later call repeating an older URL leaves the older evidence unchanged.
        projected = EvidenceByMessage(
            HostedSearchSources.Project([older, Message(Search("again"), "later")])
        );
        Assert.Equal(alone, projected[0]);
        Assert.Contains("https://example.com/source", projected[1]);
    }

    [Fact]
    public void A_pathological_single_call_has_fixed_per_call_bounds()
    {
        var large = Search();
        large["action"]!["sources"] = Sources(
            90,
            index => new JsonObject
            {
                ["type"] = "url",
                ["url"] = "https://example.com/" + index + new string('x', 1700),
                ["title"] = new string('界', 300),
            }
        );
        var evidence = Assert.Single(Evidence(HostedSearchSources.Project([Message(large)])));
        var call = Payload(evidence)["calls"]![0]!;
        Assert.True(
            Encoding.UTF8.GetByteCount(call.ToJsonString())
                <= HostedSearchSources.MaxCallEvidenceBytes
        );
        Assert.InRange(
            call["search_sources"]!.AsArray().Count,
            1,
            HostedSearchSources.MaxSourcesPerCall - 1
        );
        Assert.Equal(240, call["search_sources"]![0]!["title"]!.GetValue<string>().Length);
        // The bound is the call's own: a small earlier call is unaffected.
        var small = Message(Search("small"), "small");
        var projected = EvidenceByMessage(HostedSearchSources.Project([small, Message(large)]));
        Assert.Equal(Assert.Single(Evidence(HostedSearchSources.Project([small]))), projected[0]);
        Assert.Equal(evidence, projected[1]);
    }

    [Fact]
    public void Open_page_is_distinct_and_incomplete_calls_do_not_become_evidence()
    {
        var opened = Search();
        opened["action"] = new JsonObject
        {
            ["type"] = "open_page",
            ["url"] = "https://example.com/open",
        };
        var call = Payload(Assert.Single(Evidence(HostedSearchSources.Project([Message(opened)]))))[
            "calls"
        ]![0]!;
        Assert.Equal("open_page", call["action"]!.GetValue<string>());
        Assert.NotNull(call["opened_page"]);
        Assert.Null(call["search_sources"]);
        opened["status"] = "in_progress";
        Assert.Empty(Evidence(HostedSearchSources.Project([Message(opened)])));
    }

    [Theory]
    [InlineData("omitted")]
    [InlineData("empty")]
    [InlineData("enriched")]
    public void Aligned_final_search_actions_retain_and_enrich_streamed_sources(string mode)
    {
        var stream = new ResponsesEventAccumulator();
        stream.Consume(ResponsesPrefixCommitTests.Done(0, Search()));
        var final = Search();
        if (mode == "omitted")
            final["action"]!.AsObject().Remove("sources");
        else if (mode == "empty")
            final["action"]!["sources"] = new JsonArray();
        else
            final["action"]!["sources"]![0]!["title"] = "enriched";
        stream.Consume(ResponsesPrefixCommitTests.Completed(final));
        var sources = stream.CompleteAtEof()["output"]![0]!["action"]!["sources"]!.AsArray();
        Assert.Single(sources);
        Assert.Equal("https://example.com/source", sources[0]!["url"]!.GetValue<string>());
        if (mode == "enriched")
            Assert.Equal("enriched", sources[0]!["title"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("same", true)]
    [InlineData("different", false)]
    [InlineData("duplicate-final", false)]
    [InlineData("duplicate-stream", false)]
    public void Sparse_final_enriches_only_unambiguous_matching_search_ids(
        string scenario,
        bool enriched
    )
    {
        var stream = new ResponsesEventAccumulator();
        var item = Search();
        item["action"]!.AsObject().Remove("sources");
        stream.Consume(ResponsesPrefixCommitTests.Done(2, item));
        if (scenario == "duplicate-stream")
            stream.Consume(ResponsesPrefixCommitTests.Done(3, (JsonObject)item.DeepClone()));
        var final = Search(scenario == "different" ? "unrelated" : "search");
        stream.Consume(
            scenario == "duplicate-final"
                ? ResponsesPrefixCommitTests.Completed(final, (JsonObject)final.DeepClone())
                : ResponsesPrefixCommitTests.Completed(final)
        );
        var output = stream.CompleteAtEof()["output"]!.AsArray();
        Assert.Equal(scenario == "duplicate-stream" ? 2 : 1, output.Count);
        Assert.Equal(enriched, output[0]!["action"]!["sources"] is JsonArray);
    }
}
