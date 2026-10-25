using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using SdkClient = ModelContextProtocol.Client.McpClient;

namespace Foxwarm.Tests;

public sealed class InboundMcpLifetimeTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Actual_strict_Session_failure_never_reports_accepted_and_retains_only_the_committed_outcome(
        bool renamed
    )
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var client = await f.ClientAsync();
        f.WriteStage = (id, stage) =>
        {
            if (
                id != f.Target.Id
                || stage
                    != (
                        renamed
                            ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                            : AtomicJsonWriteStage.BeforeRename
                    )
            )
                return;
            f.WriteStage = null;
            throw new IOException("Owned strict admission write failure.");
        };
        var result = await InboundMcpFixture.CallAsync(
            client,
            "foxwarm_session",
            new JsonObject
            {
                ["action"] = "send",
                ["sessionId"] = f.Target.Id,
                ["message"] = "strict-one",
            }
        );
        Assert.True(result["isError"]!.GetValue<bool>());
        Assert.Null(result["structuredContent"]?["accepted"]);
        Assert.Equal(renamed ? 1 : 0, f.Target.Entry.Snapshot().Queue.Count);
        var persisted = JsonNode.Parse(
            File.ReadAllText(Path.Combine(f.Data, "state", "sessions", f.Target.Id + ".json"))
        )!;
        Assert.Equal(
            renamed,
            persisted.ToJsonString().Contains("strict-one", StringComparison.Ordinal)
        );
    }

    [Fact]
    public async Task Strict_admission_rechecks_authority_after_awaited_preparation_and_does_not_publish_hot_before_durability()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(
            store,
            new FakeChatService(),
            migrateGoal: async snapshot =>
            {
                entered.TrySetResult();
                await release.Task;
                return snapshot;
            }
        )
        {
            TriggerOverride = _ => Task.CompletedTask,
        };
        var entry = registry.Add("target");
        entry.WithState(state =>
            state.AuthorityEnvelope["goalState"] = new JsonObject { ["legacy"] = true }
        );
        var active = true;
        var send = registry.Ingress.EnqueueExternalAsync(
            "target",
            QueueItem.UserText("no-late-admission"),
            () =>
            {
                if (!active)
                    throw new McpInboundSafeException("revoked");
            }
        );
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Empty(entry.Snapshot().Queue);
        active = false;
        release.TrySetResult();
        await Assert.ThrowsAsync<McpInboundSafeException>(() => send);
        Assert.Empty(entry.Snapshot().Queue);
        Assert.Empty(store.Calls);
        entry.WithState(state => state.AuthorityEnvelope.Remove("goalState"));
        store.Hold("target");
        var accepted = registry.Ingress.EnqueueExternalAsync(
            "target",
            QueueItem.UserText("durable-first"),
            () => { }
        );
        await store.WaitForCommitAsync("target").WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(accepted.IsCompleted);
        Assert.Empty(entry.Snapshot().Queue);
        store.Release("target");
        await accepted;
        Assert.Single(entry.Snapshot().Queue);
        Assert.Single((await store.LoadAsync("target"))!.Queue);
        Assert.All(store.Calls, call => Assert.Equal(SaveKind.Strict, call.Kind));
    }

    [Fact]
    public async Task Actual_external_Session_waiting_in_the_lane_rechecks_live_context_canonical_target_and_policy()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        var principal = McpExternalPrincipal.Authenticate(
            f.Configuration.Access,
            InboundMcpFixture.Alpha
        )!;
        var context = new McpExternalContext(principal);
        var runtime = new SessionRuntime(f.Manager);
        var observed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        runtime.SemanticOwnerLookupObserved = _ => observed.TrySetResult();
        var service = new McpInboundSessions(runtime, new(f.Manager.Authorization, f.Work));
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var earlier = f.Target.Entry.SaveLane.MutateIdentityAsync(async () =>
        {
            entered.TrySetResult();
            await release.Task;
        });
        await entered.Task;
        var send = service.SendAsync(context, f.Target.Id, "must-not-enter", false, default);
        await observed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(send.IsCompleted);
        await f.PolicyAsync("version: 1\nrules: []\n");
        release.TrySetResult();
        await earlier;
        await Assert.ThrowsAsync<McpInboundSafeException>(() => send);
        Assert.Empty(f.Target.Entry.Snapshot().Queue);
        Assert.DoesNotContain(
            "must-not-enter",
            File.ReadAllText(Path.Combine(f.Data, "state", "sessions", f.Target.Id + ".json"))
        );
        context.Fence();
        context.Lifetime.Dispose();
    }

    [Fact]
    public async Task Body_result_and_concurrent_request_budgets_keep_initialized_effects_single_and_context_reusable()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var peer = await OutboundSdkPeer.StartAsync(Path.Combine(f.Temp.Path, "peer"));
        await f.Manager.OutboundMcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "peer",
                ["url"] = peer.Url + "/mcp",
                ["transport"] = "streamable-http",
            },
            default
        );
        await using var client = await f.ClientAsync(standaloneGet: false);
        var small = await InboundMcpFixture.ConcreteAsync(
            client,
            "mcp:peer/result",
            new JsonObject
            {
                ["kind"] = "large",
                ["length"] = 35 * 1024,
                ["tag"] = "allowed",
            }
        );
        Assert.Equal(35 * 1024, small["content"]![0]!["text"]!.GetValue<string>().Length);
        var huge = await InboundMcpFixture.ConcreteAsync(
            client,
            "mcp:peer/result",
            new JsonObject
            {
                ["kind"] = "large",
                ["length"] = 9 * 1024 * 1024,
                ["tag"] = "oversized",
            }
        );
        Assert.True(huge["isError"]!.GetValue<bool>());
        Assert.Contains("may have completed", huge["content"]![0]!["text"]!.GetValue<string>());
        Assert.Single(
            await peer.EventsAsync(),
            row =>
                row["kind"]?.GetValue<string>() == "effect"
                && row["tag"]?.GetValue<string>() == "oversized"
        );
        using (
            var tooLarge = f.Request(
                "POST",
                client.SessionId,
                body: "{\"padding\":\"" + new string('x', McpInboundHttp.MaxBodyBytes) + "\"}"
            )
        )
        {
            tooLarge.Headers.ExpectContinue = true;
            Assert.Equal(
                HttpStatusCode.RequestEntityTooLarge,
                (await f.Http.SendAsync(tooLarge)).StatusCode
            );
        }
        // This client explicitly disables its optional GET; four held POSTs exhaust the four-request bound.
        var held = Enumerable
            .Range(0, 4)
            .Select(i =>
                InboundMcpFixture.ConcreteAsync(
                    client,
                    "mcp:peer/hold",
                    new JsonObject { ["tag"] = "concurrent-" + i }
                )
            )
            .ToArray();
        await peer.WaitAsync("effect", count: 6); // two earlier result effects and these four held POSTs.
        using (
            var excess = f.Request(
                "POST",
                client.SessionId,
                body: "{\"jsonrpc\":\"2.0\",\"id\":77,\"method\":\"tools/list\"}"
            )
        )
            Assert.Equal(
                HttpStatusCode.TooManyRequests,
                (await f.Http.SendAsync(excess)).StatusCode
            );
        foreach (var i in Enumerable.Range(0, 4))
            await peer.ReleaseAsync("concurrent-" + i);
        await Task.WhenAll(held).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.NotNull(await client.ListToolsAsync(new ListToolsRequestParams()));
    }

    [Fact]
    public async Task Production_capacity_is_32_live_contexts_and_DELETE_releases_a_slot()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        var clients = new List<SdkClient>();
        try
        {
            for (var i = 0; i < 32; i++)
                clients.Add(await f.ClientAsync());
            using var init = f.Request(
                "POST",
                null,
                body: "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"capacity\",\"version\":\"1\"}}}"
            );
            Assert.Equal(
                HttpStatusCode.ServiceUnavailable,
                (await f.Http.SendAsync(init)).StatusCode
            );
            using var deletion = f.Request("DELETE", clients[0].SessionId);
            Assert.Equal(HttpStatusCode.OK, (await f.Http.SendAsync(deletion)).StatusCode);
            clients.Add(await f.ClientAsync());
            Assert.NotNull(await clients[^1].ListToolsAsync(new ListToolsRequestParams()));
        }
        finally
        {
            foreach (var client in clients)
                await client.DisposeAsync();
        }
    }
}
