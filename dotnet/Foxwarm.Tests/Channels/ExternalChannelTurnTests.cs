using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ExternalChannelTurnTests
{
    private static byte[] Complete(JsonArray output) => Encoding.UTF8.GetBytes("data: " + new JsonObject
    {
        ["type"] = "response.completed", ["response"] = new JsonObject { ["status"] = "completed", ["output"] = output },
    }.ToJsonString() + "\n\n");

    [Fact]
    public async Task Actual_provider_tool_progress_decorates_only_automatic_output_and_a_failing_broadcast_does_not_fail_the_turn()
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var provider = new ScriptedResponsesSequenceServer(2, async (index, stream, _) =>
        {
            var output = new JsonArray(TelegramHostTests.Output(index == 0 ? "working" : "finished"));
            if (index == 0) output.Add(new JsonObject
            {
                ["type"] = "function_call", ["call_id"] = "explicit-send", ["name"] = "send_to_channel",
                ["arguments"] = new JsonObject { ["channelTargetId"] = "alpha:999", ["message"] = "tool-owned" }.ToJsonString(),
            });
            await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", Complete(output));
        });
        var channel = ExternalChannelFixture.Channel();
        channel["channelProgress"] = new JsonObject { ["intervalMs"] = 30000 };
        await using var f = await ExternalChannelFixture.CreateAsync(new JsonObject { ["alpha"] = channel }, provider.BaseUri, peer.Dependencies);
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel("alpha:42", f.Owner);
        f.Manager.ChannelRegistry.Register("failing", (_, _, _) => throw new IOException("controlled automatic failure"));
        f.Manager.AttachChannel("failing:42", f.Owner);
        var source = new ExternalChannelContext("alpha", "telegram", "42", "11", null, _ => Task.CompletedTask);
        await f.Router.HandleExternalMessageAsync(source, new([new JsonObject { ["text"] = "run tools" }]));
        await f.Owner.StartProcessing();
        await TelegramChannelTests.Until(() => peer.Sent("a").Any(call => (SessionWait.Text(call.Body["text"]) ?? "").EndsWith("finished", StringComparison.Ordinal)));
        Assert.Contains(peer.Sent("a"), call => SessionWait.Text(call.Body["text"]) == "working");
        Assert.Contains(peer.Sent("a"), call => SessionWait.Text(call.Body["text"]) == "tool-owned");
        var final = peer.Sent("a").Single(call => (SessionWait.Text(call.Body["text"]) ?? "").EndsWith("finished", StringComparison.Ordinal));
        Assert.Contains("send_to_channel", SessionWait.Text(final.Body["text"])!);
        Assert.DoesNotContain(f.Owner.History(), message => message.ToJsonString().Contains("Tools: ", StringComparison.Ordinal));
        Assert.Equal(0, f.Owner.Entry.BackgroundProcessorFailureCount);
        Assert.Contains(f.Owner.History(), message => (message["parts"] as JsonArray ?? []).Any(part => SessionWait.Text(part?["functionResponse"]?["name"]) == "send_to_channel"));
    }

    [Fact]
    public async Task Empty_and_wait_terminal_turns_finalize_without_empty_platform_text_or_progress()
    {
        foreach (var wait in new[] { false, true })
        {
            await using var provider = new ScriptedResponsesSequenceServer(1, async (_, stream, _) =>
            {
                var output = new JsonArray();
                if (wait) output.Add(new JsonObject { ["type"] = "function_call", ["call_id"] = "wait-one", ["name"] = "wait", ["arguments"] = "{\"waitForInput\":true}" });
                await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", Complete(output));
            });
            await using var f = await ExternalChannelFixture.CreateAsync(provider: provider.BaseUri);
            var sent = new List<string>();
            var finalized = 0;
            f.Manager.ChannelRegistry.Register("controlled", new RegisteredChannel("controlled", (_, text, _, _) => { sent.Add(text); return Task.CompletedTask; },
                Finalize: (_, _, _) => { Interlocked.Increment(ref finalized); return Task.CompletedTask; }));
            f.Manager.AttachChannel("controlled:42", f.Owner);
            await f.Router.HandleExternalMessageAsync(new("controlled", "internal", "42", null, null, _ => Task.CompletedTask), new([new JsonObject { ["text"] = "run" }]));
            await f.Owner.StartProcessing();
            Assert.Empty(sent);
            Assert.Equal(1, finalized);
            Assert.Equal(wait, f.Owner.Metadata().Wait is not null);
        }
    }

    [Fact]
    public async Task Terminal_provider_retry_presents_only_the_channel_snippet_and_one_empty_terminal_hook()
    {
        await using var provider = new ScriptedResponsesSequenceServer(1, (_, stream, _) =>
            LoopbackResponsesServer.WriteResponseAsync(stream, 400, "application/json", Encoding.UTF8.GetBytes("{\"error\":{\"message\":\"controlled refusal\",\"type\":\"invalid_request_error\",\"code\":\"invalid_request_error\"}}")));
        await using var f = await ExternalChannelFixture.CreateAsync(provider: provider.BaseUri);
        var sent = new List<string>();
        var finals = 0;
        f.Manager.ChannelRegistry.Register("controlled", new RegisteredChannel("controlled", (_, text, _, _) => { sent.Add(text); return Task.CompletedTask; },
            Finalize: (_, _, _) => { Interlocked.Increment(ref finals); return Task.CompletedTask; }));
        f.Manager.AttachChannel("controlled:42", f.Owner);
        await new SessionRuntime(f.Manager).SubmitAndRunAsync(f.Owner.Id, QueueItem.UserText("request rejected"));
        await f.Owner.StartProcessing();
        Assert.Single(sent);
        Assert.Contains("LLM Error:", sent.Single());
        Assert.Contains("No more retries.", sent.Single());
        Assert.Equal(1, finals);
        Assert.DoesNotContain(sent, text => text.Contains("LLM request failed", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Continuation_preparation_failure_delivers_one_plain_error_not_the_stored_notice_markup()
    {
        ExternalChannelFixture? fixture = null;
        await using var provider = new ScriptedResponsesSequenceServer(1, async (_, stream, _) =>
        {
            await File.WriteAllTextAsync(fixture!.Configuration.ActivePath, "providers: null\n");
            await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", Complete(new JsonArray(new JsonObject
            {
                ["type"] = "function_call", ["call_id"] = "read-one", ["name"] = "read", ["arguments"] = "{\"filePath\":\"missing.txt\"}",
            })));
        });
        await using var f = fixture = await ExternalChannelFixture.CreateAsync(provider: provider.BaseUri);
        var original = await File.ReadAllTextAsync(f.Configuration.ActivePath);
        var sent = new List<string>();
        f.Manager.ChannelRegistry.Register("controlled", (_, text, _) => { sent.Add(text); return Task.CompletedTask; });
        f.Manager.AttachChannel("controlled:42", f.Owner);
        try
        {
            await new SessionRuntime(f.Manager).SubmitAndRunAsync(f.Owner.Id, QueueItem.UserText("failure after tools"));
            await f.Owner.StartProcessing();
            Assert.Single(sent);
            Assert.StartsWith("Error: ", sent.Single());
            Assert.DoesNotContain("<foxwarm-system", sent.Single());
        }
        finally { await File.WriteAllTextAsync(f.Configuration.ActivePath, original); }
    }

    [Fact]
    public async Task User_stop_reaches_committed_terminal_lifecycle_after_real_provider_cancellation()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var provider = new ScriptedResponsesSequenceServer(1, async (_, stream, _) =>
        {
            await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
            await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", Complete(new JsonArray()));
        });
        await using var f = await ExternalChannelFixture.CreateAsync(provider: provider.BaseUri);
        var sent = new List<string>();
        var finals = 0;
        f.Manager.ChannelRegistry.Register("controlled", new RegisteredChannel("controlled", (_, text, options, _) => { sent.Add(text); if (options.TurnFinal) Interlocked.Increment(ref finals); return Task.CompletedTask; },
            Finalize: (_, _, _) => { Interlocked.Increment(ref finals); return Task.CompletedTask; }));
        f.Manager.AttachChannel("controlled:42", f.Owner);
        await new SessionRuntime(f.Manager).SubmitAndRunAsync(f.Owner.Id, QueueItem.UserText("cancel this request"));
        var running = f.Owner.StartProcessing();
        try
        {
            await provider.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(10));
            await new SessionRuntime(f.Manager).StopAsync(f.Owner.Id);
            await running.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Contains(sent, text => text.Contains("Execution stopped", StringComparison.Ordinal));
            Assert.Equal(1, finals);
            Assert.False(f.Owner.Metadata().Busy);
        }
        finally { release.TrySetResult(); }
    }
}
