using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace Foxwarm.Tests;

public sealed partial class McpNotificationTests
{
    [Fact]
    public async Task Same_context_GET_disconnect_reconnect_drops_offline_sends_and_does_not_replay()
    {
        using var disconnect = new CancellationTokenSource();
        var ended = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reconnect = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var gets = 0;
        await using var peer = await InboundMcpFixture.CreateAsync(configure: app => app.Use(async (http, next) =>
        {
            if (http.Request.Method != "GET")
            {
                await next(http);
                return;
            }
            var index = Interlocked.Increment(ref gets);
            using var abort = index == 1 ? disconnect.Token.Register(http.Abort) : default;
            if (index > 1)
                await reconnect.Task.WaitAsync(http.RequestAborted);
            try { await next(http); }
            finally { if (index == 1) ended.TrySetResult(); }
        }));
        await using var f = await OutboundMcpFixture.CreateAsync();
        await Connect(f, peer);
        Assert.Equal("receiving", State(await Notifications(f, "start")));
        var target = Target(await f.CallAsync(f.First, "foxwarm_session", Send(peer.Target.Id, "one")));
        Assert.Null((await Reply(peer, target, "before"))!["error"]);
        await Until(() => Queue(f.First).Length == 1);
        disconnect.Cancel();
        await ended.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Until(() => State(Notifications(f, "status").GetAwaiter().GetResult()) == "disconnected");
        Assert.NotNull((await Reply(peer, target, "offline"))!["error"]);
        Assert.NotNull((await f.CallAsync(f.First, "foxwarm_session", Send(peer.Target.Id, "offline-input")))!["error"]);
        Assert.Single(Queue(peer.Target));
        reconnect.TrySetResult();
        await Until(() => State(Notifications(f, "status").GetAwaiter().GetResult()) == "receiving");
        Assert.Equal(target, Target(await f.CallAsync(f.First, "foxwarm_session", Send(peer.Target.Id, "same-context"))));
        Assert.Null((await Reply(peer, target, "after"))!["error"]);
        await Until(() => Queue(f.First).Length == 2);
        Assert.Equal(new[] { "before", "after" }, Queue(f.First).Select(item => item.Parts![1]["text"]!.GetValue<string>()));
        Assert.Equal(2, gets);
    }

    [Fact]
    public async Task Lost_remote_context_retires_reception_and_later_calls_do_not_replay_the_original_input()
    {
        await using var peer = await InboundMcpFixture.CreateAsync();
        await using var f = await OutboundMcpFixture.CreateAsync();
        await Connect(f, peer);
        await Notifications(f, "start");
        var target = Target(await f.CallAsync(f.First, "foxwarm_session", Send(peer.Target.Id, "original-once")));
        var contextId = target[4..target.IndexOf(':')];
        using var deletion = peer.Request("DELETE", contextId);
        using var response = await peer.Http.SendAsync(deletion);
        Assert.True(response.IsSuccessStatusCode);
        await Until(() => State(Notifications(f, "status").GetAwaiter().GetResult()) == "stopped");
        Assert.NotNull((await Reply(peer, target, "lost context"))!["error"]);
        var later = await f.CallAsync(f.First, "foxwarm_session", Send(peer.Target.Id, "later-once", false));
        Assert.True(later!["accepted"]!.GetValue<bool>());
        Assert.Equal(new[] { "original-once", "later-once" }, Queue(peer.Target).Select(item => item.Parts![1]["text"]!.GetValue<string>()));
        await Notifications(f, "start");
        var successor = Target(await f.CallAsync(f.First, "foxwarm_session", Send(peer.Target.Id, "successor")));
        Assert.NotEqual(target, successor);
        Assert.Empty(Queue(f.First));
    }

    [Fact]
    public async Task Official_Csharp_client_requires_capability_and_real_GET_and_read_old_reply_uses_same_channel()
    {
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = await InboundMcpFixture.CreateAsync(configure: app => app.Use(async (http, next) =>
        {
            if (http.Request.Method == "GET")
                http.Response.OnStarting(() => { ready.TrySetResult(); return Task.CompletedTask; });
            await next(http);
        }));
        await using var ordinary = await peer.ClientAsync(standaloneGet: false);
        Assert.True((await InboundMcpFixture.CallAsync(ordinary, "foxwarm_session", Send(peer.Target.Id, "no-capability")))["isError"]!.GetValue<bool>());
        var received = new TaskCompletionSource<JsonRpcNotification>(TaskCreationOptions.RunContinuationsAsynchronously);
        McpClientOptions Options() => new()
        {
            ProtocolVersion = "2025-11-25",
            Capabilities = new() { Experimental = Foxwarm.McpClient.NotificationCapability() },
            Handlers = new()
            {
                NotificationHandlers = [new KeyValuePair<string, Func<JsonRpcNotification, CancellationToken, ValueTask>>(Foxwarm.McpClient.SessionMessageMethod, (notification, _) => { received.TrySetResult(notification); return ValueTask.CompletedTask; })],
            },
        };
        await using var noGet = await peer.ClientAsync(standaloneGet: false, options: Options());
        Assert.True((await InboundMcpFixture.CallAsync(noGet, "foxwarm_session", Send(peer.Target.Id, "no-GET")))["isError"]!.GetValue<bool>());
        Assert.Empty(Queue(peer.Target));
        await using var official = await peer.ClientAsync(options: Options());
        await ready.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await official.ListToolsAsync(new ListToolsRequestParams());
        var legacy = Send(peer.Target.Id, "legacy reply destination");
        legacy.Remove("allowReply");
        legacy["reply"] = true;
        var sent = await InboundMcpFixture.CallAsync(official, "foxwarm_session", legacy);
        var target = Target(sent["structuredContent"]);
        Assert.Null((await Reply(peer, target, "official client text"))!["error"]);
        var frame = await received.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("official client text", frame.Params!["message"]!.GetValue<string>());
        Assert.Equal(target, frame.Params["endpoint"]!.GetValue<string>());
        var conflict = Send(peer.Target.Id, "conflict");
        conflict["reply"] = false;
        Assert.True((await InboundMcpFixture.CallAsync(official, "foxwarm_session", conflict))["isError"]!.GetValue<bool>());
        Assert.Single(Queue(peer.Target));

    }

    [Fact]
    public async Task Real_isolated_Agent_legacy_rules_revoke_reception_and_explicit_send_keeps_own_attachment_boundary()
    {
        await using var peer = await InboundMcpFixture.CreateAsync();
        await using var f = await OutboundMcpFixture.CreateAsync();
        await Connect(f, peer);
        f.Manager.Nodes.Registry.Create("synthetic-isolation-node");
        var created = await f.Manager.CreateAgentAsync("receiver", isolatedNode: "synthetic-isolation-node");
        var receiver = (await f.Manager.GetExistingAsync(created.MainSessionId!))!;
        receiver.Registry.TriggerOverride = _ => Task.CompletedTask;
        JsonArray Rules(string effect) => new(
            new JsonObject { ["effect"] = effect, ["source"] = "builtin", ["tool"] = "mcp_notifications" },
            new JsonObject { ["effect"] = "allow", ["source"] = "mcp", ["server"] = "peer", ["tool"] = "foxwarm_session" });
        async Task SetRules(string effect)
        {
            var outcome = await f.Manager.ExecuteAgentToolAsync(f.First, "set_agent_isolated", new JsonObject { ["agentName"] = "receiver", ["toolRules"] = Rules(effect) });
            Assert.True(outcome.Response["success"]!.GetValue<bool>());
        }
        await SetRules("allow");
        Assert.Equal("receiving", State(await Notifications(f, "start", receiver)));
        var target = Target(await f.CallAsync(receiver, "foxwarm_session", Send(peer.Target.Id, "isolated receiver")));
        await SetRules("deny");
        Assert.NotNull((await f.CallAsync(receiver, "foxwarm_session", Send(peer.Target.Id, "revoked input")))!["error"]);
        Assert.Null((await Reply(peer, target, "revoked receiver"))!["error"]);
        Assert.Single(Queue(peer.Target));
        Assert.Empty(Queue(receiver));
        await SetRules("allow");
        Assert.Null((await Reply(peer, target, "allowed receiver"))!["error"]);
        await Until(() => Queue(receiver).Length == 1);
        peer.Manager.Nodes.Registry.Create("synthetic-isolated-sender");
        await peer.Manager.SetAgentIsolationAsync("main", "synthetic-isolated-sender", true, new JsonArray(new JsonObject { ["effect"] = "allow", ["source"] = "builtin", ["tool"] = "send_to_channel" }));
        Assert.NotNull((await Reply(peer, target, "isolated unattached denied"))!["error"]);
        var messages = new List<string>();
        peer.Manager.TextChannels.Register("webui", (_, message, _) => { messages.Add(message); return Task.CompletedTask; });
        peer.Manager.AttachWebUi(peer.Target.Id, peer.Target);
        Assert.Null((await Reply(peer, "webui:" + peer.Target.Id, "own attachment"))!["error"]);
        Assert.Equal(new[] { "own attachment" }, messages);
    }

    [Fact]
    public async Task External_outbound_owner_does_not_advertise_an_internal_receiver_and_credential_text_is_not_admitted()
    {
        var clientCapabilities = new ConcurrentQueue<JsonNode?>();
        await using var inner = await InboundMcpFixture.CreateAsync(configure: app => app.Use(async (http, next) =>
        {
            if (http.Request.Method == "POST" && !http.Request.Headers.ContainsKey("Mcp-Session-Id"))
            {
                http.Request.EnableBuffering();
                using var reader = new StreamReader(http.Request.Body, leaveOpen: true);
                var body = JsonNode.Parse(await reader.ReadToEndAsync());
                http.Request.Body.Position = 0;
                if (body?["method"]?.GetValue<string>() == "initialize")
                    clientCapabilities.Enqueue(body["params"]?["capabilities"]?.DeepClone());
            }
            await next(http);
        }));
        await using var outer = await InboundMcpFixture.CreateAsync();
        await outer.Manager.OutboundMcp.ConfigureAsync(new JsonObject { ["name"] = "inner", ["transport"] = "streamable-http", ["url"] = inner.Url, ["token"] = InboundMcpFixture.Alpha }, default);
        await using var official = await outer.ClientAsync();
        var ordinary = await InboundMcpFixture.ConcreteAsync(official, "mcp:inner/foxwarm_session", Send(inner.Target.Id, "external ordinary", false));
        Assert.True(ordinary["structuredContent"]!["accepted"]!.GetValue<bool>());
        Assert.All(clientCapabilities, capability => Assert.Null(capability?["experimental"]?[Foxwarm.McpClient.NotificationCapabilityName]));
        var blocked = await InboundMcpFixture.ConcreteAsync(official, "mcp:inner/foxwarm_session", Send(inner.Target.Id, "no internal receiver"));
        Assert.True(blocked["isError"]!.GetValue<bool>());
        Assert.Single(Queue(inner.Target));
        await using var f = await OutboundMcpFixture.CreateAsync();
        await Connect(f, inner);
        await Notifications(f, "start");
        var target = Target(await f.CallAsync(f.First, "foxwarm_session", Send(inner.Target.Id, "credential receiver")));
        Assert.Null((await Reply(inner, target, "contains " + InboundMcpFixture.Alpha))!["error"]);
        Assert.Null((await Reply(inner, target, "ordinary business text"))!["error"]);
        await Until(() => Queue(f.First).Length == 1);
        Assert.Equal("ordinary business text", Queue(f.First)[0].Parts![1]["text"]!.GetValue<string>());
    }
}
