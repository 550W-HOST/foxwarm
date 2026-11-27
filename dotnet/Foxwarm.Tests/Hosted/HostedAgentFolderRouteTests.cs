using System.Diagnostics;
using System.Reflection;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Xunit.Abstractions;
using static Foxwarm.Tests.Hosted.HostedAgentFolderTests;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// The Agent folder endpoint through the second dispatch of a script, its file metadata, and
/// what discovery and explanations report for it, against direct invocation.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class HostedAgentFolderRouteTests(ITestOutputHelper output)
{
    private static async Task<HostedCapabilityProfileTests.Fixture> FoldersAsync() =>
        await HostedCapabilityProfileTests.Fixture.Create(RuntimeCapabilities.File);

    private static async Task<SessionToolExecutor> AgentAsync(HostedCapabilityProfileTests.Fixture fixture, string agent, string rules)
    {
        await fixture.Manager.CreateAgentAsync(agent, createMainSession: false, rules: JsonNode.Parse(rules)!.AsArray());
        await SeedAsync(fixture, agent);
        var owner = await fixture.Manager.CreateNamedAsync(agent, "s", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        return fixture.Executor(owner);
    }

    private static JsonObject AgentRead(string path) =>
        new() { ["command"] = "tool call node:@agent/read --args @a", ["values"] = Values(new() { ["filePath"] = path }) };

    private static JsonObject Probe(JsonObject result)
    {
        Assert.Null(result.FailureMessage());
        var explained = SessionWait.Text(result["output"]) is { } text ? JsonNode.Parse(text)!.AsObject() : result;
        return explained["probes"]![0]!.AsObject();
    }

    // The object a script returned, wherever the result carries it.
    private static JsonObject ScriptValue(JsonObject result, string key)
    {
        Assert.Null(result.FailureMessage());
        static JsonObject? Find(JsonNode? node, string key) =>
            node switch
            {
                JsonObject map when map.ContainsKey(key) => map,
                JsonObject map => map.Select(item => Find(item.Value, key)).FirstOrDefault(found => found is not null),
                JsonValue value when SessionWait.Text(value) is { } text && text.TrimStart().StartsWith('{') => Find(JsonNode.Parse(text), key),
                _ => null,
            };
        return Find(result, key) ?? throw new Xunit.Sdk.XunitException("No script result: " + result.ToJsonString());
    }

    // Finding 1: a ctl subcall of a script keeps the endpoint on master. A Session cwd holding
    // a decoy `docs/a.md` would answer a master read of the same relative path.
    [Fact]
    public async Task A_scripted_ctl_subcall_stays_on_the_Agent_folder()
    {
        await using var folders = await FoldersAsync();
        await SeedAsync(folders, "main");
        var cwd = Path.Combine(Path.GetTempPath(), "fw-as3c-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(cwd, "docs"));
        try
        {
            await File.WriteAllTextAsync(Path.Combine(cwd, "docs", "a.md"), "decoy\n");
            await folders.Owner.UpdateCwdAsync(cwd);
            var result = await folders.Call(
                "run_script",
                new()
                {
                    ["code"] =
                        "args = {'filePath': 'docs/a.md'}\n"
                        + "nested = call_tool('ctl', {'command': 'tool call node:@agent/read --args @a', 'values': {'a': args}})\n"
                        + "direct = call_tool('node:@agent/read', args)\n"
                        + "call_tool('ctl', {'command': 'tool call node:@agent/write --args @a', 'values': {'a': {'filePath': 'docs/n.md', 'content': 'n'}}})\n"
                        + "return {'nested': nested, 'direct': direct}\n",
                }
            );
            output.WriteLine(result.ToJsonString());
            var value = ScriptValue(result, "nested");
            Assert.Equal(value["direct"]!.ToJsonString(), value["nested"]!.ToJsonString());
            Assert.Contains("a\\n", value["nested"]!.ToJsonString());
            Assert.DoesNotContain("decoy", value["nested"]!.ToJsonString());
            Assert.True(File.Exists(Path.Combine(folders.Manager.AgentDirectory("main"), "docs", "n.md")));
            Assert.False(File.Exists(Path.Combine(cwd, "docs", "n.md")));
        }
        finally
        {
            Directory.Delete(cwd, true);
        }
    }

    // Counts the calls that compute a generation or read a whole file.
    public class CountingFiles : DispatchProxy
    {
        internal IAgentFileStore Inner = null!;
        internal int Stats;
        internal int WholeReads;

        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            if (method!.Name == "Stat")
                Stats++;
            if (method.Name is "ReadAsync" or "ReadBoundedAsync")
                WholeReads++;
            return method.Invoke(Inner, args);
        }
    }

    // Finding 2: reads and listings take kind, length and time; no generation, so no content
    // is read to answer them.
    [Fact]
    public async Task Reads_and_listings_compute_no_generation()
    {
        foreach (var hosted in new[] { false, true })
        {
            await using var store = hosted ? await HostedAgentStoreTests.StoreFixture.Create(store: true) : null;
            await using var folders = hosted ? null : await FoldersAsync();
            var fixture = store?.Inner ?? folders!;
            await SeedAsync(fixture, "main");
            var proxy = DispatchProxy.Create<IAgentFileStore, CountingFiles>();
            var counting = (CountingFiles)(object)proxy;
            counting.Inner = fixture.Manager.FolderFiles;
            fixture.Manager.FolderFiles = proxy;
            foreach (var path in new[] { "docs/a.md", "docs" })
                Assert.Null((await fixture.Call("ctl", AgentRead(path))).FailureMessage());
            Assert.Equal(0, counting.Stats);
            Assert.Equal(0, counting.WholeReads);
        }
    }

    // Finding 2: an object that isn't a regular file is never opened by the endpoint; a read
    // reports it as master's read does.
    [Fact]
    public async Task A_named_pipe_is_not_a_regular_file_and_is_never_opened()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var folders = await FoldersAsync();
        await SeedAsync(folders, "main");
        var pipe = Path.Combine(folders.Manager.AgentDirectory("main"), "docs", "pipe");
        using (var mkfifo = Process.Start("mkfifo", pipe))
            await mkfifo.WaitForExitAsync();
        var endpoint = Task.Run(() => folders.Call("ctl", AgentRead("docs/pipe")));
        var finished = await Task.WhenAny(endpoint, Task.Delay(TimeSpan.FromSeconds(20)));
        if (finished != endpoint)
        {
            // Releases the reader that opened it.
            await using (new FileStream(pipe, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) { }
            Assert.Fail("the endpoint opened the pipe");
        }
        var master = await folders.Call("read", new() { ["filePath"] = "$fw_agentdir/docs/pipe" });
        output.WriteLine((await endpoint).ToJsonString() + "\n" + master.ToJsonString());
        Assert.NotNull(master.FailureMessage());
        Assert.Equal(master.FailureMessage(), (await endpoint).FailureMessage());
    }

    // Finding 2: a link in a listed directory is listed as a link, as master lists it; opening
    // it is still refused.
    [Fact]
    public async Task A_listing_shows_a_link_as_a_link_without_following_it()
    {
        await using var folders = await FoldersAsync();
        await SeedAsync(folders, "main");
        var docs = Path.Combine(folders.Manager.AgentDirectory("main"), "docs");
        var outside = Path.Combine(Path.GetTempPath(), "fw-as3c-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outside);
        try
        {
            File.CreateSymbolicLink(Path.Combine(docs, "linked-dir"), outside);
            File.CreateSymbolicLink(Path.Combine(docs, "linked-file"), Path.Combine(docs, "a.md"));
            var endpoint = await folders.Call("ctl", AgentRead("docs"));
            var master = await folders.Call("read", new() { ["filePath"] = "$fw_agentdir/docs" });
            output.WriteLine(endpoint.ToJsonString() + "\n" + master.ToJsonString());
            Assert.Null(endpoint.FailureMessage());
            static string Listing(JsonObject result) =>
                System.Text.RegularExpressions.Regex.Replace(SessionWait.Text(result["output"])!, "Directory listing for `[^`]*`", "");
            Assert.Equal(Listing(master), Listing(endpoint));
            Assert.Contains("`linked-dir` (symlink)", SessionWait.Text(endpoint["output"]));
            Assert.Contains("`linked-file` (symlink)", SessionWait.Text(endpoint["output"]));
            Assert.NotNull((await folders.Call("ctl", AgentRead("docs/linked-dir"))).FailureMessage());
            Assert.NotNull((await folders.Call("ctl", AgentRead("docs/linked-file"))).FailureMessage());
        }
        finally
        {
            Directory.Delete(outside, true);
        }
    }

    // Grows the file past the policy limit right after its kind is read, so a capture that
    // checks a stat and then reads sees the larger version.
    public class GrowingFiles : DispatchProxy
    {
        internal IAgentFileStore Inner = null!;
        internal byte[] Next = [];
        internal readonly List<string> Calls = [];

        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            Calls.Add(method!.Name);
            var result = method.Invoke(Inner, args);
            if (method.Name is "Kind" or "Stat")
                Inner.WriteAsync((string?)args![0], (string)args[1]!, Next, null, default).GetAwaiter().GetResult();
            return result;
        }
    }

    // Finding 3: the policy limit bounds the version that is read, before its body is
    // materialized.
    [Fact]
    public async Task A_candidate_over_the_limit_is_never_materialized()
    {
        foreach (var hosted in new[] { false, true })
        {
            await using var store = hosted ? await HostedAgentStoreTests.StoreFixture.Create(store: true) : null;
            await using var folders = hosted ? null : await FoldersAsync();
            var fixture = store?.Inner ?? folders!;
            var files = fixture.Manager.FolderFiles;
            var small = "version: 1\ndefaultAction: allow\nrules: []\n"u8.ToArray();
            var large = Enumerable.Repeat((byte)'#', (int)ToolAuthorizationPolicy.MaxBytes + 1).ToArray();
            await files.WriteAsync("main", "rules.yaml", small, null, default);
            // Each store bounds its own read.
            await files.WriteAsync("main", "large.yaml", large, null, default);
            Assert.Null(await files.ReadBoundedAsync("main", "large.yaml", large.Length - 1, default));
            Assert.Equal(large.Length, (await files.ReadBoundedAsync("main", "large.yaml", large.Length, default))!.Bytes.Length);
            var growing = DispatchProxy.Create<IAgentFileStore, GrowingFiles>();
            var spy = (GrowingFiles)(object)growing;
            spy.Inner = files;
            spy.Next = large;
            fixture.Manager.FolderFiles = growing;
            var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
                fixture.Manager.AgentFolderWorkspace(fixture.Owner).CaptureConfigCandidateAsync("$fw_agentdir/rules.yaml", true, default)
            );
            output.WriteLine(string.Join(", ", spy.Calls));
            Assert.Equal("Configuration candidate exceeds its byte limit.", error.Message);
            Assert.DoesNotContain("ReadAsync", spy.Calls);
            Assert.Contains("ReadBoundedAsync", spy.Calls);
        }
    }

    // Finding 4: in a layer with operation rules, a whole-call winner is re-evaluated as a
    // whole-call rule; it is marked only when the alias made it match.
    [Theory]
    [InlineData("""[{"id":"x","op":"env.exec","action":"deny"},{"id":"r","tool":{"source":"node","name":"read"},"path":{"allWithin":"${agent.dir}/docs"},"action":"deny"}]""", false)]
    [InlineData("""[{"id":"x","op":"env.exec","action":"deny"},{"id":"r","tool":{"source":"node","name":"read"},"node":"mast*","path":{"allWithin":"${agent.dir}/docs"},"action":"deny"}]""", true)]
    public async Task A_whole_call_winner_among_operation_rules_is_marked_by_its_own_match(string rules, bool alias)
    {
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        var tools = await AgentAsync(store.Inner, "mixed", rules);
        var probe = Probe(
            await store.Inner.Call(
                "explain_tool_authorization",
                new()
                {
                    ["probes"] = new JsonArray(
                        new JsonObject { ["sessionId"] = "mixed/s", ["toolId"] = "node:@agent/read", ["args"] = new JsonObject { ["filePath"] = "docs/a.md" } }
                    ),
                },
                tools
            )
        );
        output.WriteLine(probe.ToJsonString());
        var layer = probe["active"]!["layers"]![1]!.AsObject();
        Assert.Equal("deny", SessionWait.Text(layer["decision"]));
        var operations = layer["operations"]!.AsArray();
        Assert.Contains(operations, item => SessionWait.Text(item!["rule"]?["id"]) == "r");
        Assert.Equal(alias, operations.Any(item => item!["masterAlias"] is not null));
    }

    // Finding 4: an undecidable match is the same without the alias, and isn't marked.
    [Fact]
    public void An_unchanged_undecidable_match_is_not_marked()
    {
        var rule = JsonNode.Parse("""{"id":"u","op":["env.read"],"match":{},"resources":{"node":{"exact":"master"}},"action":"deny"}""")!.AsObject();
        var operation = new AuthorizationOperation("env.read", new JsonObject { ["node"] = "@agent" }, new JsonObject()) { Underivable = "test" };
        var request = new ToolAuthorizationRequest("node", "read", null, new(), [], "a", "a/s", "@agent", ".", ".", ".");
        Assert.Equal(OperationMatch.Unknown, OperationRules.Match(rule, operation, request, restrictive: true));
        Assert.False(ToolAuthorizationExplain.OperationThroughMasterAlias(rule, operation, request));
    }

    // Finding 5: discovery decides an endpoint tool as dispatch does. On master the folder is
    // master's, so an `exact: @agent` denial decides neither; without master it decides both.
    [Fact]
    public async Task Discovery_sees_the_endpoint_as_dispatch_does()
    {
        const string rules = """[{"id":"no-endpoint","node":{"exact":"@agent"},"action":"deny"}]""";
        foreach (var hosted in new[] { false, true })
        {
            await using var store = hosted ? await HostedAgentStoreTests.StoreFixture.Create(store: true) : null;
            await using var folders = hosted ? null : await FoldersAsync();
            var fixture = store?.Inner ?? folders!;
            var tools = await AgentAsync(fixture, "discovered", rules);
            var call = await fixture.Call("ctl", AgentRead("docs/a.md"), tools);
            var search = await fixture.Call("ctl", new() { ["command"] = "tool search --node-id @@agent --source node --limit 20" }, tools);
            output.WriteLine(call.ToJsonString() + "\n" + search.ToJsonString());
            var dispatched = call.FailureCode() != "tool_authorization_denied";
            var listed = SessionWait.Text(search["output"])?.Contains("--name read --node-id @@agent") == true;
            Assert.Equal(!hosted, dispatched);
            Assert.Equal(dispatched, listed);
        }
    }

    // Finding 6: an explanation reports the refusal dispatch gives before policy.
    [Fact]
    public async Task An_explanation_reports_an_unavailable_call_as_dispatch_refuses_it()
    {
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        var tools = await AgentAsync(store.Inner, "unavailable", "[]");
        var cases = new (JsonObject Probe, string Name, JsonObject Args)[]
        {
            (new() { ["source"] = "node", ["name"] = "exec", ["args"] = new JsonObject { ["command"] = "true" } }, "exec", new() { ["command"] = "true" }),
            (
                new() { ["toolId"] = "builtin:add_secret", ["args"] = new JsonObject { ["name"] = "k", ["fromConfig"] = "a.b" } },
                "add_secret",
                new() { ["name"] = "k", ["fromConfig"] = "a.b" }
            ),
        };
        foreach (var (probe, name, args) in cases)
        {
            var dispatched = await store.Inner.Call(name, args, tools);
            probe["sessionId"] = "unavailable/s";
            var explained = Probe(await store.Inner.Call("explain_tool_authorization", new() { ["probes"] = new JsonArray(probe) }, tools));
            output.WriteLine(dispatched.ToJsonString() + "\n" + explained.ToJsonString());
            Assert.NotNull(dispatched.FailureMessage());
            Assert.Null(explained["active"]);
            Assert.Contains(SessionWait.Text(explained["error"])!, dispatched.FailureMessage());
        }
    }

    // Finding 7: a scripted directory read of the endpoint is the standard listing, in both
    // profiles.
    [Fact]
    public async Task A_scripted_folder_listing_is_the_standard_listing()
    {
        foreach (var hosted in new[] { false, true })
        {
            await using var store = hosted ? await HostedAgentStoreTests.StoreFixture.Create(store: true) : null;
            await using var folders = hosted ? null : await FoldersAsync();
            var fixture = store?.Inner ?? folders!;
            await SeedAsync(fixture, "main");
            var result = await fixture.Call(
                "run_script",
                new() { ["code"] = "listing = call_tool('node:@agent/read', {'filePath': 'docs'})\nreturn {'text': isinstance(listing, str), 'listing': listing}\n" }
            );
            output.WriteLine(result.ToJsonString());
            var value = ScriptValue(result, "text");
            Assert.True(value["text"]!.GetValue<bool>());
            Assert.Contains("a.md", SessionWait.Text(value["listing"]));
        }
    }
}
