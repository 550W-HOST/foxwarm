using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ResponsesWsCancellationTests
{
    [Theory]
    [InlineData("caller")]
    [InlineData("timeout")]
    [InlineData("disconnect")]
    public async Task Original_caller_abort_is_normalized_before_linked_attempt_cancellation(
        string ending
    )
    {
        var received = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = await WsPeer.StartAsync();
        peer.BeforeResponse = async _ =>
        {
            received.TrySetResult();
            await release.Task;
        };
        if (ending == "disconnect")
            peer.CloseAfterRequest = WebSocketCloseStatus.InternalServerError;
        var clock = new ManualWsClock();
        await using var transport = new ResponsesWsTransport(clock, diagnostics: _ => { });
        using var original = new CancellationTokenSource();
        using var attempt = new CancellationTokenSource();
        var request = transport.RequestAsync(
            new Uri(peer.Uri, "responses"),
            new Dictionary<string, string>(),
            "ws/m",
            new JsonObject { ["model"] = "m", ["input"] = new JsonArray() },
            new ResponsesStreamCallbacks(),
            1000,
            attempt.Token,
            lifetimeCaller: original.Token
        );
        try
        {
            await received.Task.WaitAsync(TimeSpan.FromSeconds(5));
            // Hold linked-attempt propagation behind the original caller's resource abort.
            // This is the ordering that the ordinary owner's cancellation callbacks can race.
            if (ending == "caller")
                original.Cancel();
            else if (ending == "timeout")
                clock.Advance(TimeSpan.FromSeconds(181));
            else
                release.TrySetResult();
            var error = await Record.ExceptionAsync(() => request.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.False(attempt.IsCancellationRequested);
            if (ending == "caller")
            {
                var cancelled = Assert.IsAssignableFrom<OperationCanceledException>(error);
                Assert.Equal(original.Token, cancelled.CancellationToken);
            }
            else if (ending == "timeout")
            {
                var timeout = Assert.IsType<TimeoutException>(error);
                Assert.Equal("OpenAI Responses WebSocket request timed out.", timeout.Message);
                Assert.False(original.IsCancellationRequested);
            }
            else
            {
                Assert.IsType<IOException>(error);
                Assert.False(original.IsCancellationRequested);
            }
            Assert.Single(peer.Requests);
            Assert.Equal(0, transport.IdleCount);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task Ordinary_stop_journals_abort_and_settles_owner_without_resending()
    {
        using var temp = new TempDirectory();
        var seen = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = await StreamingModelPeer.StartAsync(
            true,
            async (context, _) =>
            {
                await context.Send(
                    ResponsesPrefixCommitTests.Done(
                        0,
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["phase"] = "commentary",
                            ["status"] = "completed",
                            ["content"] = new JsonArray(
                                new JsonObject { ["type"] = "output_text", ["text"] = "working" }
                            ),
                        }
                    )
                );
                await Task.Delay(Timeout.InfiniteTimeSpan, context.Token);
            }
        );
        var models = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a/m",
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "openai-ws",
                        ["baseUrl"] = peer.Uri.ToString(),
                        ["models"] = new JsonArray("m"),
                    },
                },
            },
            new JsonObject()
        );
        var defaults = new ResponsesClientOptions(peer.Uri, "m", "a/m", "", "", 713);
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            defaults,
            models
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "ws-stop", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        owner.Changed += ev =>
        {
            if (
                ev.Kind == SessionEventKind.RequestProgress
                && ev.Data?["text"]?.GetValue<string>() == "working"
            )
                seen.TrySetResult();
        };
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("input"));
        var running = owner.Registry.Runner.ProcessQueueAsync(owner.Id);
        await seen.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await owner.Registry.Control.StopAsync(owner.Id);
        await running.WaitAsync(TimeSpan.FromSeconds(10));
        var request = Assert.Single(await manager.Journal.ListAsync(owner.Id, null, null, null, 10));
        var journal = await manager.Journal.ReconstructAsync(request!["requestId"]!.GetValue<string>());
        var attempt = Assert.Single(journal["attempts"]!.AsArray());
        Assert.Equal("abort", attempt!["result"]!["outcome"]!.GetValue<string>());
        Assert.Equal("abort", attempt["result"]!["error"]!["kind"]!.GetValue<string>());
        Assert.Single(peer.Requests);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.False(owner.Entry.Snapshot().Stopping);
        Assert.False(owner.Entry.Snapshot().Busy);
    }
}
