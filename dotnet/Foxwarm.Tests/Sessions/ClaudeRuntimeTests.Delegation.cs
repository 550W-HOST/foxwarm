using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ClaudeRuntimeTests
{
    [Fact]
    public async Task Human_planner_delegates_Node_subtree_to_worker_and_Claude_MCP_executes_only_on_its_child()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(webUiEnabled: true);
        var rootCredential = f.Main.Manager.Nodes.Registry.Create("box1");
        await using var box = await OwnedNode.StartAsync(
            f,
            "box1",
            rootCredential["authToken"]!.GetValue<string>()
        );
        // Documented allowlist recipes: grant the needed capabilities, then deny everything else.
        static JsonArray Tools(params string[] names) =>
            new(names.Select(name => (JsonNode)name).ToArray());
        static JsonArray PlannerRules() =>
            new(
                new JsonObject
                {
                    ["tool"] = Tools(
                        "read",
                        "write",
                        "edit",
                        "apply_patch",
                        "exec",
                        "node_create_auth_token"
                    ),
                    ["node"] = "box1",
                    ["action"] = "allow",
                },
                new JsonObject
                {
                    ["tool"] = Tools(
                        "create_agent",
                        "set_agent_rules",
                        "create_child_session",
                        "send_to_session",
                        "task",
                        "search_tools"
                    ),
                    ["action"] = "allow",
                },
                new JsonObject { ["action"] = "deny" }
            );
        static JsonArray WorkerRules() =>
            new(
                new JsonObject
                {
                    ["tool"] = Tools("read", "write", "edit", "apply_patch", "exec"),
                    ["node"] = "c1",
                    ["action"] = "allow",
                },
                new JsonObject { ["tool"] = "search_tools", ["action"] = "allow" },
                new JsonObject
                {
                    ["tool"] = new JsonObject
                    {
                        ["source"] = "builtin",
                        ["name"] = "send_to_session",
                    },
                    ["args"] = new JsonObject
                    {
                        ["sessionId"] = new JsonObject
                        {
                            ["session"] = new JsonObject { ["relation"] = "parent" },
                        },
                    },
                    ["action"] = "allow",
                },
                new JsonObject { ["action"] = "deny" }
            );
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            f.Main.Url[..^4] + "/api/agents"
        )
        {
            Content = new StringContent(
                new JsonObject
                {
                    ["agentId"] = "planner",
                    ["rules"] = PlannerRules(),
                    ["defaultNode"] = "box1",
                }.ToJsonString(),
                Encoding.UTF8,
                "application/json"
            ),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            InboundMcpFixture.Admin
        );
        using var response = await f.Main.Http.SendAsync(request);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var planner = await f.Main.Manager.RequiredAsync("planner/main");
        Assert.Null(f.Main.Manager.AgentMetadata["planner"]?["createdBy"]);
        planner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var definitions = WorkspaceTools.Definitions();
        foreach (
            var definition in AgentToolDefinitions
                .Definitions()
                .Concat(NodeToolDefinitions.All())
                .Concat(UnifiedToolDefinitions.All())
                .Concat(LocalExecManager.Definitions())
        )
            definitions.Add(definition!.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(
            definitions,
            f.Main.Manager.OutboundMcp,
            owner => f.Main.Manager.IdentityWorkspace(owner).ToolDirectory,
            f.Main.Manager.Nodes,
            f.Main.Manager.NodeProviders
        );
        async Task<JsonObject> Tool(SessionOwner owner, string name, JsonObject args)
        {
            var executor = new SessionToolExecutor(
                new WorkspaceTools(f.Main.Manager.IdentityWorkspace(owner).ToolDirectory),
                owner,
                f.Main.Manager,
                registry
            );
            executor.BeginTurn();
            return (
                await executor.ExecuteAsync(
                    new JsonObject { ["name"] = name, ["args"] = args },
                    default
                )
            )!.AsObject();
        }
        static void Success(JsonObject result) =>
            Assert.True(result["error"] is null, result.ToJsonString());
        var credentialFile = Path.Combine(f.Main.Manager.AgentDirectory("planner"), "c1.token");
        Success(
            await Tool(
                planner,
                "node_create_auth_token",
                new JsonObject
                {
                    ["nodeId"] = "c1",
                    ["parentNode"] = "box1",
                    ["filePath"] = credentialFile,
                }
            )
        );
        Assert.Equal("box1", f.Main.Manager.Nodes.Registry.Forest().Parent("c1"));
        await using var child = await OwnedNode.StartAsync(
            f,
            "c1",
            (await File.ReadAllTextAsync(credentialFile)).Trim()
        );
        Success(
            await Tool(
                planner,
                "create_agent",
                new JsonObject
                {
                    ["agentName"] = "worker",
                    ["rules"] = WorkerRules(),
                    ["defaultNode"] = "c1",
                }
            )
        );
        var worker = await f.Main.Manager.RequiredAsync("worker/main");
        Assert.Equal(
            "planner",
            f.Main.Manager.AgentMetadata["worker"]!["createdBy"]!.GetValue<string>()
        );
        // Actual management tool: a child cannot broaden its ancestor's policy.
        var outOfScope = await Tool(
            worker,
            "set_agent_rules",
            new JsonObject { ["agentName"] = "planner", ["rules"] = new JsonArray() }
        );
        Assert.NotNull(outOfScope["error"]);
        Assert.True(
            JsonNode.DeepEquals(PlannerRules(), f.Main.Manager.AgentMetadata["planner"]!["rules"])
        );
        Success(
            await Tool(
                planner,
                "create_child_session",
                new JsonObject
                {
                    ["agentName"] = "worker",
                    ["suffix"] = "run",
                    ["runtime"] = "claude-code",
                    ["node"] = "c1",
                }
            )
        );
        f.Owner = await f.Main.Manager.RequiredAsync("worker/run");
        f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        Assert.Equal(
            "claude-code",
            f.Owner.Entry.Snapshot().AuthorityEnvelope["runtime"]!.GetValue<string>()
        );
        JsonObject Remote(string node, string file) =>
            new()
            {
                ["args"] = new JsonObject
                {
                    ["toolId"] = "node:" + node + "/exec",
                    ["args"] = new JsonObject
                    {
                        ["command"] =
                            "printf delegated > '"
                            + Path.Combine(node == "c1" ? child.Directory : box.Directory, file)
                            + "'",
                        ["cwd"] = node == "c1" ? child.Directory : box.Directory,
                    },
                },
            };
        await f.PeerAsync(
            new JsonObject
            {
                ["calls"] = new JsonArray(
                    Remote("c1", "allowed.txt"),
                    Remote("box1", "denied.txt"),
                    Call(
                        "mcp_config",
                        new JsonObject { ["name"] = "escape", ["command"] = "true" }
                    ),
                    Call(
                        "send_to_session",
                        new JsonObject
                        {
                            ["sessionId"] = "<parent>",
                            ["message"] =
                                "Child command completed; parent-Node command was refused.",
                            ["afterSend"] = "continue",
                        }
                    )
                ),
            }
        );
        Success(
            await Tool(
                planner,
                "send_to_session",
                new JsonObject
                {
                    ["sessionId"] = f.Owner.Id,
                    ["message"] =
                        "Run the assigned child-Node command, observe scope refusal and report the outcome.",
                    ["afterSend"] = "continue",
                }
            )
        );
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
        await f.RunAsync(text: null);
        Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
        var results = f.Lines("results.jsonl");
        Assert.Equal(4, results.Length);
        Assert.True(
            !(results[0]["result"]?["isError"]?.GetValue<bool>() ?? false),
            results[0].ToJsonString()
        );
        Assert.Equal(
            "delegated",
            await File.ReadAllTextAsync(Path.Combine(child.Directory, "allowed.txt"))
        );
        Assert.False(File.Exists(Path.Combine(box.Directory, "denied.txt")));
        Assert.True(results[1]["result"]!["isError"]!.GetValue<bool>());
        Assert.Contains("tool_authorization_denied", results[1].ToJsonString());
        Assert.True(results[2]["result"]!["isError"]!.GetValue<bool>());
        Assert.Contains("tool_authorization_denied", results[2].ToJsonString());
        Assert.DoesNotContain(
            "escape",
            (await f.Main.Manager.OutboundMcp.ListServersAsync(default)).ToJsonString()
        );
        Assert.False(results[3]["result"]?["isError"]?.GetValue<bool>() ?? false);
        Assert.Single(planner.Entry.Snapshot().Queue);
        Assert.Equal("worker/run", planner.Entry.Snapshot().Queue[0].SourceSessionId);
        Assert.False(SessionBoundary.NeedsChildHandoff(f.Owner.Entry.Snapshot().AuthorityEnvelope));
    }

    private sealed class OwnedNode : IAsyncDisposable
    {
        internal string Directory = "";
        private Process process = null!;
        private Task<string> stderr = null!;

        internal static async Task<OwnedNode> StartAsync(
            ClaudeRuntimeFixture f,
            string id,
            string token
        )
        {
            var node = new OwnedNode { Directory = Path.Combine(f.Temp.Path, "node-" + id) };
            System.IO.Directory.CreateDirectory(node.Directory);
            var config = Path.Combine(node.Directory, "connection.json");
            await File.WriteAllTextAsync(
                config,
                new JsonObject
                {
                    ["host"] = f.Main.Url[..^4],
                    ["nodeId"] = id,
                    ["authToken"] = token,
                    ["credentialsFile"] = Path.Combine(node.Directory, "credentials.json"),
                    ["localTrigger"] = false,
                }.ToJsonString()
            );
            var bootstrap = Path.Combine(node.Directory, "connect.cjs");
            await File.WriteAllTextAsync(
                bootstrap,
                "const {NodeClient}=require(process.argv[2]); const fs=require('fs'); const client=new NodeClient({...JSON.parse(fs.readFileSync(process.argv[3],'utf8')),onStatus:event=>{if(event==='registered') console.log('READY')}}); client.connect().catch(e=>{console.error(e);process.exit(1)});"
            );
            var start = new ProcessStartInfo("node")
            {
                WorkingDirectory = node.Directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            start.ArgumentList.Add(bootstrap);
            start.ArgumentList.Add(
                Path.Combine(
                    Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")!,
                    "packages",
                    "cli-node",
                    "dist",
                    "client.js"
                )
            );
            start.ArgumentList.Add(config);
            start.Environment["FOXWARM_AGENT_DIR"] = node.Directory;
            start.Environment["FOXWARM_DATA_DIR"] = Path.Combine(node.Directory, "state");
            start.Environment["FOXWARM_NO_CONSOLE_LOG"] = "1";
            node.process = Process.Start(start)!;
            node.stderr = node.process.StandardError.ReadToEndAsync();
            try
            {
                Assert.Equal(
                    "READY",
                    await node
                        .process.StandardOutput.ReadLineAsync()
                        .WaitAsync(TimeSpan.FromSeconds(15))
                );
                Assert.True(f.Main.Manager.Nodes.Connected(id));
                return node;
            }
            catch
            {
                await node.DisposeAsync();
                throw;
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            await stderr;
            process.Dispose();
        }
    }
}
