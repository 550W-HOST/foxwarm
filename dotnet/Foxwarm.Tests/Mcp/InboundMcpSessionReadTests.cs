using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using SdkClient = ModelContextProtocol.Client.McpClient;

namespace Foxwarm.Tests;

public sealed class InboundMcpSessionReadTests
{
    private static JsonObject Value(JsonObject result)
    {
        Assert.False(result["isError"]?.GetValue<bool>() ?? false, result.ToJsonString());
        var value = result["structuredContent"]!.AsObject();
        Assert.Equal(value.ToJsonString(), result["content"]![0]!["text"]!.GetValue<string>());
        return value;
    }

    private static string Preview(JsonObject page) => page["preview"]!.GetValue<string>();

    private static JsonObject Navigation(JsonObject page, string direction)
    {
        var prefix = direction + ": foxwarm_session(";
        var line = Preview(page).Split('\n').Single(line => line.StartsWith(prefix));
        var args = JsonNode.Parse(line[prefix.Length..^1])!.AsObject();
        Assert.Equal("read", args["action"]!.GetValue<string>());
        return args;
    }

    private static Task<JsonObject> Call(SdkClient client, JsonObject args) =>
        InboundMcpFixture.CallAsync(client, "foxwarm_session", args);

    private static Task<JsonObject> Read(
        SdkClient client,
        SessionOwner owner,
        JsonObject? options = null
    )
    {
        var args = options is null ? new JsonObject() : (JsonObject)options.DeepClone();
        args["action"] = "read";
        args["sessionId"] = owner.Id;
        return Call(client, args);
    }

    [Fact]
    public async Task Exact_external_read_pages_use_live_boundaries_versions_and_scoped_authority_over_HTTP()
    {
        await using var f = await InboundMcpFixture.CreateAsync(allow: false);
        var other = await f.Manager.CreateNamedAsync("main", "other", null, null);
        await f.PolicyAsync(
            "version: 1\nrules:\n  - id: selected-read\n    action: allow\n    match:\n      externalId: alpha\n      tool: {source: builtin, name: view_session}\n      args: {sessionId: "
                + f.Target.Id
                + "}\n"
        );
        await ForkClearLifecycleTests.AppendAsync(
            f.Target,
            Enumerable
                .Range(1, 14)
                .Select(n => VectorFixture.Message("line-" + n, "user"))
                .ToArray()
        );
        await using var client = await f.ClientAsync();
        var page = Value(await Read(client, f.Target));
        Assert.Equal(f.Target.Id, page["sessionId"]!.GetValue<string>());
        Assert.Equal(4, page["start"]!.GetValue<int>());
        Assert.Equal(14, page["end"]!.GetValue<int>());
        Assert.Equal(10, page["count"]!.GetValue<int>());
        Assert.Equal(14, page["total"]!.GetValue<int>());
        Assert.Equal("idle", page["executionState"]!["state"]!.GetValue<string>());
        Assert.False(page["executionState"]!["busy"]!.GetValue<bool>());
        Assert.Equal(0, page["executionState"]!["queueLength"]!.GetValue<int>());
        Assert.Null(page["messages"]);
        Assert.Null(page["queue"]);
        Assert.Null(page["persistentMemorySnapshot"]);
        Assert.True(
            Preview(page).IndexOf("line-5", StringComparison.Ordinal)
                < Preview(page).IndexOf("line-14", StringComparison.Ordinal)
        );
        Assert.DoesNotContain("view_session(", Preview(page));
        var older = Navigation(page, "Older");
        Assert.Equal(4, older["before"]!.GetValue<int>());
        Assert.Null(older["start"]);
        Assert.Equal(
            page["historyVersion"]!.GetValue<long>(),
            older["historyVersion"]!.GetValue<long>()
        );
        await ForkClearLifecycleTests.AppendAsync(
            f.Target,
            VectorFixture.Message("later append", "user")
        );
        var previous = Value(await Call(client, older));
        Assert.Equal(0, previous["start"]!.GetValue<int>());
        Assert.Equal(4, previous["count"]!.GetValue<int>());
        var newer = Navigation(previous, "Newer");
        Assert.Equal(4, newer["start"]!.GetValue<int>());
        Assert.Null(newer["before"]);
        var forward = Value(await Call(client, newer));
        Assert.Equal(4, forward["start"]!.GetValue<int>());
        Assert.Equal(14, forward["end"]!.GetValue<int>());
        var negative = Value(await Read(client, f.Target, new() { ["start"] = -1 }));
        Assert.Equal(14, negative["start"]!.GetValue<int>());
        Assert.Contains("later append", Preview(negative));
        var status = Value(await Read(client, f.Target, new() { ["count"] = 0 }));
        Assert.Equal(0, status["count"]!.GetValue<int>());
        Assert.Equal(15, status["start"]!.GetValue<int>());
        Assert.Equal(15, status["end"]!.GetValue<int>());
        Assert.DoesNotContain("later append", Preview(status));
        await f.Target.Entry.SaveLane.DeleteMessagesAsync(1);
        var staleResult = await Call(client, older);
        Assert.True(staleResult["isError"]!.GetValue<bool>());
        var stale = staleResult["structuredContent"]!.AsObject();
        Assert.Equal(stale.ToJsonString(), staleResult["content"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("stale_history_boundary", stale["error"]!.GetValue<string>());
        Assert.NotEqual(
            page["historyVersion"]!.GetValue<long>(),
            stale["historyVersion"]!.GetValue<long>()
        );
        Assert.Equal(0, stale["count"]!.GetValue<int>());
        Assert.Contains("foxwarm_session(", Preview(stale));
        Assert.DoesNotContain("view_session(", Preview(stale));
        var refresh = Preview(stale).Split("foxwarm_session(", 2)[1];
        var refreshed = Value(await Call(client, JsonNode.Parse(refresh[..^1])!.AsObject()));
        Assert.Equal(14, refreshed["total"]!.GetValue<int>());
        foreach (
            var denied in new[]
            {
                new JsonObject { ["action"] = "list" },
                new JsonObject { ["action"] = "read", ["sessionId"] = other.Id },
                new JsonObject { ["action"] = "read", ["sessionId"] = "<main>" },
                new JsonObject
                {
                    ["action"] = "send",
                    ["sessionId"] = f.Target.Id,
                    ["message"] = "denied",
                },
            }
        )
            Assert.True((await Call(client, denied))["isError"]!.GetValue<bool>());
        await f.PolicyAsync("version: 1\nrules: []\n");
        Assert.True((await Read(client, f.Target))["isError"]!.GetValue<bool>());
    }

    private static JsonObject Tool(bool result) =>
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
                            ["tool_use_id"] = "pair",
                            ["response"] = new JsonObject { ["output"] = "tool-only needle" },
                        }
                        : new JsonObject
                        {
                            ["name"] = "read",
                            ["id"] = "pair",
                            ["args"] = new JsonObject { ["filePath"] = "argument needle" },
                        },
                }
            ),
        };

    [Fact]
    public async Task Structural_selection_precedes_count_and_filters_stay_on_the_selected_included_content()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        var mixed = Tool(false);
        mixed["parts"]![0]!["text"] = "mixed commentary";
        var result = Tool(true);
        result["parts"]![0]!["text"] = "tool sibling";
        result["parts"]![0]!["inlineDataRef"] = new JsonObject
        {
            ["mimeType"] = "image/png",
            ["imageId"] = "tool-image",
        };
        var image = VectorFixture.Message("", "user");
        image["parts"] = new JsonArray(
            new JsonObject
            {
                ["inlineDataRef"] = new JsonObject
                {
                    ["mimeType"] = "image/png",
                    ["imageId"] = "visible-image",
                },
            }
        );
        await ForkClearLifecycleTests.AppendAsync(
            f.Target,
            VectorFixture.Message("early prose", "user"),
            Tool(false),
            Tool(true),
            mixed,
            result,
            image,
            VectorFixture.Message("newest prose", "user")
        );
        await using var client = await f.ClientAsync();
        var text = Value(
            await Read(
                client,
                f.Target,
                new()
                {
                    ["count"] = 3,
                    ["parts"] = new JsonArray("text"),
                    ["excludeRegex"] = "tool-only needle",
                }
            )
        );
        Assert.Equal(0, text["start"]!.GetValue<int>());
        Assert.Equal(3, text["count"]!.GetValue<int>());
        Assert.Contains("early prose", Preview(text));
        Assert.Contains("mixed commentary", Preview(text));
        Assert.Contains("newest prose", Preview(text));
        Assert.DoesNotContain("tool sibling", Preview(text));
        Assert.DoesNotContain("tool-image", Preview(text));
        var images = Value(
            await Read(client, f.Target, new() { ["parts"] = new JsonArray("images") })
        );
        Assert.Equal(1, images["count"]!.GetValue<int>());
        Assert.Contains("visible-image", Preview(images));
        Assert.DoesNotContain("tool-image", Preview(images));
        var filtered = Value(
            await Read(
                client,
                f.Target,
                new()
                {
                    ["count"] = 2,
                    ["parts"] = new JsonArray("text"),
                    ["contentFilter"] = "EARLY",
                    ["includeRegex"] = "prose",
                    ["excludeRegex"] = "noise",
                }
            )
        );
        Assert.Equal(2, filtered["count"]!.GetValue<int>());
        Assert.Contains("0 matches from 2 selected", Preview(filtered));
        var previous = Value(await Call(client, Navigation(filtered, "Older")));
        Assert.Equal(1, previous["count"]!.GetValue<int>());
        Assert.Contains("early prose", Preview(previous));
        var tools = Value(await Read(client, f.Target, new() { ["start"] = 1, ["count"] = 2 }));
        Assert.Contains("read ×1", Preview(tools));
        Assert.DoesNotContain("argument needle", Preview(tools));
        Assert.DoesNotContain("recall(", Preview(tools));
        Assert.Contains("Archive originals are not available", Preview(tools));
        foreach (var detail in new[] { "snippets", "full" })
        {
            var expanded = Value(
                await Read(
                    client,
                    f.Target,
                    new()
                    {
                        ["start"] = 1,
                        ["count"] = 2,
                        ["toolDetail"] = detail,
                    }
                )
            );
            Assert.Contains("argument needle", Preview(expanded));
            Assert.Contains("tool-only needle", Preview(expanded));
        }
        var partial = Value(await Read(client, f.Target, new() { ["start"] = 2, ["count"] = 1 }));
        Assert.Contains("partial/unpaired", Preview(partial));
        Assert.DoesNotContain("recall(", Preview(partial));
        const string authored =
            "Authored text: recall({target: 'msg#1'}) and view_session({count: 1}).";
        await ForkClearLifecycleTests.AppendAsync(
            f.Target,
            VectorFixture.Message(authored, "user")
        );
        var untouched = Value(await Read(client, f.Target, new() { ["count"] = 1 }));
        Assert.Contains(authored, Preview(untouched));
    }

    [Fact]
    public async Task Large_read_limits_and_preview_defaults_clamping_and_errors_keep_the_external_result_shape()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await ForkClearLifecycleTests.AppendAsync(
            f.Target,
            Enumerable
                .Range(1, 250)
                .Select(n =>
                    VectorFixture.Message("record " + n + " " + new string('x', 500), "user")
                )
                .ToArray()
        );
        await using var client = await f.ClientAsync();
        var options = new JsonObject { ["count"] = 200, ["previewLength"] = 1000 };
        var bounded = Value(await Read(client, f.Target, options));
        Assert.Equal(50, bounded["start"]!.GetValue<int>());
        Assert.Equal(200, bounded["count"]!.GetValue<int>());
        Assert.True(Preview(bounded).Length <= 1000);
        Assert.Contains("not displayed", Preview(bounded));
        Assert.DoesNotContain("recall(", Preview(bounded));
        Assert.Contains("Archive originals are not available", Preview(bounded));
        options["count"] = 9007199254740991L;
        var all = Value(await Read(client, f.Target, options));
        Assert.Equal(250, all["count"]!.GetValue<int>());
        Assert.Equal(0, all["start"]!.GetValue<int>());
        options["count"] = 250;
        options.Remove("previewLength");
        var normal = Value(await Read(client, f.Target, options));
        options["previewLength"] = 0;
        Assert.Equal(Preview(normal), Preview(Value(await Read(client, f.Target, options))));
        Assert.True(Preview(normal).Length <= 6000);
        foreach (var (budget, maximum) in new[] { (-10.5, 1000), (999.9, 1000), (20001.0, 20000) })
        {
            options["previewLength"] = budget;
            var clamped = Value(await Read(client, f.Target, options));
            Assert.True(Preview(clamped).Length <= maximum);
            Assert.Contains("[warning]", Preview(clamped));
        }
        foreach (
            var invalid in new[]
            {
                new JsonObject { ["start"] = 0, ["before"] = 5 },
                new JsonObject { ["count"] = -1 },
                new JsonObject { ["count"] = 9007199254740992L },
                new JsonObject { ["before"] = -1 },
                new JsonObject { ["historyVersion"] = -1 },
                new JsonObject { ["parts"] = new JsonArray("invalid") },
                new JsonObject { ["includeRegex"] = "[" },
                new JsonObject { ["toolDetail"] = "invalid" },
            }
        )
        {
            var error = await Read(client, f.Target, invalid);
            Assert.True(error["isError"]!.GetValue<bool>());
            Assert.Equal("text", error["content"]![0]!["type"]!.GetValue<string>());
            Assert.Null(error["structuredContent"]);
        }
        foreach (var action in new[] { "list", "send" })
        foreach (
            var key in new[]
            {
                "before",
                "historyVersion",
                "parts",
                "previewLength",
                "contentFilter",
                "includeRegex",
                "excludeRegex",
                "toolDetail",
            }
        )
        {
            var args = new JsonObject { ["action"] = action, [key] = "ignored?" };
            if (action == "send")
            {
                args["sessionId"] = f.Target.Id;
                args["message"] = "must not be admitted";
            }
            Assert.True((await Call(client, args))["isError"]!.GetValue<bool>());
        }
        Assert.Empty(f.Target.Entry.Snapshot().Queue);
        foreach (var count in new[] { 0, 51 })
            Assert.True(
                (await Call(client, new() { ["action"] = "list", ["count"] = count }))[
                    "isError"
                ]!.GetValue<bool>()
            );
    }
}
