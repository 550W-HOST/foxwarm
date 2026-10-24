using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ModelUsageCostTests
{
    [Fact]
    public async Task Priced_usage_and_failure_survive_cold_projection_then_recover_fork_and_clear_independently()
    {
        var recovering = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedResponsesSequenceServer(
            4,
            async (index, stream, _) =>
            {
                if (index == 2)
                {
                    recovering.TrySetResult();
                    await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
                }
                var failed = index is 1 or 3;
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    failed ? 400 : 200,
                    failed ? "application/json" : "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        failed ? "{\"error\":{\"message\":\"owned terminal failure\"}}" : Body("openai-responses")
                    )
                );
            }
        );
        using var temp = new TempDirectory();
        var config = new ModelConfiguration(HostPaths.ForDataRoot(temp.Path, environment: _ => null));
        await config.SaveAsync(new JsonObject
        {
            ["yaml"] = Document(peer.BaseUri, "openai-responses").ToJsonString(),
        });
        var models = new HostModels(config);
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "priced/wire", "", "", 713);
        var workspace = Path.Combine(temp.Path, "work");
        string id;
        async Task Run(SessionOwner owner)
        {
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("next"));
            await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(20));
        }
        static void AssertCost(JsonNode? amount) => Assert.Equal(.000027, SessionCatalog.Number(amount)!.Value, 10);

        await using (var first = new SessionManager(temp.Path, workspace, options, models))
        {
            await first.LoadAsync();
            var owner = await first.CreateNamedAsync("main", "combined", null, null);
            id = owner.Id;
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await Run(owner);
            var paidStats = owner.Entry.Snapshot().AuthorityEnvelope["stats"]!.DeepClone();
            AssertCost(paidStats["totalCost"]);
            await Run(owner);
            Assert.True(owner.Metadata().LlmFailed);
            AssertCost(JsonValue.Create(owner.Metadata().Cost));
            Assert.Equal("llm-failed", owner.RuntimeSnapshot()["state"]!.GetValue<string>());
            Assert.True(JsonNode.DeepEquals(paidStats, owner.Entry.Snapshot().AuthorityEnvelope["stats"]));
            var saved = (await new PersistentSessionAuthorityStore(temp.Path, id).LoadAsync(id))!;
            Assert.True(saved.Meta["llmFailed"]!.GetValue<bool>());
            AssertCost(saved.AuthorityEnvelope["stats"]?["totalCost"]);
        }

        await using var manager = new SessionManager(temp.Path, workspace, options, models);
        await manager.LoadAsync();
        Assert.Empty(manager.Owners());
        var runtime = new SessionRuntime(manager);
        runtime.SemanticOwnerLookupObserved = _ => throw new InvalidOperationException("Cold projection attempted owner lookup.");
        var queries = new SessionListQueries(runtime);
        var cold = queries.Projection(id)!;
        Assert.Equal("llm-failed", cold["runtimeState"]!["state"]!.GetValue<string>());
        AssertCost(cold["tokenUsage"]?["cost"]);
        AssertCost(queries.GlobalSummary()["cost"]);
        Assert.Empty(manager.Owners());

        var reloaded = await manager.RequiredAsync(id);
        reloaded.Registry.TriggerOverride = _ => Task.CompletedTask;
        Assert.True(reloaded.Metadata().LlmFailed);
        AssertCost(JsonValue.Create(reloaded.Metadata().Cost));
        var fork = await manager.ForkAsync(reloaded, "fresh");
        Assert.False(fork.Metadata().LlmFailed);
        Assert.Null(fork.Metadata().Cost);
        Assert.Contains(fork.History(), row => row["__meta"]?["usage"]?["cost"] is not null);
        AssertCost(queries.GlobalSummary()["cost"]);

        await config.SaveAsync(new JsonObject
        {
            ["yaml"] = Document(peer.BaseUri, "openai-responses", 0).ToJsonString(),
        });
        var recovery = Run(reloaded);
        try
        {
            await recovering.Task.WaitAsync(TimeSpan.FromSeconds(15));
            Assert.True(reloaded.Metadata().Busy);
            Assert.False(reloaded.Metadata().LlmFailed);
            AssertCost(JsonValue.Create(reloaded.Metadata().Cost));
        }
        finally
        {
            release.TrySetResult();
            await recovery;
        }
        Assert.Equal("idle", reloaded.RuntimeSnapshot()["state"]!.GetValue<string>());
        AssertCost(reloaded.Entry.Snapshot().AuthorityEnvelope["stats"]?["totalCost"]);
        Assert.Equal(0, SessionCatalog.Number(reloaded.Entry.Snapshot().AuthorityEnvelope["stats"]?["lastUsage"]?["cost"]));
        await Run(reloaded);
        Assert.True(reloaded.Metadata().LlmFailed);
        await manager.ClearAsync(reloaded);
        Assert.False(reloaded.Metadata().LlmFailed);
        AssertCost(JsonValue.Create(reloaded.Metadata().Cost));
        var cleared = manager.Catalog.Get(id)!;
        Assert.Null(cleared["meta"]?["llmFailed"]);
        AssertCost(cleared["stats"]?["totalCost"]);
        var clearedSaved = (await new PersistentSessionAuthorityStore(temp.Path, id).LoadAsync(id))!;
        Assert.Null(clearedSaved.Meta["llmFailed"]);
        AssertCost(clearedSaved.AuthorityEnvelope["stats"]?["totalCost"]);
        Assert.Equal(4, peer.RequestCount);
    }
}
