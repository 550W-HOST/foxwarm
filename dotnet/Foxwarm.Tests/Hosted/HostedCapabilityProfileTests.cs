using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// The hosted capability profile (<see cref="RuntimeCapabilities.Hosted"/>) over today's file
/// stores: what a runtime without a master Node lists, refuses and keeps. The stores don't
/// matter here; the hosted startup tests run the profile over the tenant database.
/// </summary>
public sealed class HostedCapabilityProfileTests
{
    internal sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal string Data => Path.Combine(Temp.Path, "main");
        internal string Work => Path.Combine(Temp.Path, "work");
        internal string Skills => Path.Combine(Temp.Path, "skills");
        internal string Target => Path.Combine(Temp.Path, "target");
        internal string Marker => Path.Combine(Temp.Path, "marker.txt");
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal SessionToolExecutor Tools = null!;
        internal const string Provider = "fixture";

        internal static async Task<Fixture> Create(
            RuntimeCapabilities capabilities,
            string? agentDefaultNode = null,
            JsonObject? extraApp = null,
            // The storage context for the data root; null is the file context.
            Func<string, Foxwarm.Storage.IStorageContext>? storage = null,
            // The installed layout (Agent folders under the data root, main among them), as a
            // host's paths give it; otherwise the retained layout with main as the workspace.
            bool installedLayout = false,
            // The configuration owner over the host's paths; null is the files'.
            Func<HostPaths, ModelConfiguration>? configuration = null
        )
        {
            var f = new Fixture();
            Directory.CreateDirectory(Path.Combine(f.Data, "state"));
            Directory.CreateDirectory(f.Target);
            RunnableSkillTests.WriteSkill(f.Skills, "foxwarm-maintenance", "", entry: null);
            RunnableSkillTests.WriteSkill(
                f.Skills,
                "demo",
                "run:\n  entry: scripts/run.py\n  effect: Returns a constant.\n",
                code: "return {'ran': 42}\n"
            );
            await File.WriteAllTextAsync(
                Path.Combine(f.Skills, "demo", "notes.txt"),
                "resource text\n"
            );
            var app = new JsonObject
            {
                ["vector"] = false,
                ["nodeProviders"] = new JsonObject
                {
                    [Provider] = ExecutableNodeProviderTests.Configuration(f.Target),
                },
            };
            if (agentDefaultNode is not null)
                app["agentDefaultNode"] = agentDefaultNode;
            foreach (var (key, value) in extraApp ?? [])
                app[key] = value?.DeepClone();
            await File.WriteAllTextAsync(
                Path.Combine(f.Data, "state", "config.yaml"),
                app.ToJsonString()
            );
            await File.WriteAllTextAsync(
                Path.Combine(f.Data, "state", "models.yaml"),
                "default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    models: [wire]\n"
            );
            var paths = HostPaths.ForDataRoot(f.Data, f.Temp.Path, environment: _ => null);
            var models = configuration?.Invoke(paths) ?? new ModelConfiguration(paths);
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "local/wire",
                "",
                "",
                713
            );
            f.Manager = new(
                f.Data,
                f.Work,
                options,
                new HostModels(models),
                f.Skills,
                storage: storage?.Invoke(f.Data),
                capabilities: capabilities,
                hostPaths: installedLayout ? paths : null
            );
            await f.Manager.LoadMainHostAsync();
            f.Owner = await f.Manager.CreateNamedAsync("main", "profile", null, null);
            f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            f.Tools = f.Executor(f.Owner);
            return f;
        }

        // The executor a Session's turns use: the manager's registry over the Agent's files.
        internal SessionToolExecutor Executor(SessionOwner owner)
        {
            var tools = new SessionToolExecutor(
                Manager.AgentWorkspace(owner.Agent),
                owner,
                Manager,
                Manager.ToolRegistry
            );
            tools.BeginTurn();
            return tools;
        }

        internal async Task<JsonObject> Call(string name, JsonObject args, SessionToolExecutor? tools = null) =>
            (
                await (tools ?? Tools).ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = Guid.NewGuid().ToString("N"),
                        ["name"] = name,
                        ["args"] = args,
                    },
                    default
                )
            )!.AsObject();

        internal Task<JsonObject> Ctl(string command) =>
            Call("ctl", new JsonObject { ["command"] = command });

        public async ValueTask DisposeAsync()
        {
            if (Manager is not null)
            {
                await Manager.ShutdownAsync();
                await Manager.DisposeAsync();
            }
            Temp.Dispose();
        }
    }

    private static string? Error(JsonObject result) => result.FailureMessage();

    private static void Succeeded(JsonObject result) =>
        Assert.True(Error(result) is null, result.ToJsonString());

    private const string NoNode =
        "This Session has no Node. Select one with `ctl node select <node-id>`; `ctl node list` shows the available Nodes.";

    [Fact]
    public async Task Node_list_omits_master_and_a_master_target_fails_before_any_effect()
    {
        await using var f = await Fixture.Create(RuntimeCapabilities.Hosted);
        var listed = await f.Call("node", new JsonObject { ["action"] = "list" });
        Succeeded(listed);
        Assert.Null(listed["currentNode"]);
        Assert.DoesNotContain("\"master\"", listed.ToJsonString());
        Assert.DoesNotContain(
            f.Manager.NodeSummaries().OfType<JsonObject>(),
            node => SessionWait.Text(node["id"]) == "master"
        );
        var command = await f.Ctl("node list");
        Succeeded(command);
        Assert.DoesNotContain("\"master\"", command.ToJsonString());
        var status = await f.Call("node", new JsonObject { ["action"] = "status" });
        Assert.Null(status["currentNode"]);
        Assert.False(status["connected"]!.GetValue<bool>());

        await File.WriteAllTextAsync(f.Marker, "before");
        var outside = Path.Combine(f.Temp.Path, "outside.txt");
        // Through the Session's current Node, which it doesn't have.
        var current = new (string Name, JsonObject Args)[]
        {
            ("exec", new() { ["command"] = $"echo changed > '{f.Marker}'" }),
            ("write", new() { ["filePath"] = outside, ["content"] = "x" }),
            ("write", new() { ["filePath"] = f.Marker, ["content"] = "x", ["overwrite"] = true }),
            ("edit", new() { ["filePath"] = f.Marker, ["oldText"] = "before", ["newText"] = "x" }),
            ("read", new() { ["filePath"] = f.Marker }),
            (
                "ctl",
                new()
                {
                    ["command"] = "tool call node:current/write --args @a",
                    ["values"] = new JsonObject
                    {
                        ["a"] = new JsonObject { ["filePath"] = outside, ["content"] = "x" },
                    },
                }
            ),
            ("run_script", new() { ["filePath"] = f.Marker }),
            ("send_file", new() { ["filePath"] = f.Marker }),
            (
                "skill",
                new()
                {
                    ["action"] = "copy",
                    ["skillName"] = "demo",
                    ["targetPath"] = outside,
                }
            ),
        };
        foreach (var (name, args) in current)
        {
            var error = Error(await f.Call(name, args));
            Assert.True(error == NoNode, $"{name} {args.ToJsonString()}: {error}");
        }
        // Naming master, or a Main-local file.
        var calls = new (string Name, JsonObject Args)[]
        {
            ("node", new() { ["action"] = "select", ["nodeId"] = "master" }),
            ("ctl", new() { ["command"] = "node select master" }),
            (
                "ctl",
                new()
                {
                    ["command"] = "tool call node:master/write --args @a",
                    ["values"] = new JsonObject
                    {
                        ["a"] = new JsonObject { ["filePath"] = outside, ["content"] = "x" },
                    },
                }
            ),
            (
                "copy_between_nodes",
                new()
                {
                    ["sourceNode"] = "master",
                    ["sourcePath"] = f.Marker,
                    ["targetNode"] = "master",
                    ["targetPath"] = outside,
                }
            ),
            ("run_script", new() { ["node"] = "master", ["filePath"] = f.Marker }),
            ("send_file", new() { ["node"] = "master", ["filePath"] = f.Marker }),
            ("node_bootstrap_info", new() { ["filePath"] = outside }),
            ("node_create_auth_token", new() { ["nodeId"] = "paired", ["filePath"] = outside }),
        };
        foreach (var (name, args) in calls)
        {
            var error = Error(await f.Call(name, args));
            Assert.True(error == "Node is not available: master", $"{name} {args.ToJsonString()}: {error}");
        }
        // A configuration candidate is a file of the Agent folder there, never a master path.
        Assert.Equal(
            $"`@agent` reaches only this Agent's own folder: {f.Marker}.",
            Error(await f.Call("set_config", new() { ["target"] = "config", ["filePath"] = f.Marker }))
        );
        // A move from configuration has nothing that could authorize it.
        var move = await f.Call(
            "add_secret",
            new JsonObject
            {
                ["name"] = "moved",
                ["fromConfig"] = new JsonArray(
                    new JsonObject { ["target"] = "config", ["path"] = new JsonArray("token") }
                ),
            }
        );
        Assert.Contains("fromConfig is not available", Error(move) ?? move.ToJsonString());
        Assert.Equal("before", await File.ReadAllTextAsync(f.Marker));
        Assert.False(File.Exists(outside));
        Assert.False(f.Manager.Nodes.Registry.Forest().Contains("paired"));
        Assert.Throws<InvalidDataException>(() => f.Manager.ToolRegistry.NodeDefinitions("master"));
    }

    [Fact]
    public async Task No_Main_local_browser_tools_or_spool_exist_and_the_file_profile_keeps_them()
    {
        await using var hosted = await Fixture.Create(RuntimeCapabilities.Hosted);
        await using var file = await Fixture.Create(RuntimeCapabilities.File);
        static string[] Browser(Fixture f) =>
            f.Manager.ToolRegistry.Entries
                .Select(entry => SessionWait.Text(entry.Definition["name"])!)
                .Where(name => name.StartsWith("browser", StringComparison.Ordinal))
                .ToArray();
        Assert.Empty(Browser(hosted));
        Assert.NotEmpty(Browser(file));
        Assert.Contains(
            file.Manager.ToolRegistry.NodeDefinitions("master").OfType<JsonObject>(),
            definition => SessionWait.Text(definition["name"]) == "exec"
        );
        // Without a Node, a large result is shortened in place: nothing lands in the Agent folder.
        var big = await hosted.Ctl("skill load demo notes.txt");
        Succeeded(big);
        var spill = await hosted.Tools.SaveToolOutputAsync(
            new string('x', 10),
            "master",
            hosted.Manager.AgentDirectory("main"),
            default
        ).ContinueWith(task => task.Exception?.InnerException);
        Assert.IsType<InvalidOperationException>(spill);
        Assert.False(Directory.Exists(Path.Combine(hosted.Manager.AgentDirectory("main"), ".temp", "tool-output")));
    }

    [Fact]
    public async Task Stdio_MCP_servers_are_refused_and_HTTP_servers_are_kept()
    {
        await using var f = await Fixture.Create(RuntimeCapabilities.Hosted);
        var configuration = f.Manager.OutboundMcp.Configuration;
        Assert.False(configuration.StdioAvailable);
        var refused = await Assert.ThrowsAsync<InvalidDataException>(() =>
            configuration.UpdateAsync(
                "local",
                new JsonObject { ["transport"] = "stdio", ["command"] = "server" },
                false
            )
        );
        Assert.Contains("stdio", refused.Message);
        Assert.Null(configuration.Snapshot()["local"]);
        await configuration.UpdateAsync(
            "remote",
            new JsonObject { ["transport"] = "streamable-http", ["url"] = "https://mcp.example.test/mcp" },
            false
        );
        Assert.NotNull(configuration.Snapshot()["remote"]);

        // A stored stdio server (written before, or by another profile) fails the load.
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "mcp.json"),
            """{"servers":{"local":{"transport":"stdio","command":"server"}}}"""
        );
        var stored = new McpConfiguration(temp.Path) { StdioAvailable = false };
        Assert.Throws<InvalidDataException>(() => stored.Snapshot());
        Assert.NotNull(new McpConfiguration(temp.Path).Snapshot()["local"]);
    }

    // Plan §11 "capability absence" per profile: the hosted profile has no master, stdio MCP or
    // Claude runtime; the operator profile has file mode's. A tenant of either profile can't
    // configure a Provider itself (DeploymentConfigurationTests: `nodeProviders` is the
    // operator's), and grants to hosted tenants are track CH's.
    [Fact]
    public async Task Capability_absence_follows_the_stored_profile()
    {
        foreach (var (profile, present) in new[] { (TenantProfile.Hosted, false), (TenantProfile.Operator, true) })
        {
            await using var f = await Fixture.Create(RuntimeCapabilities.For(profile));
            Assert.Equal(present, f.Manager.OutboundMcp.Configuration.StdioAvailable);
            var listed = await f.Ctl("node list");
            Succeeded(listed);
            Assert.Equal(present, listed.ToJsonString().Contains("\"master\"", StringComparison.Ordinal));
            var exec = await f.Call("exec", new JsonObject { ["command"] = "true" });
            Assert.Equal(present, Error(exec) is null);
            Assert.Equal(present, f.Manager.Capabilities.ClaudeRuntime);
            // The deployment's Provider is available to both.
            Assert.True(f.Manager.NodeProviders.HasProvider(Fixture.Provider));
        }
    }

    [Fact]
    public async Task New_Sessions_start_on_a_real_default_Node_or_Provider_Node_and_otherwise_without_one()
    {
        async Task<string?> PlacedAsync(string? agentDefaultNode, Action<SessionManager>? prepare = null)
        {
            await using var f = await Fixture.Create(RuntimeCapabilities.Hosted, agentDefaultNode);
            prepare?.Invoke(f.Manager);
            var owner = await f.Manager.CreateNamedAsync("main", "placed", null, null);
            return SessionWait.Text(owner.Entry.Snapshot().AuthorityEnvelope["currentNode"]);
        }
        Assert.Null(await PlacedAsync(null));
        Assert.Null(await PlacedAsync("master"));
        Assert.Null(await PlacedAsync("missing-node"));
        Assert.Null(await PlacedAsync("unknown-provider/box"));
        Assert.Equal(Fixture.Provider + "/box", await PlacedAsync(Fixture.Provider + "/box"));
        Assert.Equal(
            "resident",
            await PlacedAsync("resident", manager => manager.Nodes.Registry.Create("resident"))
        );
        // The prompt's A1 instruction: a Node-less Session lists Nodes and selects a listed one. A
        // Provider Node that the Provider doesn't list is refused as in file mode; it is created
        // with the Provider's lifecycle first.
        await using (var selecting = await Fixture.Create(RuntimeCapabilities.Hosted))
        {
            var listed = await selecting.Ctl("node list");
            Succeeded(listed);
            Assert.Contains($"\"{Fixture.Provider}/target\"", listed.ToJsonString());
            Succeeded(await selecting.Ctl($"node select {Fixture.Provider}/target"));
            Assert.Equal(Fixture.Provider + "/target", selecting.Manager.CurrentNode(selecting.Owner));
            var status = await selecting.Call("node", new JsonObject { ["action"] = "status" });
            Assert.Equal(Fixture.Provider + "/target", SessionWait.Text(status["currentNode"]));
            Assert.Contains("not admitted", Error(await selecting.Ctl($"node select {Fixture.Provider}/box")) ?? "");
        }
        await using (var fileSelecting = await Fixture.Create(RuntimeCapabilities.File))
            Assert.Contains("not admitted", Error(await fileSelecting.Ctl($"node select {Fixture.Provider}/box")) ?? "");
        // File mode keeps today's placement: master, and any named default as given.
        await using var file = await Fixture.Create(RuntimeCapabilities.File, "missing-node");
        Assert.Equal(
            "missing-node",
            SessionWait.Text(
                (await file.Manager.CreateNamedAsync("main", "placed", null, null))
                    .Entry.Snapshot()
                    .AuthorityEnvelope["currentNode"]
            )
        );
        await using var unset = await Fixture.Create(RuntimeCapabilities.File);
        Assert.Equal("master", unset.Manager.CurrentNode(unset.Owner));
    }

    [Fact]
    public async Task Session_presentation_reports_no_current_Node_until_one_is_selected()
    {
        await using var f = await Fixture.Create(RuntimeCapabilities.Hosted);
        var id = f.Owner.Id;
        static void NoNode(JsonObject session)
        {
            Assert.True(session.ContainsKey("currentNode"), session.ToJsonString());
            Assert.Null(session["currentNode"]);
        }
        NoNode(f.Owner.BuildDto());
        var runtime = new SessionRuntime(f.Manager);
        NoNode(runtime.GetSession(id)!);
        NoNode(
            Foxwarm.Channels.WebUi.WebUiContract.Event(
                new SessionRuntimeEvent(id, SessionEventKind.StateChanged, null),
                runtime
            )["session"]!.AsObject()
        );
        NoNode(f.Manager.ListPresentations().Single(row => SessionWait.Text(row["id"]) == id));
        NoNode(f.Manager.CatalogPresentations([id], includeLocal: false).Single());
        NoNode(f.Manager.CatalogPresentations([id], includeLocal: true).Single());

        var status = await f.Manager.ObserveAsync(
            f.Owner,
            "session",
            new JsonObject { ["action"] = "status" },
            administrator: true
        );
        Assert.Null(status["node"]);
        var text = SessionStatus.Text(status);
        Assert.Contains("- current node: none\n", text);
        Assert.Contains("- current cwd: not set\n", text);
        Assert.DoesNotContain("master", text);
        var (_, page) = f.Manager.AdministratorSessionList(null, 0, 10, null);
        NoNode(page.Single(row => SessionWait.Text(row["id"]) == id));

        // A selected Node is reported as it is.
        Succeeded(await f.Ctl($"node select {Fixture.Provider}/target"));
        Assert.Equal(Fixture.Provider + "/target", SessionWait.Text(f.Owner.BuildDto()["currentNode"]));
        Assert.Equal(
            Fixture.Provider + "/target",
            SessionWait.Text(
                f.Manager.CatalogPresentations([id], includeLocal: true).Single()["currentNode"]
            )
        );
        status = await f.Manager.ObserveAsync(
            f.Owner,
            "session",
            new JsonObject { ["action"] = "status" },
            administrator: true
        );
        text = SessionStatus.Text(status);
        Assert.Contains($"- current node: `{Fixture.Provider}/target`", text);
        Assert.DoesNotContain("agent directory", text);

        // File mode keeps master for an unset Node.
        await using var file = await Fixture.Create(RuntimeCapabilities.File);
        Assert.Equal("master", SessionWait.Text(file.Owner.BuildDto()["currentNode"]));
        Assert.Equal(
            "master",
            SessionWait.Text(
                file.Manager.CatalogPresentations([file.Owner.Id], includeLocal: true)
                    .Single()["currentNode"]
            )
        );
        var fileText = SessionStatus.Text(
            await file.Manager.ObserveAsync(
                file.Owner,
                "session",
                new JsonObject { ["action"] = "status" },
                administrator: true
            )
        );
        Assert.Contains("- current node: `master`", fileText);
        Assert.Contains("- agent directory: `", fileText);
    }

    [Fact]
    public async Task Default_tool_declarations_are_byte_identical_across_profiles()
    {
        await using var file = await Fixture.Create(RuntimeCapabilities.File);
        var declarations = file.Manager.ModelDefinitions(file.Owner).ToJsonString();
        Assert.Contains("\"exec\"", declarations);
        foreach (var profile in new[] { TenantProfile.Hosted, TenantProfile.Operator })
        {
            await using var tenant = await Fixture.Create(RuntimeCapabilities.For(profile));
            Assert.Equal(declarations, tenant.Manager.ModelDefinitions(tenant.Owner).ToJsonString());
            Assert.Equal(
                file.Manager.RuntimeModelDefinitions(file.Owner).ToJsonString(),
                tenant.Manager.RuntimeModelDefinitions(tenant.Owner).ToJsonString()
            );
            Assert.Equal(
                file.Manager.ToolRegistry.ModelDefinitions().ToJsonString(),
                tenant.Manager.ToolRegistry.ModelDefinitions().ToJsonString()
            );
        }
    }

    [Fact]
    public void A_stored_profile_selects_its_capabilities()
    {
        static object Features(RuntimeCapabilities set) =>
            (set.MasterNode, set.MainTerminalsAndCode, set.StdioMcp, set.ClaudeRuntime, set.ExecutableProviders, set.LogsView);
        // The deployment's egress rules go into each profile's own egress policy.
        var rules = Foxwarm.Net.EgressRules.Parse(
            System.Text.Json.Nodes.JsonNode.Parse("""{"deny": ["10.0.0.0/8"], "allow": {"hosted": ["10.0.0.4"], "operator": ["10.0.0.5"]}}""")
        );
        var hosted = RuntimeCapabilities.For(TenantProfiles.Parse("hosted"), rules);
        var @operator = RuntimeCapabilities.For(TenantProfiles.Parse("operator"), rules);
        Assert.Equal(Features(RuntimeCapabilities.Hosted), Features(hosted));
        Assert.Equal(Features(RuntimeCapabilities.Operator), Features(@operator));
        Assert.Equal(Foxwarm.Net.EgressProfile.Hosted, hosted.Egress.Profile);
        Assert.Equal(Foxwarm.Net.EgressProfile.Operator, @operator.Egress.Profile);
        Assert.False(hosted.Egress.Denies(System.Net.IPAddress.Parse("10.0.0.4")));
        Assert.True(hosted.Egress.Denies(System.Net.IPAddress.Parse("10.0.0.5")));
        Assert.False(@operator.Egress.Denies(System.Net.IPAddress.Parse("10.0.0.5")));
        Assert.True(@operator.Egress.Denies(System.Net.IPAddress.Parse("10.0.0.4")));
        Assert.Equal(Foxwarm.Net.EgressProfile.Operator, RuntimeCapabilities.Operator.Egress.Profile);
        // The operator profile has file mode's features; only its stores and egress differ.
        Assert.Equal(Features(RuntimeCapabilities.File), Features(RuntimeCapabilities.Operator));
        Assert.Throws<InvalidDataException>(() => TenantProfiles.Parse("file"));
        Assert.Throws<InvalidDataException>(() => TenantProfiles.Parse(null));
    }

    // A bundled skill's master-node wrappers are filtered for the runtime in `skill load` and its
    // resource reads; file mode reads the document without wrappers or hosted text.
    [Fact]
    public async Task Bundled_skill_documents_and_resources_read_for_the_profile()
    {
        const string Conditioned =
            "before\n<foxwarm-if master-node=\"true\">\nFILE-ONLY\n</foxwarm-if>\n<foxwarm-if master-node=\"false\">\nHOSTED-ONLY\n</foxwarm-if>\nafter\n";
        foreach (var capabilities in new[] { RuntimeCapabilities.File, RuntimeCapabilities.Hosted })
        {
            await using var f = await Fixture.Create(capabilities);
            await File.AppendAllTextAsync(Path.Combine(f.Skills, "demo", "SKILL.md"), Conditioned);
            await File.WriteAllTextAsync(Path.Combine(f.Skills, "demo", "guide.md"), Conditioned);
            var expected = capabilities.MasterNode ? "before\nFILE-ONLY\nafter\n" : "before\nHOSTED-ONLY\nafter\n";
            var load = await f.Ctl("skill load demo");
            Succeeded(load);
            var text = load["output"]!.GetValue<string>();
            Assert.EndsWith(expected + "\n", text);
            Assert.DoesNotContain("foxwarm-if", text);
            var resource = await f.Ctl("skill load demo guide.md");
            Succeeded(resource);
            var read = resource["output"]!.GetValue<string>();
            Assert.Contains(capabilities.MasterNode ? "FILE-ONLY" : "HOSTED-ONLY", read);
            Assert.DoesNotContain(capabilities.MasterNode ? "HOSTED-ONLY" : "FILE-ONLY", read);
            Assert.DoesNotContain("foxwarm-if", read);
            // Line ranges count the runtime's text.
            var second = await f.Ctl("skill load demo guide.md --start-line 2 --end-line 2");
            Succeeded(second);
            Assert.Contains(capabilities.MasterNode ? "FILE-ONLY" : "HOSTED-ONLY", second["output"]!.GetValue<string>());
            Assert.DoesNotContain("before", second["output"]!.GetValue<string>());
        }
    }

    [Fact]
    public async Task Skills_memory_and_the_prompt_work_without_master()
    {
        await using var f = await Fixture.Create(RuntimeCapabilities.Hosted);
        var list = await f.Ctl("skill list");
        Succeeded(list);
        Assert.Contains("demo", list.ToJsonString());
        Assert.DoesNotContain("foxwarm-maintenance", list.ToJsonString());
        Assert.Contains(
            "not found",
            Error(await f.Ctl("skill load foxwarm-maintenance")) ?? ""
        );
        var load = await f.Ctl("skill load demo");
        Succeeded(load);
        Assert.Contains("notes.txt", load.ToJsonString());
        Assert.DoesNotContain("On master", load.ToJsonString());
        Assert.DoesNotContain(f.Skills, load.ToJsonString());
        var resource = await f.Ctl("skill load demo notes.txt");
        Succeeded(resource);
        Assert.Contains("resource text", resource.ToJsonString());
        var run = await f.Ctl("skill run demo");
        Succeeded(run);
        Assert.Contains("42", run.ToJsonString());

        await f.Manager.CreateAgentAsync("other");
        foreach (var agent in new string?[] { null, "other" })
        {
            JsonObject Args(JsonObject args)
            {
                if (agent is not null)
                    args["agentName"] = agent;
                return args;
            }
            Succeeded(await f.Call("write_memory", Args(new() { ["filePath"] = "NOTES.md", ["content"] = "first" })));
            Succeeded(
                await f.Call(
                    "edit_memory",
                    Args(new() { ["filePath"] = "NOTES.md", ["oldText"] = "first", ["newText"] = "second" })
                )
            );
            var read = await f.Call("read_memory", Args(new() { ["filePath"] = "NOTES.md" }));
            Succeeded(read);
            Assert.Contains("second", read.ToJsonString());
            Assert.Equal(
                "second",
                await File.ReadAllTextAsync(
                    Path.Combine(f.Manager.MemoryDirectory(agent ?? "main"), "NOTES.md")
                )
            );
        }
        var memoryCommand = await f.Ctl("memory read NOTES.md --agent other");
        Succeeded(memoryCommand);
        Succeeded(await f.Call("delete_memory", new() { ["filePath"] = "NOTES.md", ["agentName"] = "other" }));
        Assert.False(File.Exists(Path.Combine(f.Manager.MemoryDirectory("other"), "NOTES.md")));

        // The Session's prompt: the bundled template's no-master text, an Agent memory file, and
        // no Main-local path.
        await File.WriteAllTextAsync(Path.Combine(f.Manager.MemoryDirectory("main"), "MEMORY.md"), "AGENT-RULE");
        var owner = await f.Manager.CreateNamedAsync("main", "prompted", null, null);
        var prompt = SessionWait.Text(owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"])!;
        Assert.Contains("When a Session has no Node, select one first", prompt);
        Assert.DoesNotContain("installation-wide additions go in", prompt);
        Assert.Contains("<memory_file agent=main; ownership=self>\nAGENT-RULE\n", prompt);
        Assert.DoesNotContain("path=", prompt);
        Assert.DoesNotContain("agent_folder", prompt);
        Assert.DoesNotContain(f.Temp.Path, prompt);
        Assert.DoesNotContain("master-node", prompt);
    }

    [Fact]
    public async Task The_file_profile_keeps_master_paths_maintenance_and_the_file_prompt()
    {
        await using var f = await Fixture.Create(RuntimeCapabilities.File);
        // A file-mode Session always has a Node: unset is master, where file tools run.
        await File.WriteAllTextAsync(f.Marker, "on master");
        var read = await f.Call("read", new JsonObject { ["filePath"] = f.Marker });
        Succeeded(read);
        Assert.Contains("on master", read.ToJsonString());
        Assert.Contains("foxwarm-maintenance", (await f.Ctl("skill list")).ToJsonString());
        Assert.Contains("On master", (await f.Ctl("skill load demo")).ToJsonString());
        var prompt = SessionWait.Text(f.Owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"])!;
        Assert.Contains("installation-wide additions go in", prompt);
        Assert.DoesNotContain("When a Session has no Node, select one first", prompt);
        Assert.Contains("- agent_folder: " + f.Manager.AgentDirectory("main"), prompt);
        Assert.Contains("; path=", prompt);
    }

    [Fact]
    public async Task Received_files_are_kept_only_as_inline_images_without_master()
    {
        await using var f = await Fixture.Create(RuntimeCapabilities.Hosted);
        var document = await f.Manager.SaveInboundChannelFileAsync(
            "telegram",
            "chat",
            "plain text"u8.ToArray(),
            "notes.txt",
            "text/plain",
            "caption",
            default
        );
        var text = SessionWait.Text(Assert.Single(document)["text"])!;
        Assert.StartsWith("caption\n\n[Received file not kept: \"notes.txt\" (text/plain, 10 bytes).", text);
        var png = Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        );
        var image = await f.Manager.SaveInboundChannelFileAsync(
            "telegram",
            "chat",
            png,
            "dot.png",
            "image/png",
            "",
            default
        );
        Assert.NotNull(Assert.Single(image)["inlineDataRef"]);
        Assert.False(
            Directory.Exists(Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files"))
        );
    }

    [Fact]
    public async Task The_Claude_runtime_is_refused_and_vector_follows_the_archive()
    {
        await using var f = await Fixture.Create(
            RuntimeCapabilities.Hosted,
            extraApp: new JsonObject
            {
                ["vector"] = new JsonObject { ["enabled"] = true, ["baseUrl"] = "http://127.0.0.1:1/v1" },
            }
        );
        var refused = await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.CreateNamedAsync("main", "claude", null, null, runtime: ClaudeRuntimeState.Kind)
        );
        Assert.Contains("Claude Code runtime is not available", refused.Message);
        // Over the SQLite Archive the configuration decides; HostedStartupTests covers the
        // tenant Archive, where Vector is off whatever it says.
        Assert.True(f.Manager.Vector.Configuration.Enabled);
    }
}
