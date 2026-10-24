using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class LiteralRecallTests
{
    private static string Output(JsonObject result) => result["output"]!.GetValue<string>();

    private static JsonObject Args(string query, int limit = 5) =>
        new()
        {
            ["text_query"] = query,
            ["limit"] = limit,
            ["previewLength"] = 4000,
        };

    [Fact]
    public async Task Vector_independent_lookup_scans_one_native_page_and_continues_after_bounded_empty_span()
    {
        await using var f = await OutboundMcpFixture.CreateAsync();
        await ForkClearLifecycleTests.AppendAsync(
            f.First,
            Enumerable
                .Range(1, 130)
                .Select(n =>
                    VectorFixture.Message(
                        n == 2
                            ? "An authored MiXeD\r\nline with \"quoted\" evidence 🦊"
                            : "ordinary row " + n
                    )
                )
                .ToArray()
        );
        await f.First.Entry.SaveLane.DeleteMessagesAsync(130);
        var before = f.First.Entry.Snapshot();
        var args = Args("mixed\nline");
        var page = Output(await ArchiveRecallTool.ExecuteAsync(f.Manager, f.First, args));
        Assert.Contains("100 archived messages", page);
        Assert.Contains("#31–#130", page);
        Assert.Contains("No literal matches in the examined range", page);
        var nextLine = page.Split('\n')
            .Single(line => line.StartsWith("Older literal search: recall("));
        var next = JsonNode.Parse(nextLine["Older literal search: recall(".Length..^1])!.AsObject();
        Assert.Equal(31, next["beforeSeq"]!.GetValue<int>());
        Assert.Equal(f.First.Id, next["sessionId"]!.GetValue<string>());
        var older = Output(await ArchiveRecallTool.ExecuteAsync(f.Manager, f.First, next));
        Assert.Contains("30 archived messages", older);
        Assert.Contains("#1–#30", older);
        Assert.Contains("[#2 time", older);
        Assert.Contains("MiXeD\r\nline", older);
        Assert.Contains("No older messages remain", older);
        Assert.Equal(before.HistoryVersion, f.First.Entry.Snapshot().HistoryVersion);
        Assert.Empty(f.First.History());
        Assert.Equal(130, f.First.Archive.EffectiveMessageStats().Count);
    }

    [Fact]
    public async Task Hit_limit_stops_at_examined_boundary_without_losing_older_hits_and_filters_narrow_only_that_selection()
    {
        await using var f = await OutboundMcpFixture.CreateAsync();
        await ForkClearLifecycleTests.AppendAsync(
            f.First,
            Enumerable.Range(1, 12).Select(n => VectorFixture.Message("literal hit " + n)).ToArray()
        );
        var args = Args("HIT", 2);
        args["includeRegex"] = "11$";
        var result = Output(await ArchiveRecallTool.ExecuteAsync(f.Manager, f.First, args));
        Assert.Contains("2 archived messages", result);
        Assert.Contains("#11–#12", result);
        Assert.Contains("literal hit 11", result);
        Assert.DoesNotContain("literal hit 12", result);
        var nextLine = result
            .Split('\n')
            .Single(line => line.StartsWith("Older literal search: recall("));
        var next = JsonNode.Parse(nextLine["Older literal search: recall(".Length..^1])!.AsObject();
        Assert.Equal(11, next["beforeSeq"]!.GetValue<int>());
        Assert.Equal("11$", next["includeRegex"]!.GetValue<string>());
        next.Remove("includeRegex");
        var older = Output(await ArchiveRecallTool.ExecuteAsync(f.Manager, f.First, next));
        Assert.Contains("literal hit 10", older);
        Assert.Contains("literal hit 9", older);
        Assert.DoesNotContain("literal hit 11", older);
    }

    [Fact]
    public async Task Effective_fork_lineage_excludes_parent_suffix_and_missing_reads_do_not_materialize_owners()
    {
        await using var f = await OutboundMcpFixture.CreateAsync();
        await ForkClearLifecycleTests.AppendAsync(
            f.First,
            VectorFixture.Message("inherited literal evidence")
        );
        var child = await f.Manager.ForkAsync(f.First, "literal-child");
        child.Registry.TriggerOverride = _ => Task.CompletedTask;
        await ForkClearLifecycleTests.AppendAsync(
            f.First,
            VectorFixture.Message("postfork forbidden evidence")
        );
        var args = Args("literal evidence");
        args["sessionId"] = child.Id;
        var inherited = Output(await ArchiveRecallTool.ExecuteAsync(f.Manager, f.First, args));
        Assert.Contains("inherited literal evidence", inherited);
        Assert.Contains("[inherited:", inherited);
        args["text_query"] = "postfork forbidden";
        Assert.Contains(
            "No literal matches",
            Output(await ArchiveRecallTool.ExecuteAsync(f.Manager, f.First, args))
        );
        var owners = f.Manager.Owners().Count();
        args["sessionId"] = "main/missing";
        var missing = await ArchiveRecallTool.ExecuteAsync(f.Manager, f.First, args);
        Assert.Contains("not found", Output(missing));
        Assert.Equal(owners, f.Manager.Owners().Count());
        Assert.Null(f.Manager.Catalog.Get("main/missing"));
    }

    [Fact]
    public async Task Existing_cold_target_is_read_without_hydrating_its_owner()
    {
        await using var f = await OutboundMcpFixture.CreateAsync();
        await ForkClearLifecycleTests.AppendAsync(
            f.Second,
            VectorFixture.Message("cold literal evidence")
        );
        var firstId = f.First.Id;
        var secondId = f.Second.Id;
        await f.Manager.ShutdownAsync();
        await f.Manager.DisposeAsync();
        var options = new Foxwarm.Models.ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        f.Manager = new SessionManager(
            f.Data,
            f.Work,
            options,
            Foxwarm.Models.HostModels.ForTest(options)
        );
        await f.Manager.LoadMainHostAsync();
        var source = await f.Manager.RequiredAsync(firstId);
        Assert.Null(f.Manager.Find(secondId));
        var owners = f.Manager.Owners().Count();
        var args = Args("literal evidence");
        args["sessionId"] = secondId;
        Assert.Contains(
            "cold literal evidence",
            Output(await ArchiveRecallTool.ExecuteAsync(f.Manager, source, args))
        );
        Assert.Equal(owners, f.Manager.Owners().Count());
        Assert.Null(f.Manager.Find(secondId));
    }

    [Theory]
    [InlineData("target", "overview")]
    [InlineData("vector_query", "semantic")]
    public async Task Literal_mode_rejects_other_modes(string key, string value)
    {
        await using var f = await OutboundMcpFixture.CreateAsync();
        var args = Args("evidence");
        args[key] = value;
        Assert.NotNull((await ArchiveRecallTool.ExecuteAsync(f.Manager, f.First, args))["error"]);
        var beforeOnly = new JsonObject { ["beforeSeq"] = 5 };
        Assert.NotNull(
            (await ArchiveRecallTool.ExecuteAsync(f.Manager, f.First, beforeOnly))["error"]
        );
    }

    [Fact]
    public async Task Literal_mode_direct_unified_and_native_script_obey_current_legacy_policy_and_target_scope()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            VectorFixture.Message("script literal evidence")
        );
        var args = Args("literal");
        var direct = await f.Call("recall", args);
        var unified = await f.Call(
            "call_tool",
            new JsonObject { ["toolId"] = "builtin:recall", ["args"] = args.DeepClone() }
        );
        Assert.Equal(Output(direct), Output(unified));
        var script = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('recall', {'text_query': 'literal', 'previewLength': 4000})",
            }
        );
        Assert.Equal(Output(direct), script["result"]!["output"]!.GetValue<string>());
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                """
                version: 1
                defaultAction: deny
                rules:
                - action: allow
                  tool: {source: builtin, name: run_script}
                - action: allow
                  tool: {source: builtin, name: recall}
                  args: {sessionId: {session: {self: true}}}
                """
            ),
            default
        );
        Assert.Contains("script literal evidence", Output(await f.Call("recall", args)));
        args["sessionId"] = "other/main";
        Assert.NotNull((await f.Call("recall", args))["error"]);
    }
}
