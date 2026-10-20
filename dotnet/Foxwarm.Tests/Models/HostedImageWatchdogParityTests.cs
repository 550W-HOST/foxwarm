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

    [Theory]
    [InlineData("inactivity")]
    [InlineData("stop")]
    [InlineData("hard-deadline")]
    public async Task Completed_SSE_keeps_its_collection_bound_until_EOF(string end)
    {
        var clock = new ManualWsClock();
        var answer = new JsonObject
        {
            ["type"] = "message",
            ["role"] = "assistant",
            ["phase"] = "final_answer",
            ["content"] = new JsonArray(
                new JsonObject { ["type"] = "output_text", ["text"] = "final" }
            ),
        };
        var bytes = System.Text.Encoding.UTF8.GetBytes(
            "data: " + ResponsesPrefixCommitTests.Completed(answer).ToJsonString() + "\n\n"
        );
        using var stream = new CompletedOpenStream(bytes);
        using var http = new HttpClient(new CompletedOpenHandler(stream))
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        using var stop = new CancellationTokenSource();
        var options = new ResponsesClientOptions(
            new Uri("http://unused.invalid"),
            "m",
            "a/m",
            "",
            "",
            713,
            StreamInactivityTimeoutMs: 60000
        )
        {
            Clock = clock,
            HardTimeoutMs = end == "hard-deadline" ? 10000 : null,
        };
        var models = HostModels.Parse(
            new JsonObject
            {
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = "http://unused.invalid",
                        ["models"] = new JsonArray("m"),
                    },
                },
            },
            new JsonObject()
        );
        var request = ConfiguredModelRequests
            .CreatePreparedService(http, models.Resolve("a/m"), options, "cache")
            .ChatAsync("s", [], stop.Token);
        await stream.Waiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(request.IsCompleted);
        if (end == "stop")
            stop.Cancel();
        else
            clock.Advance(TimeSpan.FromMilliseconds(end == "hard-deadline" ? 10001 : 86400000));
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                request.WaitAsync(TimeSpan.FromSeconds(5))
            );
        }
        finally
        {
            stop.Cancel();
        }
    }

    private sealed class CompletedOpenHandler(Stream stream) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken token
        ) =>
            Task.FromResult(
                new HttpResponseMessage(System.Net.HttpStatusCode.OK)
                {
                    Content = new StreamContent(stream),
                }
            );
    }

    private sealed class CompletedOpenStream(byte[] prefix) : Stream
    {
        private int offset;
        internal readonly TaskCompletionSource Waiting = Signal();

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken token = default
        )
        {
            if (offset < prefix.Length)
            {
                var count = Math.Min(buffer.Length, prefix.Length - offset);
                prefix.AsMemory(offset, count).CopyTo(buffer);
                offset += count;
                return count;
            }
            Waiting.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            return 0;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();

        public override void Flush() => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) =>
            throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();
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
