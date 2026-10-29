using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class WaitDeclarationTests
{
    private static SessionToolExecutor Dispatcher(ScriptFixture f)
    {
        var definitions = new JsonArray(WaitToolDefinitions.Definition());
        foreach (var item in ToolScriptToolDefinitions.Definitions().Concat(UnifiedToolDefinitions.All()))
            definitions.Add(item?.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work);
        var tools = new SessionToolExecutor(new WorkspaceTools(f.Work), f.Owner, f.Manager, registry);
        tools.BeginTurn();
        return tools;
    }

    private static async Task<JsonObject> Call(SessionToolExecutor tools, string mode, JsonObject args)
    {
        var name = mode == "direct" ? "wait" : mode == "unified" ? "call_tool" : "run_script";
        var parameters = mode == "direct" ? args.DeepClone() : mode == "unified"
            ? new JsonObject { ["toolId"] = "builtin:wait", ["args"] = args.DeepClone() }
            : new JsonObject { ["code"] = "return call_tool('builtin:wait', args)", ["args"] = args.DeepClone() };
        var response = (await tools.ExecuteAsync(new JsonObject
        {
            ["id"] = Guid.NewGuid().ToString("N"), ["name"] = name, ["args"] = parameters,
        }, default))!.AsObject();
        return mode == "script" && response["error"] is null ? response["result"]!.AsObject() : response;
    }

    private static JsonObject? State(SessionOwner owner) => owner.Entry.Snapshot().Meta["wait"] as JsonObject;

    private static JsonObject Effective(SessionOwner owner)
    {
        var wait = (JsonObject)State(owner)!.DeepClone();
        wait.Remove("id");
        wait.Remove("startedAt");
        return wait;
    }

    private static JsonObject WithEmptyLists(JsonObject args)
    {
        var result = (JsonObject)args.DeepClone();
        foreach (var key in new[] { "waitAllSessions", "waitAnySessions", "waitExecIds" })
            if (!result.ContainsKey(key))
                result[key] = new JsonArray();
        return result;
    }

    [Theory]
    [InlineData("direct")]
    [InlineData("unified")]
    [InlineData("script")]
    public async Task Empty_optional_lists_match_omission_through_real_consumers_and_persisted_wait_state(string mode)
    {
        await using var f = await ScriptFixture.Create();
        var tools = Dispatcher(f);
        var first = await f.Manager.CreateNamedAsync("main", "first", null, null);
        var second = await f.Manager.CreateNamedAsync("main", "second", null, null);
        // Real external-input exits keep the dependency waits from becoming quiescent during assertions.
        await f.Manager.DeclareWaitAsync(first, new JsonObject { ["waitForInput"] = true });
        await f.Manager.DeclareWaitAsync(second, new JsonObject { ["waitForInput"] = true });
        var sources = new[]
        {
            new JsonObject { ["waitForInput"] = true },
            new JsonObject { ["wakeIfNoActivityAfterSeconds"] = 3600 },
            new JsonObject { ["waitAnySessions"] = new JsonArray(first.Id) },
            new JsonObject { ["waitAllSessions"] = new JsonArray(first.Id, second.Id) },
        };
        foreach (var source in sources)
        {
            var omitted = await Call(tools, mode, source);
            Assert.Null(omitted["error"]);
            var expected = Effective(f.Owner);
            var supplied = await Call(tools, mode, WithEmptyLists(source));
            Assert.Null(supplied["error"]);
            Assert.True(JsonNode.DeepEquals(expected, Effective(f.Owner)));
            if (!source.ContainsKey("wakeIfNoActivityAfterSeconds"))
                Assert.Null(f.Owner.WaitSnapshot()!["timeoutSeconds"]);
            var persisted = JsonNode.Parse(await File.ReadAllTextAsync(
                Path.Combine(f.Data, "state", "sessions", f.Owner.Id + ".json")))!["meta"]!["wait"]!;
            Assert.True(JsonNode.DeepEquals(State(f.Owner), persisted));
            Assert.Equal(1, persisted["declarationVersion"]!.GetValue<int>());
            foreach (var key in new[] { "waitAnySessions", "waitExecIds" })
                Assert.False(persisted[key] is JsonArray { Count: 0 });
        }
    }

    [Theory]
    [InlineData("direct")]
    [InlineData("unified")]
    [InlineData("script")]
    public async Task Active_owned_exec_with_empty_Session_lists_persists_the_default_fallback(string mode)
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await ScriptFixture.Create();
        var started = await f.Call("run_script", new JsonObject
        {
            ["code"] = "return call_tool('exec', {'command':'sleep 3', 'timeout':1})",
        });
        Assert.True(started["error"] is null, started.ToJsonString());
        var job = started["result"]!;
        var execId = job["execId"]!.GetValue<string>();
        var result = await Call(Dispatcher(f), mode, WithEmptyLists(new JsonObject { ["waitExecIds"] = new JsonArray(execId) }));
        Assert.Null(result["error"]);
        var wait = State(f.Owner)!;
        Assert.Equal(new[] { execId }, SessionWait.Strings(wait["waitExecIds"]));
        Assert.Null(wait["waitAll"]);
        Assert.Null(wait["waitAnySessions"]);
        Assert.Equal(600, SessionWait.Number(wait["timeoutSeconds"]));
    }

    [Theory]
    [InlineData("direct")]
    [InlineData("unified")]
    [InlineData("script")]
    public async Task Queued_exec_sources_keep_fallback_semantics_and_immediately_release_the_wait(string mode)
    {
        await using var f = await ScriptFixture.Create();
        var tools = Dispatcher(f);
        const string execId = "quiet-otter";
        await f.Owner.Entry.SaveLane.AdmitAsync(new QueueItem(
            QueueItemType.Background,
            [new JsonObject { ["text"] = "owned queued completion" }],
            OpenFields: new JsonObject { ["execId"] = execId }
        ), SaveKind.Strict);
        foreach (var option in new[] { "default", "disabled", "input", "explicit" })
        {
            var args = WithEmptyLists(new JsonObject { ["waitExecIds"] = new JsonArray(execId) });
            if (option == "disabled")
                args["wakeIfNoActivityAfterSeconds"] = null;
            if (option == "input")
                args["waitForInput"] = true;
            if (option == "explicit")
                args["wakeIfNoActivityAfterSeconds"] = 3600;
            var validated = f.Manager.ValidateWait(f.Owner, args);
            Assert.Equal(new[] { execId }, SessionWait.Strings(validated["waitExecIds"]));
            if (option is "disabled" or "input")
                Assert.Null(validated["timeoutSeconds"]);
            else
                Assert.Equal(option == "default" ? 600d : 3600d, SessionWait.Number(validated["timeoutSeconds"]));
            var result = await Call(tools, mode, args);
            Assert.Null(result["error"]);
            // An already-queued completion is a real source and wakes the newly declared wait immediately.
            Assert.Null(State(f.Owner));
        }
    }

    [Theory]
    [InlineData("direct")]
    [InlineData("unified")]
    [InlineData("script")]
    public async Task Empty_placeholders_do_not_make_source_free_or_other_invalid_declarations_valid(string mode)
    {
        await using var f = await ScriptFixture.Create();
        var tools = Dispatcher(f);
        var first = await f.Manager.CreateNamedAsync("main", "first", null, null);
        var second = await f.Manager.CreateNamedAsync("main", "second", null, null);
        await f.Manager.DeclareWaitAsync(f.Owner, new JsonObject { ["waitForInput"] = true });
        var before = f.Owner.WaitSnapshot()!.DeepClone();
        var file = Path.Combine(f.Data, "state", "sessions", f.Owner.Id + ".json");
        var persisted = await File.ReadAllTextAsync(file);
        var invalid = new[]
        {
            new JsonObject(),
            new JsonObject { ["reason"] = "no source" },
            new JsonObject { ["waitExecIds"] = new JsonArray() },
            WithEmptyLists(new JsonObject()),
            WithEmptyLists(new JsonObject { ["wakeIfNoActivityAfterSeconds"] = null }),
            new JsonObject { ["waitForInput"] = true, ["waitAllSessions"] = new JsonArray(first.Id) },
            new JsonObject { ["waitForInput"] = true, ["waitAllSessions"] = new JsonArray(first.Id, first.Id) },
            new JsonObject { ["waitAllSessions"] = new JsonArray(first.Id, second.Id), ["waitAnySessions"] = new JsonArray(first.Id) },
            new JsonObject { ["waitAnySessions"] = new JsonArray(f.Owner.Id), ["waitAllSessions"] = new JsonArray() },
            new JsonObject { ["waitAnySessions"] = new JsonArray("missing-session"), ["waitExecIds"] = new JsonArray() },
            new JsonObject { ["waitExecIds"] = new JsonArray("not-an-owned-exec"), ["waitAllSessions"] = new JsonArray() },
            new JsonObject { ["waitForInput"] = true, ["waitAnySessions"] = null },
            new JsonObject { ["waitForInput"] = true, ["waitExecIds"] = new JsonArray(" ") },
            new JsonObject { ["waitForInput"] = true, ["waitAllSessions"] = new JsonArray(first.Id, 42) },
        };
        foreach (var args in invalid)
        {
            var result = await Call(tools, mode, args);
            Assert.NotNull(result["error"]);
            Assert.True(JsonNode.DeepEquals(before, f.Owner.WaitSnapshot()));
            Assert.Equal(persisted, await File.ReadAllTextAsync(file));
        }
    }

    [Fact]
    public void Schema_allows_empty_placeholders_but_excludes_a_single_target_barrier()
    {
        var properties = WaitToolDefinitions.Definition()["parameters"]!["properties"]!;
        foreach (var key in new[] { "waitAllSessions", "waitAnySessions", "waitExecIds" })
        {
            var schema = properties[key]!;
            Assert.Equal("array", schema["type"]!.GetValue<string>());
            Assert.Equal(0, schema["minItems"]!.GetValue<int>());
            Assert.True(schema["uniqueItems"]!.GetValue<bool>());
            Assert.Equal("string", schema["items"]!["type"]!.GetValue<string>());
        }
        var branches = properties["waitAllSessions"]!["anyOf"]!.AsArray();
        Assert.Equal(2, branches.Count);
        Assert.Equal(0, branches[0]!["maxItems"]!.GetValue<int>());
        Assert.Equal(2, branches[1]!["minItems"]!.GetValue<int>());
    }

    [Fact]
    public async Task Input_normalization_keeps_legacy_persisted_wait_validation_separate()
    {
        await using var f = await ScriptFixture.Create();
        var legacy = new JsonObject { ["id"] = "legacy-wait", ["startedAt"] = 1 };
        await f.Owner.Entry.SaveLane.StartWaitAsync(legacy);
        Assert.True(JsonNode.DeepEquals(legacy, State(f.Owner)));
        Assert.Null(f.Owner.WaitSnapshot());
        SessionWait.Validate(new JsonObject { ["wait"] = legacy.DeepClone() });
        foreach (var key in new[] { "waitAnySessions", "waitExecIds" })
        {
            var stored = (JsonObject)legacy.DeepClone();
            stored[key] = new JsonArray();
            Assert.Throws<InvalidDataException>(() => SessionWait.Validate(new JsonObject { ["wait"] = stored }));
        }
        var internalSingleTarget = (JsonObject)legacy.DeepClone();
        internalSingleTarget["waitAll"] = new JsonObject
        {
            ["sessions"] = new JsonArray("legacy-reporter"),
            ["satisfiedSessions"] = new JsonArray(),
            ["deferredQueue"] = new JsonArray(),
        };
        SessionWait.Validate(new JsonObject { ["wait"] = internalSingleTarget });
        Assert.Throws<InvalidDataException>(() => f.Manager.ValidateWait(f.Owner, WithEmptyLists(new JsonObject())));
    }
}
