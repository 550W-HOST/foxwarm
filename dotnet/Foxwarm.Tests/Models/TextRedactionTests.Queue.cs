using Foxwarm.Models;
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
        var redactor = TextRedactor.For(Enumerable.Range(41, 32).Select(i => (byte)i).ToArray());
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
        var redactor = TextRedactor.For(Enumerable.Range(77, 32).Select(i => (byte)i).ToArray());
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
