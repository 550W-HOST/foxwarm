using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCreationParityTests
{
    private static void Successful(JsonNode? response) =>
        Assert.True(response is JsonObject && response["error"] is null, response?.ToJsonString());

    [Fact]
    public async Task Registered_agent_creation_keeps_raw_source_defaults_and_explicit_source_precedence()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        await f.Configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] = """
                default: local/wire
                providers:
                  local:
                    providerType: openai-responses
                    baseUrl: http://127.0.0.1:1/v1/
                    models: [wire, future, other]
                """,
            }
        );
        await f.Owner.Entry.SaveLane.CommitSettingsAsync(
            new JsonObject
            {
                ["model"] = "local/wire",
                ["effort"] = "low",
                ["childModelDefault"] = "local/future",
                ["childEffortDefault"] = "high",
            },
            f.Manager.Models
        );
        await f.Owner.Entry.SaveLane.CommitNodeAsync("caller-offline", clearCwd: false);
        await f.Owner.UpdateCwdAsync("not-inherited");
        Successful(
            await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "implicit" })
        );
        var created = await f.Manager.RequiredAsync("implicit/main");
        var envelope = created.Entry.Snapshot().AuthorityEnvelope;
        Assert.Equal("local/wire", SessionWait.Text(envelope["model"]));
        Assert.Equal("low", SessionWait.Text(envelope["effort"]));
        Assert.Equal("local/future", SessionWait.Text(envelope["childModelDefault"]));
        Assert.Equal("high", SessionWait.Text(envelope["childEffortDefault"]));
        Assert.Equal("caller-offline", f.Manager.CurrentNode(created));
        Assert.Null(envelope["cwd"]);
        Assert.Empty(created.Entry.Snapshot().History);
        var source = await f.Manager.CreateNamedAsync(
            "main",
            "other-source",
            null,
            null,
            initialNode: "source-offline"
        );
        await source.Entry.SaveLane.CommitSettingsAsync(
            new JsonObject
            {
                ["model"] = "local/other",
                ["effort"] = "medium",
                ["childEffortDefault"] = "max",
            },
            f.Manager.Models
        );
        var sourceAlias = source.Id;
        await f.Manager.MoveIdentityAsync(
            source,
            new JsonObject { ["newSessionId"] = "renamed-source" }
        );
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject { ["agentName"] = "explicit", ["sourceSessionId"] = sourceAlias }
            )
        );
        var explicitOwner = await f.Manager.RequiredAsync("explicit/main");
        var disk = JsonNode.Parse(
            await File.ReadAllTextAsync(explicitOwner.AuthorityStore.AuthorityPath)
        )!;
        // The tool supplies the caller's model/Node; the selected source supplies effort and future-child policy.
        Assert.Equal("local/wire", SessionWait.Text(disk["model"]));
        Assert.Equal("medium", SessionWait.Text(disk["effort"]));
        Assert.Equal("max", SessionWait.Text(disk["childEffortDefault"]));
        Assert.Null(disk["childModelDefault"]);
        Assert.Equal("caller-offline", f.Manager.CurrentNode(explicitOwner));
    }

    [Fact]
    public async Task Missing_source_uses_normal_lifetime_creation_after_target_preflight_and_does_not_revive_an_archive()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        await f.Owner.Entry.SaveLane.CommitSettingsAsync(
            new JsonObject
            {
                ["model"] = "local/wire",
                ["effort"] = "low",
                ["childEffortDefault"] = "high",
            },
            f.Manager.Models
        );
        await f.Owner.Entry.SaveLane.CommitNodeAsync("caller-offline", clearCwd: false);
        await f.Manager.CreateAgentAsync("source-agent", false);
        await f.Manager.CreateNamedAsync(
            "source-agent",
            "main",
            null,
            null,
            initialNode: "agent-main-offline"
        );
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject
                {
                    ["agentName"] = "from-missing-source",
                    ["sourceSessionId"] = "source-agent/new-source",
                }
            )
        );
        var source = await f.Manager.RequiredAsync("source-agent/new-source");
        Assert.True(File.Exists(source.AuthorityStore.AuthorityPath));
        Assert.Empty(source.Entry.Snapshot().History);
        Assert.Null(source.Metadata().ParentSessionId);
        Assert.Equal("master", f.Manager.CurrentNode(source));
        var created = await f.Manager.RequiredAsync("from-missing-source/main");
        var envelope = created.Entry.Snapshot().AuthorityEnvelope;
        Assert.Equal("local/wire", SessionWait.Text(envelope["model"]));
        Assert.Null(envelope["effort"]);
        Assert.Null(envelope["childEffortDefault"]);
        Assert.Equal("caller-offline", f.Manager.CurrentNode(created));
        await f.Manager.CreateAgentAsync("reserved-target");
        await f.Manager.DeleteAgentAsync("reserved-target");
        var reserved = await f.ToolAsync(
            "create_agent",
            new JsonObject
            {
                ["agentName"] = "reserved-target",
                ["sourceSessionId"] = "must-not-be-created",
            }
        );
        Assert.NotNull(reserved!["error"]);
        Assert.Null(await f.Manager.GetExistingAsync("must-not-be-created"));
        Assert.DoesNotContain("reserved-target", f.Manager.Agents());
        await f.Manager.DeleteAsync(source.Id);
        var archivedSource = await f.ToolAsync(
            "create_agent",
            new JsonObject
            {
                ["agentName"] = "from-archived-source",
                ["sourceSessionId"] = "source-agent/new-source",
            }
        );
        Assert.NotNull(archivedSource!["error"]);
        Assert.Null(await f.Manager.GetExistingAsync("source-agent/new-source"));
        Assert.DoesNotContain("from-archived-source", f.Manager.Agents());
    }

    [Fact]
    public async Task One_time_memory_copy_and_shipped_isolated_worker_creation_use_existing_isolation_and_rule_owners()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        var sourceMemory = Path.Combine(f.Manager.AgentDirectory("main"), "memory", "COPY.md");
        await File.WriteAllTextAsync(sourceMemory, "one-time copied memory");
        f.Manager.Nodes.Registry.Create("worker-node");
        var rules = new JsonArray(
            new JsonObject
            {
                ["source"] = "builtin",
                ["tool"] = "skill",
                ["effect"] = "deny",
            }
        );
        // Same creation shape as skills/isolated-worker/create_isolated_worker.py, plus supported copy/rule inputs.
        Successful(
            await f.ToolAsync(
                "call_tool",
                new JsonObject
                {
                    ["source"] = "builtin",
                    ["name"] = "create_agent",
                    ["args"] = new JsonObject
                    {
                        ["agentName"] = "worker",
                        ["isolatedNode"] = "worker-node",
                        ["createMainSession"] = false,
                        ["inheritMemory"] = true,
                        ["toolRules"] = rules,
                    },
                }
            )
        );
        Assert.Null(await f.Manager.GetExistingAsync("worker/main"));
        Assert.True(f.Manager.AgentIsolated("worker"));
        Assert.Equal("worker-node", f.Manager.RecordedIsolationNode("worker"));
        Assert.Null(f.Manager.AgentInherit("worker"));
        var copied = Path.Combine(f.Manager.AgentDirectory("worker"), "memory", "COPY.md");
        Assert.Equal("one-time copied memory", await File.ReadAllTextAsync(copied));
        await File.WriteAllTextAsync(sourceMemory, "later source change");
        Assert.Equal("one-time copied memory", await File.ReadAllTextAsync(copied));
        Assert.Equal(
            "deny",
            f.Manager.AgentMetadata["worker"]!["toolRules"]![0]!["effect"]!.ToString()
        );
        var child = await f.Manager.CreateNamedAsync(
            "worker",
            "owned",
            null,
            null,
            initialNode: "master"
        );
        Assert.Equal("worker-node", f.Manager.CurrentNode(child));
        var denied = await f.ToolAsync("skill", new JsonObject { ["action"] = "list" }, child);
        Assert.Equal("tool_authorization_denied", denied!["error"]!["type"]!.ToString());
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject { ["agentName"] = "stored-rules", ["toolRules"] = new JsonArray() }
            )
        );
        Assert.Empty(f.Manager.AgentMetadata["stored-rules"]!["toolRules"]!.AsArray());
    }

    [Fact]
    public async Task Conversion_uses_the_existing_identity_move_and_keeps_aliases_children_history_and_defaults()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        var source = await f.Manager.CreateNamedAsync(
            "main",
            "convert-me",
            "Original display",
            null
        );
        await ForkClearLifecycleTests.AppendAsync(
            source,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "owned conversion history" }),
            }
        );
        var child = (
            await f.Manager.CreateChildAsync(source, "descendant", null, null, null, null)
        ).Child;
        var cache = source.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]!.ToString();
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject
                {
                    ["agentName"] = "converted",
                    ["sourceSessionId"] = source.Id,
                    ["convertSession"] = true,
                    ["inheritMemory"] = true,
                }
            )
        );
        Assert.Same(source, await f.Manager.RequiredAsync("converted/main"));
        Assert.Same(source, await f.Manager.RequiredAsync("convert-me"));
        Assert.Equal("converted/main", child.Metadata().ParentSessionId);
        Assert.Equal("Original display", source.Metadata().DisplayName);
        Assert.Equal(
            cache,
            source.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]!.ToString()
        );
        Assert.Contains(
            "owned conversion history",
            string.Join("\n", source.Entry.Snapshot().History.Select(row => row.ToJsonString()))
        );
        var invalid = await f.ToolAsync(
            "create_agent",
            new JsonObject
            {
                ["agentName"] = "invalid-conversion",
                ["convertSession"] = true,
                ["createMainSession"] = false,
            }
        );
        Assert.NotNull(invalid!["error"]);
        Assert.DoesNotContain("invalid-conversion", f.Manager.Agents());
    }

    [Fact]
    public async Task Ongoing_inheritance_rejects_an_isolated_source_at_the_shared_owner_without_forbidding_one_time_copy()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        f.Manager.Nodes.Registry.Create("retained-offline");
        await f.Manager.CreateAgentAsync("isolated-source", isolatedNode: "retained-offline");
        var memory = Path.Combine(
            f.Manager.AgentDirectory("isolated-source"),
            "memory",
            "MEMORY.md"
        );
        await File.WriteAllTextAsync(memory, "synthetic isolated source content");
        var before = f.Owner.Entry.Snapshot().AuthorityEnvelope[
            "persistentMemorySnapshot"
        ]!.ToString();
        var rejected = await f.ToolAsync(
            "set_agent_inherit",
            new JsonObject
            {
                ["agentName"] = "main",
                ["inheritAgentName"] = "isolated-source",
                ["refreshSnapshots"] = true,
            }
        );
        Assert.Contains(
            "is isolated and cannot be used as an inherit source",
            rejected!["error"]!.ToString()
        );
        Assert.Null(f.Manager.AgentInherit("main"));
        Assert.Equal(
            before,
            f.Owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.ToString()
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.SetAgentInheritAsync("main", "isolated-source")
        );
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject
                {
                    ["agentName"] = "copy-from-isolated",
                    ["sourceSessionId"] = "isolated-source/main",
                    ["inheritMemory"] = true,
                }
            )
        );
        Assert.Equal(
            "synthetic isolated source content",
            await File.ReadAllTextAsync(
                Path.Combine(f.Manager.AgentDirectory("copy-from-isolated"), "memory", "MEMORY.md")
            )
        );
        Assert.Null(f.Manager.AgentInherit("copy-from-isolated"));
        var partial = await f.ToolAsync(
            "create_agent",
            new JsonObject { ["agentName"] = "rejected-inherit", ["inherit"] = "isolated-source" }
        );
        Assert.Contains(
            "is isolated and cannot be used as an inherit source",
            partial!["error"]!.ToString()
        );
        Assert.NotNull(await f.Manager.GetExistingAsync("rejected-inherit/main"));
        Assert.Null(f.Manager.AgentInherit("rejected-inherit"));
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject { ["agentName"] = "shared", ["inherit"] = "main" }
            )
        );
        Assert.Equal("main", f.Manager.AgentInherit("shared"));
    }

    [Fact]
    public async Task Explicit_refresh_targets_an_inactive_exact_owner_and_retains_generic_target_authorization()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        var target = await f.Manager.CreateNamedAsync("main", "inactive-target", null, null);
        target.Entry.WithStateForTest(state => state.Meta["lastMessageTime"] = 1);
        await target.Entry.SaveLane.SaveStrictAsync();
        var file = Path.Combine(f.Manager.AgentDirectory("main"), "memory", "REFRESH.md");
        await File.WriteAllTextAsync(file, "new explicit refresh content");
        var callerBefore = f.Owner.Entry.Snapshot().AuthorityEnvelope[
            "persistentMemorySnapshot"
        ]!.ToString();
        Successful(
            await f.ToolAsync(
                "refresh_session_snapshot",
                new JsonObject { ["sessionId"] = target.Id }
            )
        );
        var persisted = JsonNode.Parse(
            await File.ReadAllTextAsync(target.AuthorityStore.AuthorityPath)
        )!;
        Assert.Contains(
            "new explicit refresh content",
            persisted["persistentMemorySnapshot"]!.ToString()
        );
        Assert.Equal(
            callerBefore,
            f.Owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.ToString()
        );
        Successful(
            await f.ToolAsync(
                "refresh_session_snapshot",
                new JsonObject { ["sessionId"] = f.Owner.Id }
            )
        );
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                $$"""
                version: 1
                rules:
                - id: refresh-other-denied
                  action: deny
                  match:
                    tool: {source: builtin, name: refresh_session_snapshot}
                    args: {sessionId: "{{target.Id}}"}
                """
            ),
            default
        );
        var denied = await f.ToolAsync(
            "refresh_session_snapshot",
            new JsonObject { ["sessionId"] = target.Id }
        );
        Assert.Equal("tool_authorization_denied", denied!["error"]!["type"]!.ToString());
    }

    [Fact]
    public async Task Inherited_guest_allocation_uses_base36_and_retries_an_archived_main_without_leaving_an_agent()
    {
        var channel = ExternalChannelFixture.Channel();
        channel["guestAgent"] = new JsonObject
        {
            ["agentId"] = "guest",
            ["mode"] = "inherited",
            ["isolated"] = false,
        };
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = channel }
        );
        await f.Manager.CreateAgentAsync("guest", false);
        await f.Manager.CreateAgentAsync("guest_4i");
        await f.Manager.DeleteAgentAsync("guest_4i");
        Directory.CreateDirectory(Path.Combine(f.Work, "agents", "guest_9"));
        var sourceName = await SourceAsync(
            new JsonArray(
                new JsonObject
                {
                    ["guest"] = true,
                    ["agent"] = "guest",
                    ["zone"] = "UTC",
                    ["time"] = LocalTime.ToString("O"),
                    ["random"] = new JsonArray(0.25, 0.123456789),
                    ["reserved"] = new JsonArray("guest_9"),
                }
            )
        );
        var random = new Queue<double>([0.125, 0.25, 0.123456789]);
        f.Manager.SessionNameRandom = random.Dequeue;
        var source = new ExternalChannelContext(
            "alpha",
            "telegram",
            "owned-guest",
            "11",
            "operator",
            _ => Task.CompletedTask
        );
        var created = await f.Manager.ProvisionChannelGuestAsync(source);
        Assert.NotNull(created);
        Assert.Equal(sourceName[0]!["allocated"]!.GetValue<string>() + "/main", created.Id);
        Assert.Equal("guest", f.Manager.AgentInherit(created.Agent));
        Assert.DoesNotContain("guest_4i", f.Manager.Agents());
        Assert.Empty(random);
        Assert.Equal(
            created.Id,
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
    }
}
