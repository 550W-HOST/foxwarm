using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed partial class TextRedactionTests
{
    // The detection service handles one text at a time and answers 429 instead of queueing.
    // Concurrent requests from different Sessions queue for it, and the wait does not count
    // against the per-call detection timeout.
    [Fact]
    public async Task Concurrent_requests_queue_for_one_detector_instead_of_failing_each_other()
    {
        await using var detector = await TextDetectionPeer.StartAsync("Alice");
        var inFlight = 0;
        var maxInFlight = 0;
        var busy = 0;
        detector.Intercept = async (context, _) =>
        {
            var current = Interlocked.Increment(ref inFlight);
            InterlockedMax(ref maxInFlight, current);
            if (current > 1)
            {
                Interlocked.Decrement(ref inFlight);
                Interlocked.Increment(ref busy);
                context.Response.StatusCode = 429;
                await context.Response.WriteAsync("Inference busy; retry later");
                return true;
            }
            await Task.Delay(150);
            Interlocked.Decrement(ref inFlight);
            return false;
        };
        var redactor = new TextRedactor(Enumerable.Range(41, 32).Select(i => (byte)i).ToArray());
        using var http = ProviderHttpRequest.CreateClient();
        // Four requests at once: the last waits about 450 ms, longer than one call's timeout.
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 400);
        var results = await Task.WhenAll(
            Enumerable
                .Range(0, 4)
                .Select(index =>
                    Task.Run(() =>
                        redactor
                            .Begin(http, options, CancellationToken.None)
                            .DetectAsync($"Session {index} asks Alice about the queue.")
                    )
                )
        );

        Assert.Equal(0, Volatile.Read(ref busy));
        Assert.Equal(1, Volatile.Read(ref maxInFlight));
        Assert.Equal(4, detector.Texts.Count);
        Assert.All(results, text => Assert.DoesNotContain("Alice", text));
    }

    [Fact]
    public async Task Waiting_for_the_detector_stops_with_the_request()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        detector.Intercept = async (_, _) =>
        {
            entered.TrySetResult();
            await release.Task;
            return false;
        };
        var redactor = new TextRedactor(Enumerable.Range(77, 32).Select(i => (byte)i).ToArray());
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var first = redactor.Begin(http, options, CancellationToken.None).DetectAsync("first");
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        using var stop = new CancellationTokenSource();
        var waiting = redactor.Begin(http, options, stop.Token).DetectAsync("second");
        await Task.Delay(100);
        Assert.False(waiting.IsCompleted);
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
        release.SetResult();
        Assert.Equal("first", await first);
        Assert.DoesNotContain("second", detector.Texts);
    }

    [Fact]
    public void Max_concurrency_inherits_and_validates()
    {
        var root = JsonNode
            .Parse(
                """
                {"defaults":{"textRedaction":{"enabled":true,"endpoint":"http://127.0.0.1:1/classify","maxConcurrency":4}},
                 "providers":{"p":{"baseUrl":"http://127.0.0.1:2","models":["inherited",{"id":"serial","textRedaction":{"maxConcurrency":1}}]}}}
                """
            )!
            .AsObject();
        var catalog = HostModels.Parse(root, new());
        TextRedactionOptions Options(string key) =>
            TextRedactionOptions.FromResolved(
                catalog.Resolve(key).Configuration["textRedaction"]!.AsObject()
            )!;
        Assert.Equal(4, Options("p/inherited").MaxConcurrency);
        Assert.Equal(1, Options("p/serial").MaxConcurrency);
        // The limit does not change detection results, so it shares cache identity.
        Assert.Equal(Options("p/inherited"), Options("p/serial"));
        foreach (var invalid in new[] { "0", "65", "2.5", "true" })
        {
            var bad = JsonNode
                .Parse(
                    "{\"providers\":{\"p\":{\"textRedaction\":{\"maxConcurrency\":"
                        + invalid
                        + "}}}}"
                )!
                .AsObject();
            Assert.Throws<InvalidDataException>(() => HostModels.Parse(bad, new()));
        }
    }

    // With a limit above one, a request detects its slots concurrently up to that limit,
    // once per distinct text, and sends the same redacted slots in their original order.
    [Fact]
    public async Task Request_detects_slots_concurrently_up_to_the_limit()
    {
        var names = Enumerable.Range(0, 12).Select(i => "Person" + i).ToArray();
        await using var detector = await TextDetectionPeer.StartAsync(names);
        var inFlight = 0;
        var maxInFlight = 0;
        detector.Intercept = async (_, _) =>
        {
            InterlockedMax(ref maxInFlight, Interlocked.Increment(ref inFlight));
            await Task.Delay(60);
            Interlocked.Decrement(ref inFlight);
            return false;
        };
        var history = names
            .Select(name => ChatResult.Text("Ask " + name + " about the build.").AssistantMessage!)
            .Append(ChatResult.Text("Ask " + names[0] + " about the build.").AssistantMessage!)
            .ToList();
        IReadOnlyList<JsonObject>? sent = null;
        var service = new TextRedactionChatService(
            ProviderHttpRequest.CreateClient(),
            new ResponsesClientOptions(new("http://127.0.0.1:1"), "m", "p/m", "", "", 100)
            {
                Instructions = "Instructions for " + names[1],
                TextRedactorSource = () =>
                    new TextRedactor(Enumerable.Range(150, 32).Select(i => (byte)i).ToArray()),
            },
            new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000) { MaxConcurrency = 3 },
            null,
            (_, _) => new CapturingChatService(value => sent = value)
        );
        await service.ChatAsync("s", history, default);

        Assert.Equal(3, Volatile.Read(ref maxInFlight));
        // Twelve distinct slots plus the instructions; the repeated slot is detected once.
        Assert.Equal(13, detector.Texts.Count);
        Assert.Equal(13, detector.Texts.Distinct().Count());
        var texts = sent!.Select(message => message.ToJsonString()).ToArray();
        for (var index = 0; index < names.Length; index++)
        {
            Assert.DoesNotContain(names[index] + " ", texts[index]);
            Assert.Contains("Ask " + TextRedactor.Prefix, texts[index]);
        }
        Assert.Equal(texts[0], texts[^1]);
    }

    [Fact]
    public async Task Concurrent_detection_failure_fails_the_request_without_sending()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        detector.Intercept = async (context, text) =>
        {
            if (!text.Contains("third", StringComparison.Ordinal))
                return false;
            context.Response.StatusCode = 503;
            await context.Response.WriteAsync("unavailable");
            return true;
        };
        var history = new[] { "first", "second", "third", "fourth" }
            .Select(text => ChatResult.Text(text + " slot").AssistantMessage!)
            .ToList();
        var service = new TextRedactionChatService(
            ProviderHttpRequest.CreateClient(),
            new ResponsesClientOptions(new("http://127.0.0.1:1"), "m", "p/m", "", "", 100)
            {
                TextRedactorSource = () =>
                    new TextRedactor(Enumerable.Range(190, 32).Select(i => (byte)i).ToArray()),
            },
            new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000) { MaxConcurrency = 4 },
            null,
            (_, _) => throw new Exception("Unexpected provider send")
        );
        var error = await Assert.ThrowsAsync<TextRedactionException>(() =>
            service.ChatAsync("s", history, default)
        );
        Assert.True(error.Retryable);
        Assert.Contains("HTTP 503", error.Message);
    }

    private sealed class CapturingChatService(Action<IReadOnlyList<JsonObject>> capture)
        : IChatService
    {
        public Task<ChatResult> ChatAsync(
            string sessionId,
            IReadOnlyList<JsonObject> history,
            CancellationToken cancellationToken
        )
        {
            capture(history.Select(message => (JsonObject)message.DeepClone()).ToArray());
            return Task.FromResult(ChatResult.Text("ok"));
        }
    }

    private static void InterlockedMax(ref int target, int value)
    {
        var current = Volatile.Read(ref target);
        while (value > current)
        {
            var seen = Interlocked.CompareExchange(ref target, value, current);
            if (seen == current)
                return;
            current = seen;
        }
    }
}
