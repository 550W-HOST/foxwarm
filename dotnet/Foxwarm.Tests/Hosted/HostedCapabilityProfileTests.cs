using System.Text.Json.Nodes;
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
            JsonObject? extraApp = null
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
            var configuration = new ModelConfiguration(
                HostPaths.ForDataRoot(f.Data, f.Temp.Path, environment: _ => null)
            );
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
                new HostModels(configuration),
                f.Skills,
                capabilities: capabilities
            );
            await f.Manager.LoadMainHostAsync();
            f.Owner = await f.Manager.CreateNamedAsync("main", "profile", null, null);
            f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            f.Tools = f.Executor(f.Owner);
            return f;
        }

        // The executor a Session's turns use: the manager's registry over the Agent directory.
        internal SessionToolExecutor Executor(SessionOwner owner)
        {
            var tools = new SessionToolExecutor(
                new WorkspaceTools(Manager.AgentDirectory(owner.Agent)),
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

    private static void Unavailable(JsonObject result) =>
        Assert.Contains("Node is not available: master", Error(result) ?? result.ToJsonString());

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
        var calls = new (string Name, JsonObject Args)[]
        {
            ("exec", new() { ["command"] = $"echo changed > '{f.Marker}'" }),
            ("write", new() { ["filePath"] = outside, ["content"] = "x" }),
            ("write", new() { ["filePath"] = f.Marker, ["content"] = "x", ["overwrite"] = true }),
            ("edit", new() { ["filePath"] = f.Marker, ["oldText"] = "before", ["newText"] = "x" }),
            ("read", new() { ["filePath"] = f.Marker }),
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
            ("node_bootstrap_info", new() { ["filePath"] = outside }),
            ("node_create_auth_token", new() { ["nodeId"] = "paired", ["filePath"] = outside }),
            ("set_config", new() { ["target"] = "config", ["filePath"] = f.Marker }),
        };
        foreach (var (name, args) in calls)
            Unavailable(await f.Call(name, args));
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
    public async Task Default_tool_declarations_are_byte_identical_across_profiles()
    {
        await using var file = await Fixture.Create(RuntimeCapabilities.File);
        await using var hosted = await Fixture.Create(RuntimeCapabilities.Hosted);
        var declarations = file.Manager.ModelDefinitions(file.Owner).ToJsonString();
        Assert.Contains("\"exec\"", declarations);
        Assert.Equal(declarations, hosted.Manager.ModelDefinitions(hosted.Owner).ToJsonString());
        Assert.Equal(
            file.Manager.RuntimeModelDefinitions(file.Owner).ToJsonString(),
            hosted.Manager.RuntimeModelDefinitions(hosted.Owner).ToJsonString()
        );
        Assert.Equal(
            file.Manager.ToolRegistry.ModelDefinitions().ToJsonString(),
            hosted.Manager.ToolRegistry.ModelDefinitions().ToJsonString()
        );
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
