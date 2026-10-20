using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class HostedImageWatchdogParityTests
{
    [Theory]
    [InlineData(false, 60000)]
    [InlineData(true, 60000)]
    [InlineData(false, 900000)]
    [InlineData(true, 900000)]
    public async Task Image_allowance_remains_latched_after_completion_and_later_text_without_reducing_larger_configuration(
        bool websocket,
        int configured
    )
    {
        var imageSeen = Signal();
        var textSeen = Signal();
        var allowText = Signal();
        var clock = new ManualWsClock();
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, _) =>
            {
                await context.Send(
                    new JsonObject
                    {
                        ["type"] = "response.output_item.added",
                        ["output_index"] = 0,
                        ["item"] = new JsonObject
                        {
                            ["type"] = "image_generation_call",
                            ["status"] = "in_progress",
                        },
                    }
                );
                await context.Send(
                    new JsonObject
                    {
                        ["type"] = "response.image_generation_call.completed",
                        ["output_index"] = 0,
                    }
                );
                await allowText.Task.WaitAsync(context.Token);
                await context.Send(
                    ResponsesPrefixCommitTests.Done(
                        1,
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["phase"] = "commentary",
                            ["content"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "output_text",
                                    ["text"] = "after image",
                                }
                            ),
                        }
                    )
                );
                await Task.Delay(Timeout.InfiniteTimeSpan, context.Token);
            }
        );
        using var http = ProviderHttpRequest.CreateClient();
        using var stop = new CancellationTokenSource();
        await using var transport = new ResponsesWsTransport(clock, diagnostics: _ => { });
        var options = new ResponsesClientOptions(
            peer.Uri,
            "m",
            "a/m",
            "",
            "",
            713,
            StreamInactivityTimeoutMs: configured
        )
        {
            Clock = clock,
        };
        void Progress(string _, ResponsesStreamProgress progress)
        {
            if (
                progress.Parts?.Any(part =>
                    part.Kind == "image-generation" && part.Status == "completed"
                ) == true
            )
                imageSeen.TrySetResult();
            if (progress.Text == "after image")
                textSeen.TrySetResult();
        }
        var service = Service(http, options, transport, websocket, Progress);
        var request = service.ChatAsync("s", [], stop.Token);
        await imageSeen.Task.WaitAsync(TimeSpan.FromSeconds(5));
        clock.Advance(TimeSpan.FromMilliseconds(60001));
        Assert.False(request.IsCompleted);
        allowText.TrySetResult();
        await textSeen.Task.WaitAsync(TimeSpan.FromSeconds(5));
        if (configured > 600000)
        {
            clock.Advance(TimeSpan.FromMilliseconds(600001));
            Assert.False(request.IsCompleted);
            stop.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
        }
        else
        {
            clock.Advance(TimeSpan.FromMilliseconds(600001));
            var error = await Record.ExceptionAsync(() =>
                request.WaitAsync(TimeSpan.FromSeconds(5))
            );
            Assert.True(
                websocket ? error is TimeoutException : error is OperationCanceledException,
                error?.ToString()
            );
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Hosted_image_activity_does_not_extend_the_independent_hard_deadline(
        bool websocket
    )
    {
        var active = Signal();
        var clock = new ManualWsClock();
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, _) =>
            {
                await context.Send(
                    new JsonObject
                    {
                        ["type"] = "response.output_item.added",
                        ["output_index"] = 0,
                        ["item"] = new JsonObject
                        {
                            ["type"] = "image_generation_call",
                            ["status"] = "in_progress",
                        },
                    }
                );
                await Task.Delay(Timeout.InfiniteTimeSpan, context.Token);
            }
        );
        using var http = ProviderHttpRequest.CreateClient();
        await using var transport = new ResponsesWsTransport(clock, diagnostics: _ => { });
        var options = new ResponsesClientOptions(
            peer.Uri,
            "m",
            "a/m",
            "",
            "",
            713,
            StreamInactivityTimeoutMs: 60000
        )
        {
            Clock = clock,
            HardTimeoutMs = 10000,
        };
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a/m",
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = websocket ? "openai-ws" : "openai-responses",
                        ["baseUrl"] = peer.Uri.ToString(),
                        ["models"] = new JsonArray("m"),
                    },
                },
            },
            new JsonObject()
        );
        var request = ConfiguredModelRequests
            .CreatePreparedService(
                http,
                catalog.Resolve("a/m"),
                options,
                "cache",
                websockets: transport,
                progress: (_, progress) =>
                {
                    if (progress.Parts?.Any(part => part.Kind == "image-generation") == true)
                        active.TrySetResult();
                }
            )
            .ChatAsync("s", [], default);
        await active.Task.WaitAsync(TimeSpan.FromSeconds(5));
        clock.Advance(TimeSpan.FromMilliseconds(10001));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            request.WaitAsync(TimeSpan.FromSeconds(5))
        );
    }

    private static Foxwarm.Sessions.IChatService Service(
        HttpClient http,
        ResponsesClientOptions options,
        ResponsesWsTransport transport,
        bool websocket,
        Action<string, ResponsesStreamProgress> progress
    ) =>
        websocket
            ? new ResponsesWsChatService(
                options,
                transport,
                ModelRequestScope.Canonical,
                false,
                "cache",
                progress
            )
            : new ResponsesChatService(http, options, progress);

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}
