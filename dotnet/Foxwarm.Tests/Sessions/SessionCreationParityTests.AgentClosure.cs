using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCreationParityTests
{
    private static string ClosureModels(bool includeRetained, bool virtualDefault = false) =>
        $$"""
            default: {{(virtualDefault ? "route" : "local/fallback")}}
            providers:
              local:
                providerType: openai-responses
                baseUrl: http://127.0.0.1:1/v1/
                models:
                  - id: fallback
                    effort: {allowed: [low], default: low}
            {{(
                includeRetained
                    ? "      - id: retained\n        effort: {allowed: [low, high], default: high}"
                    : ""
            )}}
              route:
                providerType: session-hash
                targets: [local/fallback]
            """;

    [Theory]
    [InlineData(false, "low", "low")]
    [InlineData(false, "high", null)]
    [InlineData(true, "low", "low")]
    public async Task Agent_main_retains_removed_configured_raw_model_while_normalizing_effort_and_resolving_current_fallback(
        bool virtualDefault,
        string sourceEffort,
        string? expectedEffort
    )
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        await f.Configuration.SaveAsync(new JsonObject { ["yaml"] = ClosureModels(true) });
        f.Owner = await f.Manager.CreateNamedAsync(
            "main",
            "retained-caller",
            null,
            new JsonObject { ["modelId"] = "local/retained", ["effort"] = sourceEffort }
        );
        await f.Configuration.SaveAsync(
            new JsonObject { ["yaml"] = ClosureModels(false, virtualDefault) }
        );
        Assert.False(f.Manager.Models.Contains("local/retained"));
        Assert.Equal("local/retained", f.Owner.Metadata().Model);
        Successful(
            await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "retained-copy" })
        );
        var created = await f.Manager.RequiredAsync("retained-copy/main");
        var disk = JsonNode
            .Parse(await File.ReadAllTextAsync(created.AuthorityStore.AuthorityPath))!
            .AsObject();
        Assert.Equal("local/retained", SessionWait.Text(disk["model"]));
        Assert.Equal(expectedEffort, SessionWait.Text(disk["effort"]));
        var selection = f.Manager.Models.Select(disk);
        Assert.Equal(virtualDefault ? "route" : "local/fallback", selection.Model.Key);
        Assert.Equal("low", selection.EffectiveEffort);
        var snapshot = SessionWait.Text(disk["persistentMemorySnapshot"])!;
        if (virtualDefault)
            Assert.Equal("", snapshot);
        else
            Assert.Equal("local/fallback", ConditionalMemory.ReadCurrentModelSnapshotId(snapshot));

        // Neither ordinary creation nor newly explicit force-model inputs acquire this raw-settings contract.
        Successful(
            await f.ToolAsync(
                "create_session",
                new JsonObject { ["agentName"] = "main", ["sessionName"] = "ordinary-stale" }
            )
        );
        Assert.Null((await f.Manager.RequiredAsync("ordinary-stale")).Metadata().Model);
        var rejected = await f.ToolAsync(
            "create_session",
            new JsonObject
            {
                ["agentName"] = "main",
                ["sessionName"] = "unknown-explicit",
                ["forceModel"] = new JsonObject { ["modelId"] = "local/retained" },
            }
        );
        Assert.NotNull(rejected!["error"]);
        Assert.Null(await f.Manager.GetExistingAsync("unknown-explicit"));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.CreateNamedAsync(
                "main",
                "unknown-owner",
                null,
                new JsonObject { ["modelId"] = "local/retained" }
            )
        );

        await f.Configuration.SaveAsync(
            new JsonObject { ["yaml"] = ClosureModels(true, virtualDefault) }
        );
        selection = f.Manager.Models.Select(created.Entry.Snapshot());
        Assert.Equal("local/retained", selection.Model.Key);
        Assert.Equal(expectedEffort ?? "high", selection.EffectiveEffort);
        Successful(
            await f.ToolAsync(
                "refresh_session_snapshot",
                new JsonObject { ["sessionId"] = created.Id }
            )
        );
        var refreshed = created.Entry.Snapshot().AuthorityEnvelope;
        // A concrete recorded snapshot stays truthful; deferred virtual fallback can now materialize the restored key.
        Assert.Equal(
            virtualDefault ? "local/retained" : "local/fallback",
            ConditionalMemory.ReadCurrentModelSnapshotId(
                SessionWait.Text(refreshed["persistentMemorySnapshot"])!
            )
        );
        Assert.Equal("local/retained", SessionWait.Text(refreshed["model"]));
        Assert.Equal(
            "local/retained",
            SessionWait.Text(
                JsonNode.Parse(await File.ReadAllTextAsync(created.AuthorityStore.AuthorityPath))![
                    "model"
                ]
            )
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Nonisolated_agent_conversion_admits_an_isolated_source_through_shared_identity_effects(
        bool bindTarget
    )
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        await f.Configuration.SaveAsync(new JsonObject { ["yaml"] = ClosureModels(true) });
        f.Manager.Nodes.Registry.Create("source-offline");
        f.Manager.Nodes.Registry.Create("target-offline");
        await f.Manager.CreateAgentAsync("isolated-convert", isolatedNode: "source-offline");
        var source = await f.Manager.RequiredAsync("isolated-convert/main");
        await source.Entry.SaveLane.CommitSettingsAsync(
            new JsonObject
            {
                ["model"] = "local/retained",
                ["effort"] = "high",
                ["childModelDefault"] = "local/fallback",
                ["childEffortDefault"] = "low",
            },
            f.Manager.Models
        );
        await ForkClearLifecycleTests.AppendAsync(
            source,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject { ["text"] = "isolated conversion history" }
                ),
            }
        );
        var child = (
            await f.Manager.CreateChildAsync(source, "descendant", null, null, null, null)
        ).Child;
        var oldId = source.Id;
        await f.Manager.MoveIdentityAsync(source, new JsonObject { ["newSessionId"] = "selected" });
        var selectedId = source.Id;
        f.Manager.AttachChannel("webui:conversion-proof", source);
        var copiedFile = Path.Combine(
            f.Manager.AgentDirectory("isolated-convert"),
            "memory",
            "COPY.md"
        );
        await File.WriteAllTextAsync(copiedFile, "conversion one-time copy");
        var before = source.Entry.Snapshot();
        var args = new JsonObject
        {
            ["agentName"] = "converted-isolated",
            ["sourceSessionId"] = oldId,
            ["convertSession"] = true,
            ["inheritMemory"] = true,
            ["toolRules"] = new JsonArray(),
        };
        if (bindTarget)
            args["isolatedNode"] = "target-offline";
        Successful(await f.ToolAsync("create_agent", args));
        Assert.Same(source, await f.Manager.RequiredAsync("converted-isolated/main"));
        Assert.Same(source, await f.Manager.RequiredAsync(oldId));
        Assert.Same(source, await f.Manager.RequiredAsync(selectedId));
        Assert.Equal("converted-isolated/main", child.Metadata().ParentSessionId);
        Assert.Equal(
            source.Id,
            SessionWait.Text(f.Manager.ChannelBinding("webui:conversion-proof")?["sessionId"])
        );
        Assert.True(f.Manager.AgentIsolated("isolated-convert"));
        Assert.Equal(bindTarget, f.Manager.AgentIsolated(source.Agent));
        Assert.Equal(
            bindTarget ? "target-offline" : "source-offline",
            f.Manager.CurrentNode(source)
        );
        Assert.Empty(f.Manager.AgentMetadata[source.Agent]!["toolRules"]!.AsArray());
        Assert.Null(f.Manager.AgentInherit(source.Agent));
        Assert.Equal(
            "conversion one-time copy",
            await File.ReadAllTextAsync(
                Path.Combine(f.Manager.AgentDirectory(source.Agent), "memory", "COPY.md")
            )
        );
        var after = source.Entry.Snapshot();
        Assert.Equal(
            before.History.Select(row => row.ToJsonString()),
            after.History.Select(row => row.ToJsonString())
        );
        foreach (
            var field in new[]
            {
                "model",
                "effort",
                "childModelDefault",
                "childEffortDefault",
                "promptCacheKey",
            }
        )
            Assert.Equal(
                before.AuthorityEnvelope[field]?.ToJsonString(),
                after.AuthorityEnvelope[field]?.ToJsonString()
            );
        var disk = JsonNode.Parse(
            await File.ReadAllTextAsync(source.AuthorityStore.AuthorityPath)
        )!;
        Assert.Equal("converted-isolated", SessionWait.Text(disk["agent"]));
        Assert.Equal("local/retained", SessionWait.Text(disk["model"]));
        Assert.Contains(oldId, disk["aliases"]!.AsArray().Select(SessionWait.Text));
        Assert.Contains(selectedId, disk["aliases"]!.AsArray().Select(SessionWait.Text));
        Assert.False(File.Exists(Path.Combine(f.Data, "state", "sessions", selectedId + ".json")));
    }

    [Fact]
    public async Task Agent_conversion_keeps_authorization_ordinary_move_isolation_reservation_and_shared_failure_fences()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        f.Manager.Nodes.Registry.Create("source-offline");
        await f.Manager.CreateAgentAsync("isolated-guard", isolatedNode: "source-offline");
        var source = await f.Manager.RequiredAsync("isolated-guard/main");
        var child = (
            await f.Manager.CreateChildAsync(source, "child", null, null, null, null)
        ).Child;
        f.Manager.AttachChannel("webui:guard-proof", source);
        var outward = await f.ToolAsync(
            "move_session",
            new JsonObject
            {
                ["sessionId"] = source.Id,
                ["createAgent"] = true,
                ["newAgentName"] = "ordinary-outward",
            }
        );
        Assert.Contains("Isolated Agents cannot move", outward!["error"]!.ToString());
        Assert.DoesNotContain("ordinary-outward", f.Manager.Agents());
        var inward = await f.ToolAsync(
            "move_session",
            new JsonObject { ["newSessionId"] = "inward", ["newAgentName"] = "isolated-guard" }
        );
        Assert.Contains("Isolated Agents cannot move", inward!["error"]!.ToString());
        Assert.Null(await f.Manager.GetExistingAsync("isolated-guard/inward"));
        var isolatedCaller = await f.ToolAsync(
            "create_agent",
            new JsonObject
            {
                ["agentName"] = "isolated-caller-denied",
                ["convertSession"] = true,
                ["sourceSessionId"] = f.Owner.Id,
            },
            source
        );
        Assert.NotNull(isolatedCaller!["error"]);
        Assert.DoesNotContain("isolated-caller-denied", f.Manager.Agents());

        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                """
                version: 1
                rules:
                - id: conversion-denied
                  action: deny
                  match:
                    tool: {source: builtin, name: create_agent}
                    args: {agentName: policy-denied}
                """
            ),
            default
        );
        var denied = await f.ToolAsync(
            "create_agent",
            new JsonObject
            {
                ["agentName"] = "policy-denied",
                ["sourceSessionId"] = source.Id,
                ["convertSession"] = true,
            }
        );
        Assert.Equal("tool_authorization_denied", denied!["error"]!["type"]!.ToString());
        Assert.DoesNotContain("policy-denied", f.Manager.Agents());
        await f.Manager.CreateAgentAsync("reserved-conversion");
        await f.Manager.DeleteAgentAsync("reserved-conversion");
        var reserved = await f.ToolAsync(
            "create_agent",
            new JsonObject
            {
                ["agentName"] = "reserved-conversion",
                ["sourceSessionId"] = source.Id,
                ["convertSession"] = true,
            }
        );
        Assert.NotNull(reserved!["error"]);
        Assert.DoesNotContain("reserved-conversion", f.Manager.Agents());

        f.Manager.BeforeIdentityStage = (_, stage) =>
            stage == "after-target-persistence"
                ? Task.FromException(new IOException("Owned conversion persistence fault."))
                : Task.CompletedTask;
        var failed = await f.ToolAsync(
            "create_agent",
            new JsonObject
            {
                ["agentName"] = "failed-conversion",
                ["sourceSessionId"] = source.Id,
                ["convertSession"] = true,
            }
        );
        Assert.Contains("rolled back", failed!["error"]!.ToString());
        Assert.Equal("isolated-guard/main", source.Id);
        Assert.Same(source, await f.Manager.RequiredAsync(source.Id));
        Assert.Equal(source.Id, child.Metadata().ParentSessionId);
        Assert.Equal(
            source.Id,
            SessionWait.Text(f.Manager.ChannelBinding("webui:guard-proof")?["sessionId"])
        );
        Assert.DoesNotContain("failed-conversion", f.Manager.Agents());
        Assert.False(File.Exists(Path.Combine(f.Data, "state", "session-id-move-pending.json")));
    }
}
