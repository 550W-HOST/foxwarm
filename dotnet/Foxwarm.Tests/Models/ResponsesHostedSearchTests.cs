using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed partial class ResponsesPrefixCommitTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Search_waits_for_final_sources_then_tools_receive_evidence_and_ws_reuse_resumes(
        bool websocket
    )
    {
        var prefix = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var draft = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Owner? owner = null;
        var search = HostedSearchSourcesTests.Search();
        var sparse = (JsonObject)search.DeepClone();
        sparse["action"]!.AsObject().Remove("sources");
        const string marker = "\uE200cite\uE202turn0search3\uE201";
        const string lead = "😀 exact claim ";
        var text = Commentary(lead + marker);
        var annotated = (JsonObject)text.DeepClone();
        var annotation = new JsonObject
        {
            ["type"] = "url_citation",
            ["url"] = "https://example.com/exact",
            ["title"] = "Exact title",
            ["start_index"] = lead.Length - 1,
            ["end_index"] = lead.Length - 1 + marker.Length,
        };
        annotated["content"]![0]!["annotations"] = new JsonArray(annotation);
        var tool = new JsonObject
        {
            ["type"] = "function_call",
            ["call_id"] = "local",
            ["name"] = "read",
            ["arguments"] = "{}",
        };
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, number) =>
            {
                if (number == 1)
                {
                    Assert.Contains(
                        HostedSearchSources.Include,
                        context.Request["include"]!
                            .AsArray()
                            .Select(node => node!.GetValue<string>())
                    );
                    await context.Send(Done(0, Reasoning()));
                    await context.Send(Done(1, Commentary("early")));
                    await prefix.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    await context.Send(Done(2, sparse));
                    await context.Send(Done(3, text));
                    await draft.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    Assert.DoesNotContain(
                        "web_search_call",
                        string.Concat(owner!.Visible.Select(row => row.ToJsonString()))
                    );
                    Assert.DoesNotContain(
                        marker,
                        string.Concat(owner.Visible.Select(row => row.ToJsonString()))
                    );
                    await context.Send(Done(4, tool));
                    await context.Send(
                        Completed(Reasoning(), Commentary("early"), search, annotated, tool)
                    );
                }
                else
                {
                    if (number == 2)
                    {
                        Assert.Null(context.Request["previous_response_id"]);
                        var input = context.Request["input"]!.AsArray();
                        Assert.Contains(
                            input,
                            item => item?["type"]?.GetValue<string>() == "web_search_call"
                        );
                        var evidenceIndex = Enumerable
                            .Range(0, input.Count)
                            .Single(index =>
                                input[index]?["content"] is JsonArray content
                                && content.Any(part =>
                                    part?["text"]?.GetValue<string>()
                                        .StartsWith(
                                            "Historical hosted web-search source data",
                                            StringComparison.Ordinal
                                        ) == true
                                )
                            );
                        var callIndex = Enumerable
                            .Range(0, input.Count)
                            .Single(index =>
                                input[index]?["type"]?.GetValue<string>() == "function_call"
                            );
                        Assert.True(evidenceIndex < callIndex);
                        Assert.Contains(
                            input,
                            item => item?["type"]?.GetValue<string>() == "function_call_output"
                        );
                        Assert.Contains(
                            "https://example.com/source",
                            input[evidenceIndex]!.ToJsonString()
                        );
                    }
                    else if (websocket)
                    {
                        Assert.NotNull(context.Request["previous_response_id"]);
                        Assert.DoesNotContain(
                            "hosted_web_search_sources",
                            context.Request["input"]!.ToJsonString()
                        );
                    }
                    await context.Send(Completed(Commentary("finished", "final_answer")));
                }
            }
        );
        await using var owned = owner = new Owner(
            peer.Uri,
            websocket,
            providerFields: JsonNode.Parse("""{"webSearch":{"enabled":true}}""")!.AsObject(),
            observed: progress =>
            {
                if (progress.Text.Contains(marker, StringComparison.Ordinal))
                    draft.TrySetResult();
            }
        );
        owner.Entry.AssistantCommitted = _ =>
        {
            prefix.TrySetResult();
            return Task.CompletedTask;
        };
        await owner.Run();
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(1, owner.Tools.Count);
        var saved = (await owner.Store.LoadAsync("s"))!.History.Materialize();
        var hosted = saved
            .SelectMany(row => row["parts"]!.AsArray())
            .Single(part =>
                part?["providerMeta"]?["openaiResponses"]?["outputItem"]?[
                    "type"
                ]?.GetValue<string>() == "web_search_call"
            );
        Assert.Equal(
            "https://example.com/source",
            hosted!["providerMeta"]!["openaiResponses"]!["outputItem"]!["action"]!["sources"]![0]![
                "url"
            ]!.GetValue<string>()
        );
        var cited = saved
            .SelectMany(row => row["parts"]!.AsArray())
            .Single(part => part?["text"]?.GetValue<string>() == lead + marker);
        Assert.True(
            JsonNode.DeepEquals(
                annotation,
                cited!["providerMeta"]!["openaiResponses"]!["annotations"]![0]
            )
        );
        Assert.Empty(HostedSearchSourcesTests.Evidence(saved));
        Assert.Equal(
            3,
            saved.Single(row =>
                row["__meta"]?["llmSegment"]?["complete"]?.GetValue<bool>() == true
            )["__meta"]!["usage"]!["outputTokens"]!.GetValue<long>()
        );
        await owner.Run("next input");
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(3, peer.Requests.Count);
    }

    [Theory]
    [InlineData(false, "none", "custom", true)]
    [InlineData(true, "none", "custom", true)]
    [InlineData(false, "high", "custom", true)]
    [InlineData(true, "high", "custom", true)]
    [InlineData(false, "none", "removed-tools", false)]
    [InlineData(true, "high", "preview", true)]
    [InlineData(false, "high", "already-included", true)]
    public async Task Final_hosted_declaration_controls_sources_include_after_overrides(
        bool websocket,
        string effort,
        string mode,
        bool enabled
    )
    {
        var extra = new JsonObject
        {
            ["include"] = new JsonArray("custom", "reasoning.encrypted_content"),
        };
        if (mode == "already-included")
            extra["include"]!.AsArray().Add(HostedSearchSources.Include);
        if (mode == "removed-tools")
            extra["tools"] = new JsonArray();
        if (mode == "preview")
            extra["tools"] = new JsonArray(new JsonObject { ["type"] = "web_search_preview" });
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, _) =>
            {
                var include = context.Request["include"]!
                    .AsArray()
                    .Select(node => node!.GetValue<string>())
                    .ToArray();
                Assert.Contains("custom", include);
                Assert.Equal(
                    enabled ? 1 : 0,
                    include.Count(value => value == HostedSearchSources.Include)
                );
                Assert.Equal(effort != "none", include.Contains("reasoning.encrypted_content"));
                await context.Send(Completed(Commentary("done", "final_answer")));
            }
        );
        var fields = new JsonObject
        {
            ["webSearch"] = new JsonObject { ["enabled"] = mode != "preview" },
            ["extraFields"] = extra,
            ["effort"] = new JsonObject
            {
                ["allowed"] = new JsonArray("none", "high"),
                ["default"] = effort,
            },
        };
        await using var owner = new Owner(peer.Uri, websocket, providerFields: fields);
        await owner.Run();
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Single(peer.Requests);
    }
}
