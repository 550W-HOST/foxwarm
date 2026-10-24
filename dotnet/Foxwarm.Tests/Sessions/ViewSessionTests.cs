using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ViewSessionTests
{
    private static JsonObject Text(string text, string role = "user") =>
        VectorFixture.Message(text, role);

    private static JsonObject Tool(string id, bool result, bool error = false) =>
        new()
        {
            ["role"] = result ? "tool" : "model",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    [result ? "functionResponse" : "functionCall"] = result
                        ? new JsonObject
                        {
                            ["name"] = "read",
                            ["tool_use_id"] = id,
                            ["response"] = error
                                ? new JsonObject { ["error"] = "synthetic failure" }
                                : new JsonObject { ["output"] = "private tool needle" },
                        }
                        : new JsonObject
                        {
                            ["name"] = "read",
                            ["id"] = id,
                            ["args"] = new JsonObject { ["filePath"] = "sample" },
                        },
                }
            ),
        };

    private static string Output(JsonObject result) => result["output"]!.GetValue<string>();

    private static Task<JsonObject> View(OutboundMcpFixture f, JsonObject? args = null)
    {
        args ??= new JsonObject();
        args["sessionId"] = f.First.Id;
        return f.Manager.ObserveAsync(f.Second, "view_session", args);
    }

    [Fact]
    public async Task Tail_projection_counts_source_records_preserves_mixed_commentary_and_excludes_tool_linked_siblings()
    {
        await using var f = await OutboundMcpFixture.CreateAsync();
        var mixed = Tool("generated-mixed-id", false);
        mixed["parts"]![0]!["text"] = "mixed commentary";
        var result = Tool("generated-mixed-id", true);
        result["parts"]![0]!["text"] = "tool sibling";
        result["parts"]![0]!["inlineDataRef"] = new JsonObject
        {
            ["mimeType"] = "image/png",
            ["imageId"] = "tool-image",
        };
        await ForkClearLifecycleTests.AppendAsync(
            f.First,
            Text("early prose"),
            Tool("one", false),
            Tool("one", true),
            mixed,
            result,
            Text("newest prose")
        );
        var prose = Output(
            await View(f, new JsonObject { ["count"] = 3, ["parts"] = new JsonArray("text") })
        );
        Assert.Contains("3 matches from 3 selected", prose);
        Assert.Contains("early prose", prose);
        Assert.Contains("mixed commentary", prose);
        Assert.Contains("newest prose", prose);
        Assert.DoesNotContain("tool sibling", prose);
        Assert.DoesNotContain("private tool needle", prose);
        Assert.DoesNotContain("tool-image", prose);
        Assert.Contains("[0,6)", prose);
        var tail = Output(await View(f, new JsonObject { ["count"] = 1 }));
        Assert.Contains("newest prose", tail);
        Assert.DoesNotContain("early prose", tail);
        Assert.Contains("[#6 time", tail);
        Assert.DoesNotContain("[5]", tail);
        var zero = Output(await View(f, new JsonObject { ["count"] = 0 }));
        Assert.Contains("idle", zero);
        Assert.DoesNotContain("newest prose", zero);
        var images = Output(await View(f, new JsonObject { ["parts"] = new JsonArray("images") }));
        Assert.DoesNotContain("tool-image", images);
        var hiddenFilter = Output(
            await View(
                f,
                new JsonObject
                {
                    ["count"] = 2,
                    ["parts"] = new JsonArray("text"),
                    ["excludeRegex"] = "private tool needle",
                }
            )
        );
        Assert.Contains("mixed commentary", hiddenFilter);
        Assert.Contains("newest prose", hiddenFilter);
    }

    [Fact]
    public async Task Empty_page_filter_keeps_candidate_boundary_filters_and_version_and_append_does_not_shift_it()
    {
        await using var f = await OutboundMcpFixture.CreateAsync();
        await ForkClearLifecycleTests.AppendAsync(
            f.First,
            Enumerable.Range(1, 14).Select(n => Text("line-" + n)).ToArray()
        );
        var defaultPage = Output(await View(f));
        Assert.Contains("10 matches from 10 selected", defaultPage);
        Assert.DoesNotContain("line-4\n", defaultPage);
        Assert.Contains("line-14", defaultPage);
        var options = new JsonObject
        {
            ["count"] = 3,
            ["parts"] = new JsonArray("text"),
            ["contentFilter"] = "absent",
            ["includeRegex"] = "line",
            ["excludeRegex"] = "noise",
        };
        var filtered = Output(await View(f, options));
        Assert.Contains("0 matches from 3 selected", filtered);
        var olderLine = filtered.Split('\n').Single(line => line.StartsWith("Older: "));
        var older = JsonNode.Parse(olderLine["Older: view_session(".Length..^1])!.AsObject();
        Assert.Equal(11, older["before"]!.GetValue<int>());
        Assert.Equal("absent", older["contentFilter"]!.GetValue<string>());
        Assert.Equal("line", older["includeRegex"]!.GetValue<string>());
        Assert.Equal("noise", older["excludeRegex"]!.GetValue<string>());
        await ForkClearLifecycleTests.AppendAsync(f.First, Text("later append"));
        Assert.Contains("[8,11)", Output(await View(f, older)));
        await f.First.Entry.SaveLane.DeleteMessagesAsync(1);
        var stale = await View(f, older);
        Assert.Equal("stale_history_boundary", stale["error"]!.GetValue<string>());
        Assert.Contains("view_session(", Output(stale));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            View(f, new JsonObject { ["start"] = 0, ["before"] = 4 })
        );
        var negative = Output(await View(f, new JsonObject { ["start"] = -1 }));
        Assert.Contains("later append", negative);
    }

    [Fact]
    public async Task Large_requested_pages_keep_record_counts_navigation_and_output_budget_without_a_product_cap()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            Enumerable.Range(1, 250).Select(n => Text("source record " + n)).ToArray()
        );
        var args = new JsonObject
        {
            ["sessionId"] = f.Owner.Id,
            ["count"] = 200,
            ["parts"] = new JsonArray("text"),
            ["previewLength"] = 1000,
        };
        var page = Output(await f.Call("view_session", args));
        Assert.True(page.Length <= 1000);
        Assert.Contains("200 matches from 200 selected eligible source records", page);
        Assert.Contains("[50,250) of 250", page);
        var olderLine = page.Split('\n').Single(line => line.StartsWith("Older: "));
        var older = JsonNode.Parse(olderLine["Older: view_session(".Length..^1])!.AsObject();
        Assert.Equal(200, older["count"]!.GetValue<int>());
        Assert.Equal(50, older["before"]!.GetValue<int>());
        Assert.Equal("text", older["parts"]![0]!.GetValue<string>());
        Assert.NotNull(older["historyVersion"]);
        var previous = Output(await f.Call("view_session", older));
        Assert.True(previous.Length <= 1000);
        Assert.Contains("50 matches from 50 selected eligible source records", previous);
        Assert.Contains("[0,50) of 250", previous);

        args["count"] = 9007199254740991L;
        var entire = Output(await f.Call("view_session", args));
        Assert.True(entire.Length <= 1000);
        Assert.Contains("250 matches from 250 selected eligible source records", entire);
        Assert.Contains("[0,250) of 250", entire);
        Assert.DoesNotContain("Older: view_session(", entire);
    }

    [Fact]
    public async Task Names_group_logical_calls_once_errors_and_partial_results_without_generated_ids()
    {
        await using var f = await OutboundMcpFixture.CreateAsync();
        await ForkClearLifecycleTests.AppendAsync(
            f.First,
            Text("before"),
            Tool("hidden-id", false),
            Tool("hidden-id", true, true),
            Text("after")
        );
        var output = Output(await View(f));
        Assert.Contains("read ×1", output);
        Assert.DoesNotContain("read ×2", output);
        Assert.Contains("1 error", output);
        Assert.DoesNotContain("hidden-id", output);
        Assert.True(
            output.IndexOf("before", StringComparison.Ordinal)
                < output.IndexOf("read ×1", StringComparison.Ordinal)
        );
        Assert.True(
            output.IndexOf("read ×1", StringComparison.Ordinal)
                < output.IndexOf("after", StringComparison.Ordinal)
        );
        var partial = Output(await View(f, new JsonObject { ["start"] = 2, ["count"] = 1 }));
        Assert.Contains("partial/unpaired", partial);
        Assert.Contains("recall(", partial);
        var full = Output(await View(f, new JsonObject { ["toolDetail"] = "full" }));
        Assert.Contains("synthetic failure", full);
        Assert.DoesNotContain("hidden-id", full);
        var authored = Text("authored hidden-id remains");
        authored["modelVisible"] = false;
        await ForkClearLifecycleTests.AppendAsync(f.First, authored);
        Assert.Contains("authored hidden-id remains", Output(await View(f)));
        var archived = await ArchiveRecallTool.ExecuteAsync(
            f.Manager,
            f.First,
            new JsonObject { ["target"] = "msg#5", ["previewLength"] = 2000 }
        );
        Assert.Contains("[non-context]", Output(archived));
        var filtered = Output(
            await View(f, new JsonObject { ["contentFilter"] = "hidden-id", ["before"] = 4 })
        );
        Assert.Contains("0 matches from 4 selected", filtered);
    }

    [Fact]
    public void Context_identity_and_truncation_point_to_exact_Archive_original_without_active_indices_in_headings()
    {
        var block = new ArchiveBlockRecord(
            "main/sample",
            "main",
            9,
            1,
            "message",
            1,
            4,
            null,
            1,
            4,
            1000,
            4000,
            "block summary",
            null,
            5000
        ).ToMessage();
        var large = Text("prefix " + new string('x', 4000) + " payload end");
        large["__meta"] = new JsonObject { ["seq"] = 42, ["timestamp"] = 6000 };
        var page = new SessionViewPage(
            100,
            102,
            102,
            2,
            7,
            new JsonObject { ["state"] = "idle" },
            [(100, block), (101, large)]
        );
        var rendered = new ContextPreviewRenderer(
            new JsonObject { ["previewLength"] = 1000 }
        ).RenderLive("main/sample", page, new JsonObject { ["previewLength"] = 1000 });
        Assert.True(rendered.Length <= 1000);
        Assert.Contains("CTX B#9", rendered);
        Assert.Contains("[#42 time", rendered);
        Assert.DoesNotContain("[101]", rendered);
        Assert.Contains("Truncated preview", rendered);
        Assert.Contains("msg#42", rendered);
        Assert.Contains("recall(", rendered);
    }

    [Fact]
    public void Dense_budget_omissions_have_source_drills_and_generated_labels_are_not_search_content()
    {
        var rows = Enumerable
            .Range(1, 30)
            .Select(n =>
            {
                var row = Text("ordinary text " + n + " " + new string('x', 500));
                row["__meta"] = new JsonObject { ["seq"] = n, ["timestamp"] = n * 1000 };
                return (n - 1, row);
            })
            .ToArray();
        var page = new SessionViewPage(
            0,
            30,
            30,
            30,
            2,
            new JsonObject { ["state"] = "idle" },
            rows
        );
        var renderer = new ContextPreviewRenderer(new JsonObject { ["previewLength"] = 1000 });
        var output = renderer.RenderLive(
            "main/dense",
            page,
            new JsonObject { ["previewLength"] = 1000 }
        );
        Assert.True(output.Length <= 1000);
        Assert.Contains("Truncated preview", output);
        Assert.Contains("not displayed", output);
        var calls = System.Text.RegularExpressions.Regex.Matches(
            output,
            @"recall\((\{[^\n]+?\})\)"
        );
        Assert.NotEmpty(calls);
        foreach (System.Text.RegularExpressions.Match call in calls)
            Assert.NotNull(JsonNode.Parse(call.Groups[1].Value)!["target"]);
        var tool = Tool("correlation-id", false);
        var filtered = new ContextPreviewRenderer(
            new JsonObject { ["contentFilter"] = "call:" }
        ).Render("main/dense", "", 1, 0, [tool]);
        Assert.Contains("showing 0 of 1", filtered);
        var duplicates = new ContextPreviewRenderer(new JsonObject()).Render(
            "main/dense",
            "",
            3,
            0,
            [Tool("duplicate", false), Tool("duplicate", false), Tool("duplicate", true)]
        );
        Assert.Contains("read ×2", duplicates);
        Assert.Contains("partial/unpaired", duplicates);
        Assert.DoesNotContain("duplicate", duplicates);
    }

    [Fact]
    public async Task Current_model_direct_unified_and_native_ToolScript_use_only_new_executable_identity()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        await ForkClearLifecycleTests.AppendAsync(f.Owner, Text("latest evidence"));
        var definitions = f.Manager.ModelDefinitions(f.Owner).OfType<JsonObject>().ToArray();
        var view = Assert.Single(
            definitions,
            item => SessionWait.Text(item["name"]) == "view_session"
        );
        Assert.DoesNotContain(
            definitions,
            item => SessionWait.Text(item["name"]) == "get_session_messages"
        );
        Assert.NotNull(view["parameters"]!["properties"]!["parts"]);
        var args = new JsonObject { ["sessionId"] = f.Owner.Id, ["count"] = 1 };
        var direct = await f.Call("view_session", args);
        Assert.Contains("latest evidence", Output(direct));
        var unified = await f.Call(
            "call_tool",
            new JsonObject { ["toolId"] = "builtin:view_session", ["args"] = args.DeepClone() }
        );
        Assert.Equal(Output(direct), Output(unified));
        var script = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('view_session', {'sessionId': '"
                    + f.Owner.Id
                    + "', 'count': 1})",
            }
        );
        Assert.Equal(Output(direct), script["result"]!["output"]!.GetValue<string>());
        var old = await f.Call("get_session_messages", args);
        Assert.NotNull(old["error"]);
    }
}
