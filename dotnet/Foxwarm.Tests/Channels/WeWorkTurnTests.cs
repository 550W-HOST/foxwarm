using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WeWorkTurnTests
{
    internal static byte[] Complete(JsonArray output) => Encoding.UTF8.GetBytes("data: " + new JsonObject
    {
        ["type"] = "response.completed", ["response"] = new JsonObject { ["status"] = "completed", ["output"] = output },
    }.ToJsonString() + "\n\n");
    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static JsonObject Tool(string id, string name, JsonObject args) => new()
    {
        ["type"] = "function_call", ["call_id"] = id, ["name"] = name, ["arguments"] = args.ToJsonString(),
    };

    [Fact]
    public async Task Actual_provider_native_text_tool_batches_busy_latest_cards_multi_attachment_final_and_ordinary_fallback_are_transient_and_independent()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var toolEntered = Signal(); var releaseTool = Signal(); var releaseFinal = Signal();
        await using var provider = new ScriptedResponsesSequenceServer(2, async (index, stream, _) =>
        {
            if (index == 1) await releaseFinal.Task.WaitAsync(TimeSpan.FromSeconds(15));
            var output = new JsonArray(TelegramHostTests.Output(index == 0 ? "I will inspect it." : "combined final"));
            if (index == 0)
            {
                output.Add(Tool("hold", "send_to_channel", new() { ["channelTargetId"] = "hold:one", ["message"] = "explicit" }));
                output.Add(Tool("r1", "read", new() { ["filePath"] = "known.txt" }));
                output.Add(Tool("r2", "read", new() { ["filePath"] = "missing.txt" }));
            }
            await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", Complete(output));
        });
        var portA = WeWorkPeer.Port(); var portB = WeWorkPeer.Port();
        var configA = peer.Config(portA); var configB = peer.Config(portB);
        configA["channelProgress"] = new JsonObject { ["intervalMs"] = 30000 };
        configB["channelProgress"] = new JsonObject { ["intervalMs"] = 30000 };
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["alpha"] = configA, ["beta"] = configB }, provider.BaseUri, peer.Dependencies);
        await File.WriteAllTextAsync(Path.Combine(f.Manager.IdentityWorkspace(f.Owner).ToolDirectory, "known.txt"), "known");
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.ChannelRegistry.Register("hold", async (_, _, _) => { toolEntered.TrySetResult(); await releaseTool.Task; });
        f.Manager.AttachChannel("alpha:wrk-chat", f.Owner);
        f.Manager.AttachChannel("beta:wrk-other", f.Owner);
        f.Manager.AttachChannel("alpha:wrk-fallback", f.Owner);
        f.Manager.AttachChannel("beta:wrk-silent", f.Owner, updates: new() { ["mode"] = "send-only" });
        using var a = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{portA}/") };
        using var b = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{portB}/") };
        var first = await WeWorkCallbackTests.Post(a, WeWorkPeer.Text("first"));
        var independent = await WeWorkCallbackTests.Post(b, WeWorkPeer.Text("independent", chat: "wrk-other"));
        await TelegramChannelTests.Until(() => f.Owner.Entry.WithState(state => state.Queue.Count) == 2);
        var running = f.Owner.StartProcessing();
        try
        {
            await toolEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var snapshot = await WeWorkCallbackTests.Refresh(a, WeWorkCallbackTests.Id(first));
            Assert.Equal("I will inspect it.\n\n> ⌛️ send_to_channel | ⌛️ read ×2", WeWorkCallbackTests.Content(snapshot));
            var other = await WeWorkCallbackTests.Refresh(b, WeWorkCallbackTests.Id(independent));
            Assert.Equal(WeWorkCallbackTests.Content(snapshot), WeWorkCallbackTests.Content(other));
            var next = await WeWorkCallbackTests.Post(a, WeWorkPeer.Text("busy", "steer latest"));
            await TelegramChannelTests.Until(() => f.Owner.Entry.WithState(state => state.Queue.Count) == 1);
            var old = await WeWorkCallbackTests.Refresh(a, WeWorkCallbackTests.Id(first));
            Assert.Equal("I will inspect it.", WeWorkCallbackTests.Content(old));
            Assert.True(old["stream"]!["finish"]!.GetValue<bool>());
            releaseTool.TrySetResult();
            var request = await provider.RequestAt(1).WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Contains("steer latest", request.Body);
            var pending = await WeWorkCallbackTests.Refresh(a, WeWorkCallbackTests.Id(next));
            Assert.Equal("> ☑️ send_to_channel | ☑️ read | ❌ read | 🤔 thinking", WeWorkCallbackTests.Content(pending));
            var unchanged = await WeWorkCallbackTests.Refresh(b, WeWorkCallbackTests.Id(independent));
            Assert.Equal("I will inspect it.\n\n" + WeWorkCallbackTests.Content(pending), WeWorkCallbackTests.Content(unchanged));
            releaseFinal.TrySetResult(); await running;
            var final = await WeWorkCallbackTests.Refresh(a, WeWorkCallbackTests.Id(next));
            Assert.True(final["stream"]!["finish"]!.GetValue<bool>());
            Assert.EndsWith("\n\ncombined final", WeWorkCallbackTests.Content(final));
            Assert.DoesNotContain("thinking", WeWorkCallbackTests.Content(final));
            Assert.DoesNotContain("Tools:", WeWorkCallbackTests.Content(final));
            await TelegramChannelTests.Until(() => peer.Calls.Any(call => call.Body["markdown"]?["content"]?.GetValue<string>()?.EndsWith("combined final", StringComparison.Ordinal) == true));
            var fallback = peer.Calls.Single(call => call.Body["markdown"]?["content"]?.GetValue<string>()?.EndsWith("combined final", StringComparison.Ordinal) == true);
            Assert.Equal("wrk-fallback", fallback.Body["chatid"]!.GetValue<string>());
            Assert.Contains("Tools:", fallback.Body["markdown"]!["content"]!.GetValue<string>());
            Assert.All(peer.Calls, call => Assert.Equal("wrk-fallback", call.Body["chatid"]!.GetValue<string>()));
            Assert.DoesNotContain(f.Owner.History(), row => row.ToJsonString().Contains("fw_", StringComparison.Ordinal) || row.ToJsonString().Contains("Tools:", StringComparison.Ordinal));
            Assert.Equal(2, provider.RequestCount);
            Assert.False(f.Owner.Metadata().Busy);
        }
        finally { releaseTool.TrySetResult(); releaseFinal.TrySetResult(); await running; }
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("wait")]
    [InlineData("error")]
    [InlineData("stop")]
    public async Task Native_empty_wait_error_stop_finish_one_legal_card_without_duplicate_ordinary_fallback(string kind)
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var entered = Signal(); var release = Signal();
        await using var provider = new ScriptedResponsesSequenceServer(1, async (_, stream, _) =>
        {
            entered.TrySetResult();
            if (kind == "stop") await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
            var output = new JsonArray();
            if (kind == "wait") output.Add(Tool("wait-one", "wait", new() { ["waitForInput"] = true }));
            await LoopbackResponsesServer.WriteResponseAsync(stream, kind == "error" ? 400 : 200, kind == "error" ? "application/json" : "text/event-stream",
                kind == "error" ? Encoding.UTF8.GetBytes("{\"error\":{\"message\":\"controlled refusal\",\"type\":\"invalid_request_error\"}}") : Complete(output));
        });
        var port = WeWorkPeer.Port();
        var config = peer.Config(port); config["channelProgress"] = new JsonObject { ["intervalMs"] = 30000 };
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["work"] = config }, provider.BaseUri, peer.Dependencies);
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel("work:wrk-chat", f.Owner);
        using var callback = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        var initial = await WeWorkCallbackTests.Post(callback, WeWorkPeer.Text("initial"));
        await TelegramChannelTests.Until(() => f.Owner.Entry.WithState(state => state.Queue.Count) == 1);
        var running = f.Owner.StartProcessing();
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        if (kind == "stop") await new SessionRuntime(f.Manager).StopAsync(f.Owner.Id);
        release.TrySetResult(); await running;
        var final = await WeWorkCallbackTests.Refresh(callback, WeWorkCallbackTests.Id(initial));
        Assert.True(final["stream"]!["finish"]!.GetValue<bool>());
        var content = WeWorkCallbackTests.Content(final);
        Assert.NotEmpty(content);
        Assert.DoesNotContain("thinking", content);
        if (kind == "wait") { Assert.Contains("☑️ wait", content); Assert.NotNull(f.Owner.Metadata().Wait); }
        if (kind == "empty") Assert.Equal("处理完成。", content);
        if (kind == "error") { Assert.Contains("No more retries.", content); Assert.DoesNotContain("LLM request failed", content); }
        if (kind == "stop") Assert.Contains("Execution stopped by user", content);
        Assert.Empty(peer.Calls);
    }

    [Fact]
    public void Native_aggregation_byte_budget_original_names_status_grouping_text_boundaries_and_TTL_match_Source()
    {
        var now = DateTimeOffset.UtcNow;
        var aggregator = new WeWorkStreamAggregator(30000, () => now);
        var first = aggregator.Begin("conversation", new("webhook")).Current;
        aggregator.Apply("conversation", "", new(), new("tool-calls-start", [new("a", "exec"), new("b", "read"), new("c", "exec")]));
        var grouped = aggregator.Apply("conversation", "", new(), new("tool-calls-finish", [new("a", "exec", "success"), new("c", "exec", "success")]));
        Assert.Equal("> ☑️ exec ×2 | ⌛️ read", grouped.Changed!.Content);
        aggregator.Apply("conversation", "between", new());
        var next = aggregator.Apply("conversation", "", new(), new("tool-calls-start", [new("d", "exec")]));
        Assert.Equal("> ☑️ exec ×2 | ⌛️ read\n\nbetween\n\n> ⌛️ exec", next.Changed!.Content);
        var truncated = aggregator.Apply("conversation", string.Concat(Enumerable.Repeat("你好🦊", 5000)), new(true)).Changed!;
        Assert.InRange(Encoding.UTF8.GetByteCount(truncated.Content), 1, 20480);
        Assert.DoesNotContain('\ufffd', truncated.Content);
        Assert.EndsWith("…[内容过长，已截断]", truncated.Content);
        now += TimeSpan.FromMinutes(16);
        Assert.Null(aggregator.Get(first.Id, true));
        Assert.Null(aggregator.Get("conversation"));
    }
}
