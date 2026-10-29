using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCreationParityTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Admitted_prompt_sources_survive_deferred_materialization_compaction_fork_and_reload(
        bool virtualModel
    )
    {
        var requests = new List<JsonObject>();
        string selectedFile = "";
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, captured) =>
            {
                requests.Add(JsonNode.Parse(captured.Body)!.AsObject());
                JsonArray output;
                if (index == 0)
                {
                    await File.WriteAllTextAsync(selectedFile, "selected prompt after compaction");
                    output = new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "function_call",
                            ["call_id"] = "compact-selected",
                            ["name"] = "submit_compact_plan",
                            ["arguments"] = new JsonObject
                            {
                                ["inContext"] = true,
                                ["replaceAsBlocks"] = new JsonArray(
                                    new JsonObject
                                    {
                                        ["level"] = 1,
                                        ["sourceKind"] = "message",
                                        ["sourceStart"] = 1,
                                        ["sourceEnd"] = 1,
                                        ["summary"] = "Earlier selected work.",
                                    }
                                ),
                            }.ToJsonString(),
                        }
                    );
                }
                else
                    output = new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["content"] = new JsonArray(
                                new JsonObject { ["type"] = "output_text", ["text"] = "Done." }
                            ),
                        }
                    );
                var response = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "prompt-lifecycle-" + index,
                        ["output"] = output,
                        ["usage"] = new JsonObject
                        {
                            ["input_tokens"] = 50,
                            ["output_tokens"] = 10,
                        },
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + response.ToJsonString() + "\n\n")
                );
            }
        );
        await using var f = await ExternalChannelFixture.CreateAsync(provider: peer.BaseUri);
        RegisterAgentTools(f);
        var models = JsonNode
            .Parse(await File.ReadAllTextAsync(Path.Combine(f.Data, "state", "models.yaml")))!
            .AsObject();
        models["providers"]!["virtual"] = new JsonObject
        {
            ["providerType"] = "session-hash",
            ["targets"] = new JsonArray("local/wire"),
        };
        await f.Configuration.InstallAsync(
            "models",
            _ => Task.FromResult(Encoding.UTF8.GetBytes(models.ToJsonString()))
        );
        f.Manager.Nodes.Registry.Create("prompt-bound");
        await f.Manager.CreateAgentAsync("restricted", false, isolatedNode: "prompt-bound");
        selectedFile = Path.Combine(f.Data, "selected.md");
        await File.WriteAllTextAsync(selectedFile, "selected prompt before dispatch");
        Successful(
            await f.ToolAsync(
                "create_session",
                new JsonObject
                {
                    ["agentName"] = "restricted",
                    ["sessionName"] = "selected",
                    ["forceModel"] = new JsonObject
                    {
                        ["modelId"] = virtualModel ? "virtual" : "local/wire",
                    },
                    ["systemPromptFiles"] = new JsonArray(selectedFile),
                }
            )
        );
        var owner = await f.Manager.RequiredAsync("restricted/selected");
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        string Snapshot(SessionOwner target) =>
            target.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.ToString();
        if (virtualModel)
        {
            Assert.Equal("", Snapshot(owner));
            Assert.Null(await f.Manager.RefreshSnapshotAsync(owner));
            Assert.Equal("", Snapshot(owner));
        }
        else
            Assert.Contains("selected prompt before dispatch", Snapshot(owner));
        foreach (var text in new[] { "Earlier work.", "Retained work.", "Latest context." })
        {
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText(text));
            await owner
                .Registry.HostFor(owner.Id)
                .AppendQueuedInputsAsync(owner.Entry.State.Queue.ToArray());
        }
        await owner.Registry.Ingress.EnqueueAsync(
            owner.Id,
            QueueItem.UserText("Compact earlier work.")
        );
        await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(2, requests.Count);
        Assert.Contains("selected prompt before dispatch", requests[0].ToJsonString());
        Assert.Contains("selected prompt after compaction", requests[1].ToJsonString());
        Assert.Equal("local/wire", ConditionalMemory.ReadCurrentModelSnapshotId(Snapshot(owner)));
        Assert.Single(owner.Archive.ReadBlocks());
        Assert.Contains("selected prompt after compaction", Snapshot(owner));
        var fork = await f.Manager.ForkAsync(owner, "copy");
        Assert.Equal(Snapshot(owner), Snapshot(fork));
        Assert.Equal(
            AgentMemory.Selection(owner.Entry.Snapshot().AuthorityEnvelope),
            AgentMemory.Selection(fork.Entry.Snapshot().AuthorityEnvelope)
        );
        await File.WriteAllTextAsync(selectedFile, "selected prompt after fork refresh");
        await f.Manager.RefreshSnapshotAsync(fork);
        Assert.Contains("selected prompt after fork refresh", Snapshot(fork));
        Assert.Contains("selected prompt after compaction", Snapshot(owner));
        var child = (
            await f.Manager.CreateChildAsync(owner, "fresh", null, null, null, null)
        ).Child;
        Assert.Equal(
            [selectedFile],
            AgentMemory.Selection(child.Entry.Snapshot().AuthorityEnvelope)
        );
        if (!virtualModel)
            Assert.Contains("selected prompt after fork refresh", Snapshot(child));

        await f.Manager.ShutdownAsync();
        await using var reopened = new SessionManager(
            f.Data,
            f.Work,
            new ResponsesClientOptions(peer.BaseUri, "wire", "", "", "", 1024),
            f.Configuration.Models
        );
        await reopened.LoadMainHostAsync();
        var restored = await reopened.RequiredAsync(owner.Id);
        Assert.Equal(
            [selectedFile],
            AgentMemory.Selection(restored.Entry.Snapshot().AuthorityEnvelope)
        );
        Assert.Contains("selected prompt after compaction", Snapshot(restored));
        await reopened.RefreshSnapshotAsync(restored);
        Assert.Contains("selected prompt after fork refresh", Snapshot(restored));
        Assert.Equal(
            "local/wire",
            ConditionalMemory.ReadCurrentModelSnapshotId(Snapshot(restored))
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Denied_prompt_admission_precedes_creation_even_with_virtual_model_deferral(
        bool virtualModel
    )
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        var models = JsonNode
            .Parse(await File.ReadAllTextAsync(Path.Combine(f.Data, "state", "models.yaml")))!
            .AsObject();
        models["providers"]!["virtual"] = new JsonObject
        {
            ["providerType"] = "session-hash",
            ["targets"] = new JsonArray("local/wire"),
        };
        await f.Configuration.InstallAsync(
            "models",
            _ => Task.FromResult(Encoding.UTF8.GetBytes(models.ToJsonString()))
        );
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                """
                version: 1
                rules:
                - id: no-main-reads
                  action: deny
                  match:
                    tool: {source: node, name: read}
                    targetNode: master
                """
            ),
            default
        );
        var published = false;
        f.Manager.BeforeCreationPublication = _ =>
        {
            published = true;
            return Task.CompletedTask;
        };
        var response = await f.ToolAsync(
            "create_session",
            new JsonObject
            {
                ["agentName"] = "main",
                ["sessionName"] = "denied-selection",
                ["forceModel"] = new JsonObject
                {
                    ["modelId"] = virtualModel ? "virtual" : "local/wire",
                },
                ["systemPromptFiles"] = new JsonArray(Path.Combine(f.Data, "not-read.md")),
            }
        );
        Assert.Contains(
            "Tool authorization rule denies node capability `read`",
            response!["error"]!["message"]!.GetValue<string>()
        );
        Assert.False(published);
        Assert.Null(f.Manager.Catalog.Get("denied-selection"));
        Assert.Null(await f.Manager.GetExistingAsync("denied-selection"));
        Assert.False(
            File.Exists(Path.Combine(f.Data, "state", "sessions", "denied-selection.json"))
        );
        // An explicit empty selection performs no file reads, even for a read-restricted creator.
        Successful(
            await f.ToolAsync(
                "create_session",
                new JsonObject
                {
                    ["agentName"] = "main",
                    ["sessionName"] = "empty-selection",
                    ["systemPromptFiles"] = new JsonArray(),
                }
            )
        );
        Assert.Empty(
            AgentMemory.Selection(
                (await f.Manager.RequiredAsync("empty-selection"))
                    .Entry.Snapshot()
                    .AuthorityEnvelope
            )!
        );
    }
}
