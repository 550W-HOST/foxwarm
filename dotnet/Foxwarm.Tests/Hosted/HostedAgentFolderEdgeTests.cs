using System.Reflection;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Storage;
using Foxwarm.Tools;
using Xunit.Abstractions;
using static Foxwarm.Tests.Hosted.HostedAgentFolderTests;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// Edges of the Agent folder endpoint: how policy sees it next to master, confinement at the
/// folder's file owner, and the endpoint's place among the other file tools.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class HostedAgentFolderEdgeTests(ITestOutputHelper output)
{
    private static async Task<HostedCapabilityProfileTests.Fixture> FoldersAsync() =>
        await HostedCapabilityProfileTests.Fixture.Create(RuntimeCapabilities.File);

    // A Session of a new Agent with the given rules, its folder seeded.
    private static async Task<SessionToolExecutor> AgentAsync(
        HostedCapabilityProfileTests.Fixture fixture,
        string agent,
        string rules,
        string? node = null
    )
    {
        await fixture.Manager.CreateAgentAsync(agent, createMainSession: false, rules: JsonNode.Parse(rules)!.AsArray());
        await SeedAsync(fixture, agent);
        var owner = await fixture.Manager.CreateNamedAsync(agent, "s", null, null, initialNode: node);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        return fixture.Executor(owner);
    }

    private static JsonObject AgentRead(string path) =>
        new() { ["command"] = "tool call node:@agent/read --args @a", ["values"] = Values(new() { ["filePath"] = path }) };

    private static JsonObject AgentWrite(string path, string content) =>
        new()
        {
            ["command"] = "tool call node:@agent/write --args @a",
            ["values"] = Values(new() { ["filePath"] = path, ["content"] = content, ["createDirs"] = true }),
        };

    private async Task<string> DecideAsync(HostedCapabilityProfileTests.Fixture fixture, SessionToolExecutor tools, string name, JsonObject args)
    {
        var result = await fixture.Call(name, args, tools);
        var decision = Decision(result, fixture.Manager);
        output.WriteLine($"{(fixture.Manager.AgentStore is null ? "file" : "hosted")} {name} {args.ToJsonString()}\n  {decision}");
        return decision;
    }

    // Finding 1: a bare Node pattern sees master's identity for the endpoint, never its name.
    // `*agent` matches no Node that master is or descends from, so the later master denial wins,
    // as it does for the same file on master.
    [Theory]
    [InlineData("""[{"id":"glob","node":"*agent","action":"allow"},{"id":"no-master","node":{"exact":"master"},"action":"deny"}]""")]
    [InlineData("""[{"id":"glob","op":"env.read","node":"*agent","action":"allow"},{"id":"no-master","op":"env.read","node":{"exact":"master"},"action":"deny"}]""")]
    public async Task A_legacy_Node_glob_never_matches_the_endpoint_by_its_name(string rules)
    {
        foreach (var hosted in new[] { false, true })
        {
            await using var store = hosted ? await HostedAgentStoreTests.StoreFixture.Create(store: true) : null;
            await using var folders = hosted ? null : await FoldersAsync();
            var fixture = store?.Inner ?? folders!;
            var tools = await AgentAsync(fixture, "globbed", rules);
            Assert.Equal("DENIED no-master", await DecideAsync(fixture, tools, "ctl", AgentRead("docs/a.md")));
        }
    }

    // Finding 2: the endpoint is confined at the folder's file owner, links included, for reads,
    // writes, created children and both copy legs. An ordinary master path is unchanged.
    [Fact]
    public async Task The_endpoint_does_not_follow_a_link_out_of_the_Agent_folder()
    {
        await using var folders = await FoldersAsync();
        var tools = await AgentAsync(folders, "linked", "[]");
        var main = folders.Manager.AgentDirectory("main");
        await File.WriteAllTextAsync(Path.Combine(main, "secret.md"), "secret\n");
        var root = folders.Manager.AgentDirectory("linked");
        File.CreateSymbolicLink(Path.Combine(root, "docs", "out"), main);
        var before = Directory.GetFileSystemEntries(main).Order().ToArray();
        var calls = new (string Name, JsonObject Args)[]
        {
            ("ctl", AgentRead("docs/out/secret.md")),
            ("ctl", AgentRead("docs/out")),
            ("ctl", AgentWrite("docs/out/new.md", "n")),
            ("ctl", AgentWrite("docs/out/sub/new.md", "n")),
            (
                "ctl",
                new()
                {
                    ["command"] = "tool call node:@agent/edit --args @a",
                    ["values"] = Values(new() { ["apply_patch"] = "*** Begin Patch\n*** Add File: docs/out/patched.md\n+p\n*** End Patch" }),
                }
            ),
            ("copy_between_nodes", new() { ["sourceNode"] = "@agent", ["sourcePath"] = "docs/out/secret.md", ["targetNode"] = "@agent", ["targetPath"] = "docs/copy.md" }),
            ("copy_between_nodes", new() { ["sourceNode"] = "@agent", ["sourcePath"] = "docs/a.md", ["targetNode"] = "@agent", ["targetPath"] = "docs/out/copied.md" }),
            ("ctl", AgentRead("docs\\..\\..\\main\\secret.md")),
        };
        foreach (var (name, args) in calls)
        {
            var result = await folders.Call(name, (JsonObject)args.DeepClone(), tools);
            output.WriteLine($"{name} {args.ToJsonString()}\n  {result.ToJsonString()}");
            Assert.NotNull(result.FailureMessage());
            Assert.DoesNotContain("secret\\n", result.ToJsonString());
        }
        Assert.Equal(before, Directory.GetFileSystemEntries(main).Order().ToArray());
        Assert.False(File.Exists(Path.Combine(root, "docs", "copy.md")));
        // The same file by its master path is an ordinary master read.
        var direct = await folders.Call("read", new() { ["filePath"] = "$fw_agentdir/docs/out/secret.md" }, tools);
        Assert.Contains("secret", SessionWait.Text(direct["output"]));
    }

    // Finding 3: on master, policy sees an explicit `@agent` copy argument as master, and other
    // copy arguments as they are given.
    [Fact]
    public async Task On_master_a_copy_endpoint_argument_is_master_to_policy()
    {
        await using var folders = await FoldersAsync();
        var elsewhere = Path.Combine(folders.Work, "elsewhere.md");
        JsonObject Copy(string sourceNode, string sourcePath, string targetNode, string targetPath) =>
            new() { ["sourceNode"] = sourceNode, ["sourcePath"] = sourcePath, ["targetNode"] = targetNode, ["targetPath"] = targetPath };
        var agentArg = await AgentAsync(
            folders,
            "agentarg",
            """[{"id":"agent-arg","tool":{"source":"builtin","name":"copy_between_nodes"},"args":{"sourceNode":"@agent"},"action":"deny"}]"""
        );
        Assert.Equal("OK", await DecideAsync(folders, agentArg, "copy_between_nodes", Copy("@agent", "docs/a.md", "master", elsewhere)));
        var masterArg = await AgentAsync(
            folders,
            "masterarg",
            """[{"id":"master-target","tool":{"source":"builtin","name":"copy_between_nodes"},"args":{"targetNode":"master"},"action":"deny"}]"""
        );
        var physical = Path.Combine(folders.Manager.AgentDirectory("masterarg"), "docs", "a.md");
        Assert.Equal("DENIED master-target", await DecideAsync(folders, masterArg, "copy_between_nodes", Copy("master", physical, "@agent", "docs/b.md")));
        Assert.Equal("DENIED master-target", await DecideAsync(folders, masterArg, "copy_between_nodes", Copy("@agent", "docs/a.md", "master", elsewhere)));
        Assert.Equal("DENIED master-target", await DecideAsync(folders, masterArg, "copy_between_nodes", Copy("@agent", "docs/a.md", "@agent", "docs/c.md")));
        // An ordinary argument keeps its spelling: ` master ` isn't `master`.
        Assert.Equal("OK", await DecideAsync(folders, masterArg, "copy_between_nodes", Copy("master", physical, " master ", elsewhere + ".2")));
    }

    // Finding 4: `current` never names the endpoint, which is no Session's Node.
    [Fact]
    public async Task The_endpoint_is_never_a_Session_s_current_Node()
    {
        foreach (var hosted in new[] { false, true })
        {
            await using var store = hosted ? await HostedAgentStoreTests.StoreFixture.Create(store: true) : null;
            await using var folders = hosted ? null : await FoldersAsync();
            var fixture = store?.Inner ?? folders!;
            var error = await Assert.ThrowsAsync<InvalidDataException>(() => fixture.Manager.CreateNamedAsync("main", "placed", null, null, initialNode: "@agent"));
            Assert.Equal("`@agent` names this Agent's folder, not a Node, so a Session can't be placed there.", error.Message);
            var created = await fixture.Call("create_session", new() { ["agentName"] = "main", ["sessionName"] = "placed", ["node"] = "@agent" });
            Assert.Equal(error.Message, created.FailureMessage());
        }
        var request = new ToolAuthorizationRequest(
            "node",
            "read",
            null,
            new JsonObject(),
            [],
            "main",
            "main/s",
            "@agent",
            "/",
            null,
            null,
            CurrentNode: "@agent"
        );
        Assert.False(ToolAuthorizationEvaluation.NodeMatches(JsonNode.Parse("""{"current":true}""")!, "@agent", request));
    }

    // Finding 5: skill copy and send_file don't take the endpoint.
    [Fact]
    public async Task Skill_copy_and_send_file_refuse_the_endpoint()
    {
        foreach (var hosted in new[] { false, true })
        {
            await using var store = hosted ? await HostedAgentStoreTests.StoreFixture.Create(store: true) : null;
            await using var folders = hosted ? null : await FoldersAsync();
            var fixture = store?.Inner ?? folders!;
            await SeedAsync(fixture, "main");
            var skill = await fixture.Call(
                "skill",
                new() { ["action"] = "copy", ["skillName"] = "about-foxwarm", ["targetPath"] = "copied", ["node"] = "@agent" }
            );
            Assert.Equal("Invalid Node identity.", skill.FailureMessage());
            var sent = await fixture.Call("send_file", new() { ["filePath"] = "docs/a.md", ["node"] = "@agent" });
            Assert.Equal("Invalid Node identity.", sent.FailureMessage());
        }
    }

    // Finding 6: clearing the selection is a selection of what an unset Node is, master in file
    // mode and no Node otherwise, in every projection of policy.
    [Fact]
    public async Task Clearing_the_selection_is_decided_as_master_or_as_no_Node()
    {
        var layers = new (string Name, string Rules, string File, string Hosted)[]
        {
            ("selectarg", """[{"id":"no-master-select","tool":{"source":"builtin","name":"node"},"args":{"nodeId":"master"},"action":"deny"}]""", "DENIED no-master-select", "OK"),
            ("selecttarget", """[{"id":"master-target","match":{"tool":{"source":"builtin","name":"node"},"targetNode":"master"},"action":"deny"}]""", "DENIED master-target", "OK"),
            ("selectop", """[{"id":"op-master","op":"node.select","node":{"exact":"master"},"action":"deny"}]""", "DENIED op-master", "OK"),
            ("unrelated", """[{"id":"no-exec","op":"env.exec","action":"deny"}]""", "OK", "OK"),
        };
        foreach (var hosted in new[] { false, true })
        {
            await using var store = hosted ? await HostedAgentStoreTests.StoreFixture.Create(store: true) : null;
            await using var folders = hosted ? null : await FoldersAsync();
            var fixture = store?.Inner ?? folders!;
            foreach (var (name, rules, file, expected) in layers)
            {
                var tools = await AgentAsync(fixture, name, rules, node: "elsewhere");
                var owner = fixture.Manager.Find(name + "/s")!;
                Assert.Equal("elsewhere", fixture.Manager.CurrentNode(owner));
                Assert.Equal(hosted ? expected : file, await DecideAsync(fixture, tools, "node", new() { ["action"] = "select", ["none"] = true }));
                if ((hosted ? expected : file) == "OK")
                    Assert.Equal("master", fixture.Manager.CurrentNode(owner));
            }
        }
    }

    // The empty path names the folder's root, as `.` does.
    [Fact]
    public async Task The_empty_path_and_dot_get_the_same_decision()
    {
        foreach (var hosted in new[] { false, true })
        {
            await using var store = hosted ? await HostedAgentStoreTests.StoreFixture.Create(store: true) : null;
            await using var folders = hosted ? null : await FoldersAsync();
            var fixture = store?.Inner ?? folders!;
            var tools = await AgentAsync(
                fixture,
                "rooted",
                """[{"id":"no-root","tool":{"source":"node","name":"read"},"path":{"allWithin":"${agent.dir}"},"action":"deny"}]"""
            );
            Assert.Equal("DENIED no-root", await DecideAsync(fixture, tools, "ctl", AgentRead(".")));
            Assert.Equal("DENIED no-root", await DecideAsync(fixture, tools, "ctl", AgentRead("")));
        }
    }

    private static JsonObject ExplainArgs(string session, JsonObject probe, string? candidate = null)
    {
        probe["sessionId"] = session;
        var args = new JsonObject { ["probes"] = new JsonArray(probe) };
        if (candidate is not null)
            args["policyFilePath"] = candidate;
        return args;
    }

    private static JsonObject Explained(JsonObject result)
    {
        Assert.Null(result.FailureMessage());
        var explained = SessionWait.Text(result["output"]) is { } text ? JsonNode.Parse(text)!.AsObject() : result;
        return explained["probes"]![0]!.AsObject();
    }

    // Finding 7: an explanation routes a call as dispatch does: an implicit folder read and a
    // configuration candidate of a Session without a Node are the folder's.
    [Fact]
    public async Task An_explanation_routes_an_implicit_folder_call_as_dispatch_does()
    {
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        var tools = await AgentAsync(
            store.Inner,
            "routed",
            """[{"id":"no-docs","tool":{"source":"node","name":"read"},"path":{"allWithin":"${agent.dir}/docs"},"action":"deny"}]"""
        );
        var read = new JsonObject { ["filePath"] = "$fw_agentdir/docs/a.md" };
        Assert.Equal("DENIED no-docs", await DecideAsync(store.Inner, tools, "read", (JsonObject)read.DeepClone()));
        var probe = Explained(
            await store.Inner.Call("explain_tool_authorization", ExplainArgs("routed/s", new() { ["source"] = "node", ["name"] = "read", ["args"] = read }), tools)
        );
        output.WriteLine(probe.ToJsonString());
        Assert.Equal("deny", SessionWait.Text(probe["active"]!["decision"]));
        Assert.Equal("no-docs", SessionWait.Text(probe["active"]!["layers"]![1]!["rule"]!["id"]));
        Assert.Equal("@agent", SessionWait.Text(probe["active"]!["facts"]!["paths"]![0]!["node"]));
        var candidate = Explained(
            await store.Inner.Call(
                "explain_tool_authorization",
                ExplainArgs("routed/s", new() { ["toolId"] = "builtin:set_config", ["args"] = new JsonObject { ["target"] = "tool-rules", ["filePath"] = "$fw_agentdir/rules.yaml" } }),
                tools
            )
        );
        output.WriteLine(candidate.ToJsonString());
        var fact = candidate["active"]!["facts"]!["paths"]![0]!;
        Assert.Equal("@agent", SessionWait.Text(fact["node"]));
        Assert.Equal("routed/rules.yaml", SessionWait.Text(fact["resolved"]));
    }

    private static async Task<JsonObject> PendingApprovalAsync(SessionOwner owner)
    {
        for (var attempt = 0; attempt < 400; attempt++)
        {
            var pending = owner.Entry.WithState(state => SessionApprovals.Pending(state.Meta).FirstOrDefault()?.DeepClone() as JsonObject);
            if (pending is not null)
                return pending;
            await Task.Delay(25);
        }
        throw new TimeoutException("No pending approval appeared.");
    }

    // Finding 7: a staged approval checks each read with its own resource's files: the active
    // policy's read and the candidate's read ask separately, and each approved call runs.
    [Theory]
    [InlineData("""[{"id":"ask-policy","tool":{"source":"node","name":"read"},"path":{"anyNotWithin":"${agent.dir}"},"action":"ask"}]""", "policy-read")]
    [InlineData("""[{"id":"ask-candidate","tool":{"source":"node","name":"read"},"path":{"allWithin":"${agent.dir}"},"action":"ask"}]""", "candidate-read")]
    public async Task An_asking_policy_read_and_an_asking_candidate_read_are_each_approved(string rules, string check)
    {
        // On master; without master over files; without master over documents that, as in the
        // database, have a locator and no file.
        foreach (var (hosted, located) in new[] { (false, false), (true, false), (true, true) })
        {
            await using var store = hosted
                ? await HostedAgentStoreTests.StoreFixture.Create(store: true, configuration: located ? Located : null)
                : null;
            await using var folders = hosted ? null : await FoldersAsync();
            var fixture = store?.Inner ?? folders!;
            var tools = await AgentAsync(fixture, "asking", rules);
            var owner = fixture.Manager.Find("asking/s")!;
            Assert.Null(
                (await fixture.Call("ctl", AgentWrite("rules.yaml", "version: 1\ndefaultAction: allow\nrules: []\n"), tools)).FailureMessage()
            );
            var call = fixture.Call(
                "explain_tool_authorization",
                ExplainArgs("asking/s", new() { ["toolId"] = "builtin:list_agents", ["args"] = new JsonObject() }, "$fw_agentdir/rules.yaml"),
                tools
            );
            var pending = await PendingApprovalAsync(owner);
            output.WriteLine(pending.ToJsonString());
            Assert.Contains(pending["checks"]!.AsArray(), item => SessionWait.Text(item!["id"]) == check);
            await fixture.Manager.DecideToolApprovalAsync(owner, pending["id"]!.GetValue<string>(), true, null, new JsonObject { ["kind"] = "administrator" });
            var result = await call.WaitAsync(TimeSpan.FromSeconds(30));
            output.WriteLine(result.ToJsonString());
            Assert.Null(result.FailureMessage());
        }
    }

    // Configuration documents with a locator and no file, as a database's are.
    private sealed class LocatedDocuments(IConfigDocumentStore inner) : IConfigDocumentStore
    {
        public string Locator(ConfigDocumentName name) => "config_documents/" + name;

        public string? PhysicalPath(ConfigDocumentName name) => null;

        public bool DirectEdits => false;

        public bool Exists(ConfigDocumentName name) => inner.Exists(name);

        public byte[]? Read(ConfigDocumentName name) => inner.Read(name);

        public byte[]? ReadBounded(ConfigDocumentName name, int maxBytes) => inner.ReadBounded(name, maxBytes);

        public Task ReplaceAsync(ConfigDocumentName name, byte[] bytes, CancellationToken token, Action<AtomicJsonWriteStage>? stage = null) =>
            inner.ReplaceAsync(name, bytes, token, stage);

        public Task<bool> TryCreateAsync(ConfigDocumentName name, byte[] bytes, CancellationToken token) =>
            inner.TryCreateAsync(name, bytes, token);
    }

    private static ModelConfiguration Located(HostPaths paths) =>
        new(
            paths,
            new ConfigurationSources(
                new LocatedDocuments(new FileConfigDocuments(paths)),
                // No deployment layer: the documents hold file mode's settings.
                null!,
                hostPaths => new Foxwarm.Secrets.InstanceSecrets(hostPaths.DataRoot),
                new FileInstanceCredentials(paths.DataRoot)
            )
        );

    // Replaces the file with a second version after each read, so a capture assembled from
    // several reads mixes versions.
    public class TearingFiles : DispatchProxy
    {
        internal IAgentFileStore Inner = null!;
        internal byte[] Next = [];

        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            var result = method!.Invoke(Inner, args);
            if (method.Name is "ReadAsync" or "ReadRangeAsync" && result is Task task)
            {
                task.GetAwaiter().GetResult();
                Inner.WriteAsync((string?)args![0], (string)args[1]!, Next, null, default).GetAwaiter().GetResult();
            }
            return result;
        }
    }

    // Finding 8: a candidate is one stored version of its file.
    [Fact]
    public async Task A_candidate_is_captured_from_one_version_of_its_file()
    {
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        var size = 3 * 1024 * 1024 / 2;
        var first = Enumerable.Repeat((byte)'a', size).ToArray();
        var second = Enumerable.Repeat((byte)'b', size).ToArray();
        await store.Store.WriteAsync("main", "config.yaml", first, null, default);
        var tearing = DispatchProxy.Create<IAgentFileStore, TearingFiles>();
        ((TearingFiles)(object)tearing).Inner = store.Manager.FolderFiles;
        ((TearingFiles)(object)tearing).Next = second;
        store.Manager.FolderFiles = tearing;
        var captured = await store.Manager.AgentFolderWorkspace(store.Inner.Owner).CaptureConfigCandidateAsync("$fw_agentdir/config.yaml", false, default);
        Assert.True(captured.SequenceEqual(first) || captured.SequenceEqual(second), "the capture mixes versions");
    }

    // Finding 9: `masterAlias` marks a match that needed the alias, by evaluation.
    [Theory]
    // Narrow enough to leave the explanation's own policy read alone.
    [InlineData("""[{"id":"r","op":"env.read","node":{"exact":"master"},"path":{"within":"${agent.dir}/docs"},"action":"deny"}]""", true)]
    [InlineData("""[{"id":"r","tool":{"source":"node","name":"read"},"node":"mast*","path":{"allWithin":"${agent.dir}/docs"},"action":"deny"}]""", true)]
    [InlineData("""[{"id":"r","tool":{"source":"node","name":"read"},"node":{"exact":["master","@agent"]},"path":{"allWithin":"${agent.dir}/docs"},"action":"deny"}]""", false)]
    public async Task The_master_alias_is_marked_from_the_match_that_won(string rules, bool alias)
    {
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        var tools = await AgentAsync(store.Inner, "aliased", rules);
        var probe = Explained(
            await store.Inner.Call(
                "explain_tool_authorization",
                ExplainArgs("aliased/s", new() { ["toolId"] = "node:@agent/read", ["args"] = new JsonObject { ["filePath"] = "docs/a.md" } }),
                tools
            )
        );
        output.WriteLine(probe.ToJsonString());
        var layer = probe["active"]!["layers"]![1]!.AsObject();
        Assert.Equal("deny", SessionWait.Text(layer["decision"]));
        var marked = layer["masterAlias"] is not null
            || layer["operations"]?.AsArray().Any(item => item!["masterAlias"] is not null) == true;
        Assert.Equal(alias, marked);
    }

    // Finding 10: a script's folder read is the standard read: structured fields and receipt.
    [Fact]
    public async Task A_scripted_folder_read_matches_the_standard_read()
    {
        await using var folders = await FoldersAsync();
        await SeedAsync(folders, "main");
        var result = await folders.Call(
            "run_script",
            new()
            {
                ["code"] =
                    "a = call_tool('node:@agent/read', {'filePath': 'docs/a.md'})\nb = call_tool('read', {'filePath': '$fw_agentdir/docs/a.md'})\nreturn {'a': a, 'b': b}\n",
            }
        );
        output.WriteLine(result.ToJsonString());
        Assert.Null(result.FailureMessage());
        static JsonObject? Pair(JsonNode? node) =>
            node switch
            {
                JsonObject map when map["a"] is JsonObject && map["b"] is JsonObject => map,
                JsonObject map => map.Select(item => Pair(item.Value)).FirstOrDefault(found => found is not null),
                JsonValue value when SessionWait.Text(value) is { } text && text.TrimStart().StartsWith('{') => Pair(JsonNode.Parse(text)),
                _ => null,
            };
        var found = Pair(result) ?? throw new Xunit.Sdk.XunitException("No script result: " + result.ToJsonString());
        var a = found["a"]!.AsObject();
        var b = found["b"]!.AsObject();
        Assert.Equal(b.Select(pair => pair.Key).Order(), a.Select(pair => pair.Key).Order());
        Assert.Equal(b["content"]?.ToJsonString(), a["content"]?.ToJsonString());
        var receipts = new List<JsonArray>();
        var files = folders.Manager.AgentFolderWorkspace(folders.Owner);
        files.ResolvedPaths = paths => receipts.Add(paths);
        Assert.Null((await files.ExecuteAsync(new JsonObject { ["name"] = "read", ["args"] = new JsonObject { ["filePath"] = "docs/a.md" } }, default)).AsObject().FailureMessage());
        var receipt = Assert.Single(Assert.Single(receipts))!.AsObject();
        Assert.Equal(Path.Combine(folders.Manager.AgentDirectory("main"), "docs", "a.md"), SessionWait.Text(receipt["resolved"]));
        Assert.Equal("master", SessionWait.Text(receipt["nodeId"]));
    }

    // Finding 12: the endpoint's tools are declared, the same in both profiles.
    [Fact]
    public async Task The_endpoint_declares_the_standard_file_tools_in_both_profiles()
    {
        await using var folders = await FoldersAsync();
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        var onMaster = folders.Manager.ToolRegistry.NodeDefinitions("@agent");
        var withoutMaster = store.Manager.ToolRegistry.NodeDefinitions("@agent");
        Assert.Equal(["edit", "read", "write"], onMaster.Select(item => SessionWait.Text(item!["name"])!).Order());
        Assert.Equal(onMaster.ToJsonString(), withoutMaster.ToJsonString());
        foreach (var fixture in new[] { folders, store.Inner })
        {
            var help = await fixture.Call("ctl", new() { ["command"] = "tool call node:@agent/read --help" });
            output.WriteLine(help.ToJsonString());
            Assert.Null(help.FailureMessage());
            Assert.Contains("filePath", help.ToJsonString());
            var search = await fixture.Call("ctl", new() { ["command"] = "tool search --node-id @@agent --source node --limit 20" });
            output.WriteLine(search.ToJsonString());
            Assert.Null(search.FailureMessage());
            foreach (var name in new[] { "read", "write", "edit" })
                Assert.Contains($"--source node --name {name} --node-id @@agent", SessionWait.Text(search["output"]));
        }
    }
}
