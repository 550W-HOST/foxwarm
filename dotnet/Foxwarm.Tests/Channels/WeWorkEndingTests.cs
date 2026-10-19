using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WeWorkEndingTests
{
    private static JsonObject Tool(string name, JsonObject args) => new()
    {
        ["type"] = "function_call", ["call_id"] = "ending-call", ["name"] = name,
        ["arguments"] = args.ToJsonString(),
    };

    [Theory]
    [InlineData("wait")]
    [InlineData("handoff-wait")]
    [InlineData("handoff-finish")]
    public async Task Actual_tool_ending_distinguishes_waiting_from_successful_finish_and_resumes_same_card(string kind)
    {
        string? target = null;
        await using var peer = await WeWorkPeer.StartAsync();
        await using var provider = new ScriptedResponsesSequenceServer(2, async (index, stream, _) =>
        {
            var output = new JsonArray(TelegramHostTests.Output(index == 0 ? "process before ending" : "resumed answer"));
            if (index == 0)
                output.Add(kind == "wait" ? Tool("wait", new() { ["waitForInput"] = true })
                    : Tool("send_to_session", new() { ["sessionId"] = target, ["message"] = "handoff payload", ["afterSend"] = kind == "handoff-wait" ? "wait" : "finish" }));
            await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", WeWorkTurnTests.Complete(output));
        });
        var port = WeWorkPeer.Port();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["work"] = peer.Config(port) }, provider.BaseUri, peer.Dependencies);
        var recipient = await f.Manager.CreateNamedAsync("main", "recipient", null, null);
        recipient.Registry.TriggerOverride = _ => Task.CompletedTask;
        target = recipient.Id;
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel("work:wrk-chat", f.Owner);
        using var callback = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        var initial = await WeWorkCallbackTests.Post(callback, WeWorkPeer.Text("ending"));
        await TelegramChannelTests.Until(() => f.Owner.Entry.WithState(state => state.Queue.Count) == 1);
        await f.Owner.StartProcessing();
        var ended = await WeWorkCallbackTests.Refresh(callback, WeWorkCallbackTests.Id(initial));
        var finish = kind == "handoff-finish";
        Assert.Equal(finish, ended["stream"]!["finish"]!.GetValue<bool>());
        Assert.StartsWith("<think>\nprocess before ending", WeWorkCallbackTests.Content(ended));
        Assert.Equal(!finish, f.Owner.Metadata().Wait is not null);
        if (finish)
        {
            Assert.EndsWith("</think>\n处理完成。", WeWorkCallbackTests.Content(ended));
            Assert.Equal(1, provider.RequestCount);
        }
        else
        {
            Assert.DoesNotContain("</think>", WeWorkCallbackTests.Content(ended));
            // Resume through ordinary owner ingress, not another WeWork callback/card allocation.
            await f.Owner.Registry.Ingress.EnqueueAsync(f.Owner.Id, QueueItem.UserText("resume the existing card"));
            await f.Owner.StartProcessing();
            var final = await WeWorkCallbackTests.Refresh(callback, WeWorkCallbackTests.Id(initial));
            Assert.True(final["stream"]!["finish"]!.GetValue<bool>());
            Assert.EndsWith("</think>\nresumed answer", WeWorkCallbackTests.Content(final));
            Assert.Contains("process before ending", WeWorkCallbackTests.Content(final));
            Assert.Equal(2, provider.RequestCount);
        }
        if (kind != "wait") Assert.Single(recipient.Entry.Snapshot().Queue);
        Assert.Empty(peer.Calls);
    }
    [Theory]
    [InlineData("open", "<think>")]
    [InlineData("closed", "<think></think>")]
    [InlineData("unknown", "<think>")]
    public async Task Configured_frames_reserve_the_final_body_and_refresh_only_unfinished_TTL(string style, string initialFrame)
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var clock = DateTimeOffset.UtcNow;
        var port = WeWorkPeer.Port();
        var config = peer.Config(port);
        config["aibot"]!["streamThinkFrame"] = style;
        config["aibot"]!["streamMaxContentBytes"] = 200;
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["work"] = config }, dependencies: peer.Dependencies with { Now = () => clock });
        await f.Manager.ManagedChannels!.ReloadAsync();
        using var callback = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        var initial = await WeWorkCallbackTests.Post(callback, WeWorkPeer.Text("framed"));
        Assert.Equal(initialFrame, WeWorkCallbackTests.Content(initial));
        var id = WeWorkCallbackTests.Id(initial);
        var transport = f.Manager.ChannelRegistry.Get("work")!;
        await transport.Send("wrk-chat", string.Concat(Enumerable.Repeat("过程🦊", 200)), new(), default);
        for (var i = 0; i < 2; i++)
        {
            clock += TimeSpan.FromMinutes(14);
            var refreshed = await WeWorkCallbackTests.Refresh(callback, id);
            Assert.False(refreshed["stream"]!["finish"]!.GetValue<bool>());
            var content = WeWorkCallbackTests.Content(refreshed);
            Assert.StartsWith("<think>\n", content);
            Assert.Equal(style == "closed", content.Contains("</think>", StringComparison.Ordinal));
            Assert.InRange(System.Text.Encoding.UTF8.GetByteCount(content), 1, 200);
        }
        await transport.Send("wrk-chat", "visible answer", new(true), default);
        var final = await WeWorkCallbackTests.Refresh(callback, id);
        Assert.True(final["stream"]!["finish"]!.GetValue<bool>());
        Assert.EndsWith("</think>\nvisible answer", WeWorkCallbackTests.Content(final));
        Assert.DoesNotContain('\ufffd', WeWorkCallbackTests.Content(final));
        Assert.InRange(System.Text.Encoding.UTF8.GetByteCount(WeWorkCallbackTests.Content(final)), 1, 200);
        clock += TimeSpan.FromMinutes(14);
        Assert.Equal(WeWorkCallbackTests.Content(final), WeWorkCallbackTests.Content(await WeWorkCallbackTests.Refresh(callback, id)));
        clock += TimeSpan.FromMinutes(2);
        Assert.Equal("未找到对应的流式消息。", WeWorkCallbackTests.Content(await WeWorkCallbackTests.Refresh(callback, id)));
        var direct = await WeWorkCallbackTests.Post(callback, WeWorkPeer.Text("direct"));
        await transport.Send("wrk-chat", "answer without process", new(true), default);
        Assert.Equal("answer without process", WeWorkCallbackTests.Content(await WeWorkCallbackTests.Refresh(callback, WeWorkCallbackTests.Id(direct))));
    }

    [Fact]
    public async Task Actual_nonpassive_legacy_response_url_and_websocket_routes_strip_only_fold_tags()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var port = WeWorkPeer.Port();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["work"] = peer.Config(port, stream: false, socket: true) }, dependencies: peer.Dependencies);
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => frame["cmd"]!.ToString() == "aibot_subscribe"));
        var transport = f.Manager.ChannelRegistry.Get("work")!;
        const string tagged = "<THINK>process</think>\nanswer <thinking>retained</thinking>";
        const string plain = "process\nanswer <thinking>retained</thinking>";
        await transport.Send("wrk-chat", tagged, new(WebhookUrl: peer.Webhook), default);
        await transport.Send("wrk-chat", tagged, new(), default);
        using var callback = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        var body = WeWorkPeer.Text("terminal"); body["response_url"] = new Uri(peer.Address, "terminal").ToString();
        await WeWorkCallbackTests.Post(callback, body);
        await transport.Send("wrk-chat", tagged, new(true), default);
        Assert.Equal(2, peer.Calls.Count);
        Assert.All(peer.Calls, call => Assert.Equal(plain, call.Body["markdown"]!["content"]!.GetValue<string>()));
        Assert.Equal(plain, peer.Frames.Single(frame => frame["cmd"]!.ToString() == "aibot_send_msg")["body"]!["markdown"]!["content"]!.GetValue<string>());
    }

}
