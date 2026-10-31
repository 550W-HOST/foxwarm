using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ClaudeRuntimeTests
{
    [Fact]
    public async Task Unsupported_controls_are_rejected_at_concrete_dispatch_before_effects_including_argsJson()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        var operations = new JsonArray
        {
            Call("wait", new JsonObject { ["waitForInput"] = true }),
            Call(
                "create_child_session",
                new JsonObject { ["suffix"] = "forbidden", ["afterSend"] = "finish" }
            ),
            new JsonObject
            {
                ["args"] = new JsonObject
                {
                    ["source"] = "builtin",
                    ["name"] = "send_to_session",
                    ["argsJson"] = new JsonObject
                    {
                        ["sessionId"] = "target",
                        ["message"] = "must not send",
                        ["afterSend"] = "wait",
                    }.ToJsonString(),
                },
            },
            Call("submit_compact_plan", new JsonObject { ["argsFilePath"] = "/does-not-exist" }),
            Call("run_script", new JsonObject { ["code"] = "return 1" }),
            Call(
                "continue_script",
                new JsonObject { ["runId"] = "unreachable", ["continuationId"] = "unreachable" }
            ),
            Call(
                "create_agent",
                new JsonObject { ["agentName"] = "forbidden-agent", ["convertSession"] = true }
            ),
            Call("stop_session", new JsonObject { ["sessionId"] = "external" }),
            Call(
                "session",
                new JsonObject { ["action"] = "update-parent", ["parentSessionId"] = "target" }
            ),
            Call(
                "create_child_session",
                new JsonObject { ["suffix"] = "batch", ["__cancelAllToolsThisTurn"] = true }
            ),
            new JsonObject
            {
                ["name"] = "search_tools",
                ["args"] = new JsonObject
                {
                    ["sources"] = new JsonArray("builtin"),
                    ["limit"] = 200,
                    ["includeSchema"] = false,
                },
            },
        };
        await f.PeerAsync(new JsonObject { ["calls"] = operations });
        await f.RunAsync();
        var results = f.Lines("results.jsonl");
        Assert.Equal(operations.Count, results.Length);
        Assert.All(
            results.Take(results.Length - 1),
            row => Assert.True(row["result"]!["isError"]!.GetValue<bool>(), row.ToJsonString())
        );
        Assert.Null(f.Main.Manager.Catalog.Get("forbidden"));
        Assert.Null(f.Main.Manager.Catalog.Get("batch"));
        Assert.Throws<InvalidDataException>(() => f.Main.Manager.AgentDirectory("forbidden-agent"));
        Assert.Empty(f.Main.Target.Entry.Snapshot().Queue);
        Assert.Null(f.Owner.Entry.Snapshot().Meta["wait"]);
        var discovery = results[^1].ToJsonString();
        Assert.DoesNotContain("builtin:wait", discovery);
        Assert.DoesNotContain("builtin:run_script", discovery);
        Assert.DoesNotContain("builtin:submit_compact_plan", discovery);
        Assert.Equal(
            "complete",
            f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
                "status"
            ]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Runtime_lists_the_internal_visible_tool_set_and_dispatches_concrete_names()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        await f.Main.Manager.SetAgentRulesAsync(
            "main",
            new JsonArray(new JsonObject { ["tool"] = "exec", ["action"] = "deny" })
        );
        var output = Path.Combine(f.Main.Manager.AgentDirectory("main"), "direct.txt");
        await f.PeerAsync(
            new JsonObject
            {
                ["calls"] = new JsonArray(
                    new JsonObject
                    {
                        ["name"] = "write",
                        ["args"] = new JsonObject { ["filePath"] = output, ["content"] = "direct" },
                    },
                    new JsonObject
                    {
                        ["name"] = "exec",
                        ["args"] = new JsonObject { ["command"] = "true" },
                    }
                ),
            }
        );
        await f.RunAsync();
        var listed = JsonNode.Parse(File.ReadAllText(Path.Combine(f.PeerDirectory, "tools.json")))![
            "tools"
        ]!
            .AsArray()
            .OfType<JsonObject>()
            .ToArray();
        var names = listed.Select(t => t["name"]!.GetValue<string>()).ToHashSet();
        var expected = f
            .Main.Manager.ModelDefinitions(f.Owner)
            .OfType<JsonObject>()
            .Select(d => d["name"]!.GetValue<string>())
            .ToHashSet();
        Assert.Equal(expected, names);
        Assert.Contains("write", names);
        Assert.Contains("call_tool", names);
        Assert.DoesNotContain("exec", names);
        Assert.DoesNotContain("wait", names);
        var schemas = new JsonArray(
            listed.Select(t => (JsonNode)t.DeepClone()).ToArray()
        ).ToJsonString();
        Assert.DoesNotContain("__cancelAllToolsThisTurn", schemas);
        Assert.DoesNotContain("__cancelTool", schemas);
        var send = listed.FirstOrDefault(t => t["name"]!.GetValue<string>() == "send_to_session");
        if (send is not null)
            Assert.Equal(
                "[\"continue\"]",
                send["inputSchema"]!["properties"]!["afterSend"]!["enum"]!.ToJsonString()
            );
        var results = f.Lines("results.jsonl");
        Assert.NotEqual(true, results[0]["result"]!["isError"]?.GetValue<bool>());
        Assert.Equal("direct", File.ReadAllText(output));
        Assert.True(results[1]["result"]!["isError"]!.GetValue<bool>());
        Assert.Contains("tool_authorization_denied", results[1].ToJsonString());
        Assert.Contains(
            f.Owner.Entry.Snapshot().History.Materialize(),
            row => SessionWait.Text(row["parts"]?[0]?["functionCall"]?["name"]) == "write"
        );
    }

    [Fact]
    public async Task Policy_changes_recheck_the_exact_Agent_at_every_effect_and_bound_identity_cannot_be_overridden()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(
            new JsonObject { ["hold"] = true }
        );
        var running = f.RunAsync();
        await f.ReadyAsync();
        var input = f.Lines("inputs.jsonl")[0];
        var token = input["token"]!.GetValue<string>();
        using var client = new System.Net.Http.HttpClient();
        var transport = new ModelContextProtocol.Client.HttpClientTransport(
            new ModelContextProtocol.Client.HttpClientTransportOptions
            {
                Endpoint = f.Main.Manager.RuntimeMcpEndpoint!,
                TransportMode = ModelContextProtocol.Client.HttpTransportMode.StreamableHttp,
                AdditionalHeaders = new Dictionary<string, string> { ["Authorization"] = token },
                EnableStandaloneGetStream = false,
            }
        );
        await using var sdk = await ModelContextProtocol.Client.McpClient.CreateAsync(transport);
        await f.Main.Manager.SetAgentRulesAsync(
            "main",
            new JsonArray(new JsonObject { ["tool"] = "write", ["action"] = "deny" })
        );
        var path = Path.Combine(f.Main.Manager.AgentDirectory("main"), "denied.txt");
        var denied = await InboundMcpFixture.CallAsync(
            sdk,
            "call_tool",
            new JsonObject
            {
                ["toolId"] = "node:master/write",
                ["args"] = new JsonObject { ["filePath"] = path, ["content"] = "no" },
            }
        );
        Assert.True(denied["isError"]!.GetValue<bool>());
        Assert.Contains("tool_authorization_denied", denied.ToJsonString());
        Assert.False(File.Exists(path));
        var impersonation = await InboundMcpFixture.CallAsync(
            sdk,
            "call_tool",
            new JsonObject
            {
                ["sessionId"] = "target",
                ["agentName"] = "other",
                ["toolId"] = "builtin:write_memory",
                ["args"] = new JsonObject { ["filePath"] = "no.md", ["content"] = "no" },
            }
        );
        Assert.True(impersonation["isError"]!.GetValue<bool>());
        Assert.False(
            File.Exists(Path.Combine(f.Main.Manager.AgentDirectory("main"), "memory", "no.md"))
        );
        await f.Main.Manager.SetAgentRulesAsync("main", []);
        await new SessionRuntime(f.Main.Manager).StopAsync(f.Owner.Id);
        await running;
        await AssertRevokedAsync(f, token);
    }

    [Fact]
    public async Task Normal_send_delivers_once_and_settles_the_real_child_reporting_receipt()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        var (child, _) = await f.Main.Manager.CreateChildAsync(
            f.Main.Target,
            "child",
            null,
            null,
            null,
            null,
            runtime: "claude-code"
        );
        f.Owner = child;
        child.Registry.TriggerOverride = _ => Task.CompletedTask;
        await f.Main.Manager.SendAsync(f.Main.Target, child.Id, "assigned work");
        await f.PeerAsync(
            new JsonObject
            {
                ["calls"] = new JsonArray(
                    Call(
                        "send_to_session",
                        new JsonObject
                        {
                            ["sessionId"] = "<parent>",
                            ["message"] = "completed",
                            ["afterSend"] = "continue",
                        }
                    )
                ),
            }
        );
        await f.RunAsync(text: null);
        Assert.Null(child.Entry.LastBackgroundProcessorFailure);
        Assert.Single(f.Main.Target.Entry.Snapshot().Queue);
        Assert.Contains(
            "completed",
            f.Main.Target.Entry.Snapshot().Queue[0].Parts![0].ToJsonString()
        );
        Assert.True(
            child.Entry.Snapshot().AuthorityEnvelope["childHandoffState"]![
                "resolved"
            ]!.GetValue<bool>()
        );
        Assert.False(f.Lines("results.jsonl")[0]["result"]?["isError"]?.GetValue<bool>() ?? false);
    }

    [Fact]
    public async Task Actual_MCP_image_and_large_output_keep_normal_output_guard_and_canonical_pairs()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        var image = Path.Combine(f.Main.Manager.AgentDirectory("main"), "pixel.png");
        await File.WriteAllBytesAsync(
            image,
            Convert.FromBase64String(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
            )
        );
        await f.PeerAsync(
            new JsonObject
            {
                ["calls"] = new JsonArray(
                    NodeCall("read", new JsonObject { ["filePath"] = image }),
                    NodeCall(
                        "exec",
                        new JsonObject { ["command"] = "python3 -c \"print('x' * 500000)\"" }
                    )
                ),
            }
        );
        await f.RunAsync();
        Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
        var results = f.Lines("results.jsonl");
        Assert.Contains(
            results[0]["result"]!["content"]!.AsArray().OfType<JsonObject>(),
            part => SessionWait.Text(part["type"]) == "image"
        );
        Assert.False(results[1]["result"]?["isError"]?.GetValue<bool>() ?? false);
        var log = Directory
            .GetFiles(
                Path.Combine(f.Main.Work, ".temp", "exec"),
                "*.log",
                SearchOption.AllDirectories
            )
            .Single();
        Assert.Equal(500001, new FileInfo(log).Length);
        Assert.True(results[1].ToJsonString().Length < 12000);
        var history = f.Owner.Entry.Snapshot().History.Materialize();
        Assert.Equal(2, history.Count(row => SessionWait.Text(row["role"]) == "tool"));
        Assert.Contains(
            history,
            row => row["parts"]!.AsArray().Any(part => part?["inlineDataRef"] is not null)
        );
    }

    [Fact]
    public async Task Current_identity_controls_normalize_real_action_and_target_alias_forms_before_effects()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        f.Owner = await f.Main.Manager.CreateNamedAsync(
            "main",
            "main",
            null,
            null,
            runtime: "claude-code"
        );
        f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await f.PeerAsync(
            new JsonObject
            {
                ["calls"] = new JsonArray(
                    Call("stop_session", new JsonObject { ["sessionId"] = "<main>" }),
                    Call(
                        "session",
                        new JsonObject
                        {
                            ["action"] = " UPDATE-PARENT ",
                            ["sessionId"] = " main ",
                            ["parentSessionId"] = "target",
                        }
                    ),
                    Call(
                        "create_agent",
                        new JsonObject
                        {
                            ["agentName"] = "must-not-convert",
                            ["convertSession"] = true,
                            ["sourceSessionId"] = "main",
                        }
                    )
                ),
            }
        );
        await f.RunAsync();
        Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.All(
            f.Lines("results.jsonl"),
            row => Assert.True(row["result"]!["isError"]!.GetValue<bool>())
        );
        Assert.Equal("main", f.Owner.Id);
        Assert.Null(f.Owner.Metadata().ParentSessionId);
        Assert.Throws<InvalidDataException>(() =>
            f.Main.Manager.AgentDirectory("must-not-convert")
        );
    }
}
