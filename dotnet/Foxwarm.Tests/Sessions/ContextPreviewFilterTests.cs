using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ContextPreviewFilterTests
{
    [Theory]
    [InlineData("contentFilter", "alpha\nbeta", true)]
    [InlineData("includeRegex", "alpha\\nbeta", true)]
    [InlineData("excludeRegex", "alpha\\nbeta", false)]
    public async Task Observation_filters_normalize_CRLF_without_rewriting_history(
        string name,
        string pattern,
        bool includesMessage
    )
    {
        await using var fixture = await OutboundMcpFixture.CreateAsync();
        await ForkClearLifecycleTests.AppendAsync(
            fixture.First,
            VectorFixture.Message("alpha\r\nbeta"),
            VectorFixture.Message("unrelated context")
        );
        var args = new JsonObject
        {
            ["sessionId"] = fixture.First.Id,
            ["start"] = 0,
            ["count"] = 20,
            ["previewLength"] = 1000,
            [name] = pattern,
        };
        var result = await fixture.Manager.ObserveAsync(fixture.First, "view_session", args);
        var output = result["output"]!.GetValue<string>();
        Assert.True(output.Length <= 1000);
        Assert.Contains("1 matches from 2 selected", output);
        Assert.Equal(includesMessage, output.Contains("alpha\r\nbeta", StringComparison.Ordinal));
        Assert.Equal(
            !includesMessage,
            output.Contains("unrelated context", StringComparison.Ordinal)
        );
        Assert.Equal(
            "alpha\r\nbeta",
            fixture.First.History()[0]["parts"]![0]!["text"]!.GetValue<string>()
        );
        Assert.Equal(
            "alpha\r\nbeta",
            fixture.First.Archive.ReadMessages()[0].Message["parts"]![0]![
                "text"
            ]!.GetValue<string>()
        );

        args.Remove("sessionId");
        args.Remove("start");
        args.Remove("count");
        args["target"] = "msg#1-2";
        var recalled = await ArchiveRecallTool.ExecuteAsync(fixture.Manager, fixture.First, args);
        var recallOutput = recalled["output"]!.GetValue<string>();
        Assert.True(recallOutput.Length <= 1000);
        Assert.Contains("Showing 1 of 2 selected messages", recallOutput);
        Assert.Equal(
            includesMessage,
            recallOutput.Contains("alpha\r\nbeta", StringComparison.Ordinal)
        );
    }

    [Fact]
    public void Omitted_tool_match_uses_the_same_CRLF_search_normalization()
    {
        var renderer = new ContextPreviewRenderer(
            new JsonObject { ["contentFilter"] = "alpha\nbeta", ["previewLength"] = 1000 }
        );
        var output = renderer.Render(
            "main/context",
            "",
            1,
            0,
            [
                new JsonObject
                {
                    ["role"] = "tool",
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["functionResponse"] = new JsonObject
                            {
                                ["name"] = "read",
                                ["tool_use_id"] = "read-context",
                                ["response"] = new JsonObject { ["output"] = "alpha\r\nbeta" },
                            },
                        }
                    ),
                },
            ]
        );
        Assert.True(output.Length <= 1000);
        Assert.Contains("showing 1 of 1", output);
        Assert.Contains("Matched in omitted tool call/result content", output);
    }
}
