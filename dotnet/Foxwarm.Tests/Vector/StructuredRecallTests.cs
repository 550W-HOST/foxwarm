using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.ToolScript;
using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class StructuredRecallTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Date_and_filter_paths(bool lexical, bool child)
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync(child: child, lexical: lexical);
        await manager.Vector.WaitForStartupAsync();
        var owner = await manager.CreateNamedAsync("main", "review", null, null);
        await ForkClearLifecycleTests.AppendAsync(
            owner,
            VectorFixture.Message("StableMixedIdentifier violet original evidence")
        );
        await manager.ForceVectorIndexAsync(owner);
        var futureArgs = new JsonObject
        {
            ["vector_query"] = "StableMixedIdentifier",
            ["scope"] = "current-session",
            ["startTime"] = "2100-01-01T00:00:00Z",
        };
        var future = await ArchiveRecallTool.ExecuteAsync(
            manager,
            owner,
            futureArgs,
            programmatic: true
        );
        Assert.Null(future["error"]);
        Assert.Empty(future["items"]!.AsArray());
        foreach (
            var filter in new[]
            {
                new JsonObject { ["contentFilter"] = "absent literal" },
                new JsonObject { ["includeRegex"] = "absent regex" },
                new JsonObject { ["excludeRegex"] = "violet" },
            }
        )
        {
            filter["vector_query"] = "StableMixedIdentifier";
            filter["scope"] = "current-session";
            var ordinary = await ArchiveRecallTool.ExecuteAsync(manager, owner, filter);
            var structured = await ArchiveRecallTool.ExecuteAsync(
                manager,
                owner,
                filter,
                programmatic: true
            );
            Assert.DoesNotContain("original evidence", ordinary.ToJsonString());
            Assert.Empty(structured["items"]!.AsArray());
        }
        var scored = await ArchiveRecallTool.ExecuteAsync(
            manager,
            owner,
            new() { ["vector_query"] = "StableMixedIdentifier", ["scope"] = "current-session" },
            programmatic: true
        );
        Assert.NotNull(scored["items"]![0]!["denseDistance"]);
        Assert.NotNull(scored["items"]![0]!["lexicalScore"]);
        Assert.Equal(0, scored["items"]![0]!["lexicalRank"]!.GetValue<int>());
        Assert.Equal(2380d, scored["items"]![0]!["fusionScore"]!.GetValue<double>());
    }

    [Fact]
    public async Task Exact_single_large_message_returns_complete_canonical_json()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            VectorFixture.Message(new string('x', 21000))
        );
        var result = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('recall', {'target': 'msg#1', 'previewLength': 20000})",
            }
        );
        Assert.Equal(
            new string('x', 21000),
            result["result"]!["messages"]![0]!["parts"]![0]!["text"]!.GetValue<string>()
        );
        Assert.False(result["result"]!["truncated"]!.GetValue<bool>());
        Assert.True(result["result"]!["complete"]!.GetValue<bool>());
        Assert.True(result["result"]!["fullAvailable"]!.GetValue<bool>());
        Assert.True(
            JsonNode.DeepEquals(
                f.Owner.Archive.ReadMessages().Single().Message,
                result["result"]!["messages"]![0]
            )
        );
    }

    [Fact]
    public async Task Cursor_traversal_of_static_archive()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync();
        await manager.Vector.WaitForStartupAsync();
        var owner = await manager.CreateNamedAsync("main", "pages", null, null);
        // Real Archive producer shape; distinct blocks do not collapse into raw families.
        var blocks = Enumerable
            .Range(1, 1030)
            .Select(i =>
                f.Block(owner.Id, block: i, first: i, last: i, summary: "violet evidence " + i) with
                {
                    CreatedAt = i * 1000,
                    MemoryFacts = null,
                }
            )
            .ToArray();
        owner.Archive.WriteBlocks(blocks);
        await manager.Vector.ForceAsync(owner.Id, 0, 1030);
        var keys = new List<string>();
        var pages = new JsonArray();
        var args = new JsonObject
        {
            ["vector_query"] = "violet",
            ["scope"] = "current-session",
            ["limit"] = 20,
        };
        for (var page = 0; page < 60; page++)
        {
            var result = await ArchiveRecallTool.ExecuteAsync(
                manager,
                owner,
                args,
                programmatic: true
            );
            Assert.Null(result["error"]);
            keys.AddRange(result["items"]!.AsArray().Select(x => x!["key"]!.GetValue<string>()));
            pages.Add(
                new JsonObject
                {
                    ["page"] = page,
                    ["keys"] = new JsonArray(
                        result["items"]!.AsArray().Select(x => x!["key"]!.DeepClone()).ToArray()
                    ),
                    ["complete"] = result["complete"]!.DeepClone(),
                    ["windowComplete"] = result["windowComplete"]!.DeepClone(),
                    ["availableCount"] = result["availableCount"]!.DeepClone(),
                    ["totalRanked"] = result["totalRanked"]!.DeepClone(),
                }
            );
            if (result["nextCursor"] is null)
                break;
            args["cursor"] = result["nextCursor"]!.DeepClone();
        }
        Assert.False(pages.Last()!["complete"]!.GetValue<bool>());
        Assert.True(pages.Last()!["windowComplete"]!.GetValue<bool>());
        Assert.NotEmpty(keys);
        Assert.True(keys.Count < blocks.Length);
        Assert.Equal(keys.Count, keys.Distinct().Count());
    }

    [Fact]
    public async Task Cursor_retains_ranked_sources_and_does_not_repeat_search()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync();
        await manager.Vector.WaitForStartupAsync();
        var owner = await manager.CreateNamedAsync("main", "stable-pages", null, null);
        owner.Archive.WriteBlocks(
            Enumerable
                .Range(1, 200)
                .Select(i =>
                    f.Block(
                        owner.Id,
                        block: i,
                        first: i,
                        last: i,
                        summary: "violet evidence " + i
                    ) with
                    {
                        CreatedAt = i * 1000,
                        MemoryFacts = null,
                    }
                )
                .ToArray()
        );
        await manager.Vector.ForceAsync(owner.Id, 0, 200);
        var keys = new List<string>();
        var args = new JsonObject
        {
            ["vector_query"] = "violet",
            ["scope"] = "current-session",
            ["limit"] = 1,
        };
        var requests = f.Peer.Requests.Count;
        int? available = null;
        for (var page = 0; page < 205; page++)
        {
            var result = await ArchiveRecallTool.ExecuteAsync(
                manager,
                owner,
                args,
                programmatic: true
            );
            Assert.Null(result["error"]);
            available ??= result["availableCount"]!.GetValue<int>();
            keys.AddRange(result["items"]!.AsArray().Select(x => x!["key"]!.GetValue<string>()));
            if (result["nextCursor"] is null)
                break;
            args["cursor"] = result["nextCursor"]!.DeepClone();
        }
        Assert.NotEmpty(keys);
        Assert.Equal(available, keys.Count);
        Assert.Equal(keys.Count, keys.Distinct().Count());
        Assert.Equal(requests + 1, f.Peer.Requests.Count);
    }

    [Fact]
    public async Task Dense_range_filters_individual_messages()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync();
        await manager.Vector.WaitForStartupAsync();
        var owner = await manager.CreateNamedAsync("main", "time-range", null, null);
        f.Append(owner.Id, 1, "violet outside interval");
        f.Append(owner.Id, 2, "violet inside interval");
        await manager.Vector.ForceAsync(owner.Id, 2, 0);
        var result = await ArchiveRecallTool.ExecuteAsync(
            manager,
            owner,
            new()
            {
                ["vector_query"] = "violet",
                ["scope"] = "current-session",
                ["startTime"] = "1970-01-01T00:00:01.500Z",
                ["endTime"] = "1970-01-01T00:00:02.500Z",
            },
            programmatic: true
        );
        Assert.Null(result["error"]);
        Assert.DoesNotContain("outside interval", result.ToJsonString());
        Assert.Contains("inside interval", result.ToJsonString());
    }

    [Fact]
    public async Task Native_script_pages_filtered_sources_and_observes_completion_scope()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync();
        await manager.Vector.WaitForStartupAsync();
        var owner = await manager.CreateNamedAsync("main", "script-pages", null, null);
        owner.Archive.WriteBlocks(
            Enumerable
                .Range(1, 3)
                .Select(id =>
                    f.Block(
                        owner.Id,
                        block: id,
                        first: id,
                        last: id,
                        summary: id == 2 ? "violet excluded" : "violet allowed " + id
                    ) with
                    {
                        MemoryFacts = null,
                    }
                )
                .ToArray()
        );
        await manager.Vector.ForceAsync(owner.Id, 0, 3);
        await using var mcp = new Foxwarm.McpClient(f.Work);
        var definitions = new JsonArray(ArchiveRecallTool.Definition());
        foreach (var definition in ToolScriptToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(definitions, mcp, _ => f.Work);
        var tools = new SessionToolExecutor(new WorkspaceTools(f.Work), owner, manager, registry);
        tools.BeginTurn();
        var result = (
            await tools.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = "script-pages",
                    ["name"] = "run_script",
                    ["args"] = new JsonObject
                    {
                        ["code"] = """
                        args = {'vector_query': 'violet', 'scope': 'current-session', 'limit': 1, 'contentFilter': 'allowed'}
                        page = call_tool('recall', args)
                        first = page['items'][0]
                        args['cursor'] = page['nextCursor']
                        page = call_tool('recall', args)
                        return {'first': first, 'second': page['items'][0], 'windowComplete': page['windowComplete'], 'complete': page['complete']}
                        """,
                    },
                },
                default
            )
        )!.AsObject();
        Assert.Equal("completed", result["status"]!.GetValue<string>());
        var value = result["result"]!;
        Assert.NotEqual(
            value["first"]!["key"]!.GetValue<string>(),
            value["second"]!["key"]!.GetValue<string>()
        );
        Assert.Equal(1, value["first"]!["rank"]!.GetValue<int>());
        Assert.Equal(2, value["second"]!["rank"]!.GetValue<int>());
        Assert.DoesNotContain("excluded", value.ToJsonString());
        Assert.True(value["windowComplete"]!.GetValue<bool>());
        Assert.False(value["complete"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Cursor_binds_filters_and_owner_and_rechecks_source_authority()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync();
        await manager.Vector.WaitForStartupAsync();
        await manager.CreateAgentAsync("destination", false);
        var source = await manager.CreateNamedAsync("main", "source", null, null);
        var caller = await manager.CreateNamedAsync("main", "caller", null, null);
        var other = await manager.CreateNamedAsync("main", "other", null, null);
        source.Archive.WriteBlocks(
            Enumerable
                .Range(1, 2)
                .Select(id =>
                    f.Block(
                        source.Id,
                        block: id,
                        first: id,
                        last: id,
                        summary: "violet allowed " + id
                    ) with
                    {
                        Agent = source.Agent,
                        MemoryFacts = null,
                    }
                )
                .ToArray()
        );
        await manager.Vector.ForceAsync(source.Id, 0, 2);
        var args = new JsonObject
        {
            ["vector_query"] = "violet",
            ["scope"] = "current-agent",
            ["limit"] = 1,
        };
        var first = await ArchiveRecallTool.ExecuteAsync(manager, caller, args, programmatic: true);
        Assert.Null(first["error"]);
        Assert.Equal(2, first["availableCount"]!.GetValue<int>());
        args["cursor"] = first["nextCursor"]!.DeepClone();
        var changed = (JsonObject)args.DeepClone();
        changed["excludeRegex"] = "allowed";
        Assert.NotNull(
            (await ArchiveRecallTool.ExecuteAsync(manager, caller, changed, programmatic: true))[
                "error"
            ]
        );
        Assert.NotNull(
            (await ArchiveRecallTool.ExecuteAsync(manager, other, args, programmatic: true))[
                "error"
            ]
        );
        await manager.MoveIdentityAsync(
            caller,
            new JsonObject
            {
                ["sessionId"] = source.Id,
                ["newAgentName"] = "destination",
                ["newSessionId"] = "moved",
            }
        );
        var denied = await ArchiveRecallTool.ExecuteAsync(
            manager,
            caller,
            args,
            programmatic: true
        );
        Assert.NotNull(denied["error"]);
        Assert.Null(denied["items"]);
    }
}
