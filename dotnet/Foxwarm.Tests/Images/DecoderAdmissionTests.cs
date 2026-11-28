using Foxwarm.Images;

namespace Foxwarm.Tests;

public sealed class DecoderAdmissionTests
{
    [Fact]
    public async Task Two_workers_serve_distinct_tenants_and_rotate_backlogged_tenants_in_order()
    {
        var queue = new DecoderAdmission();
        using var first = await queue.EnterAsync(1, 0, default);
        var more = queue.EnterAsync(1, 0, default);
        using var second = await queue.EnterAsync(2, 0, default);
        var third = queue.EnterAsync(3, 0, default);
        var fourth = queue.EnterAsync(4, 0, default);
        Assert.False(more.IsCompleted || third.IsCompleted || fourth.IsCompleted);
        first.Dispose();
        using var c = await third.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.False(more.IsCompleted || fourth.IsCompleted);
        second.Dispose();
        using var d = await fourth.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.False(more.IsCompleted);
        d.Dispose();
        using var next = await more.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task Cancelled_waiters_and_expired_tenants_release_their_place()
    {
        var queue = new DecoderAdmission();
        using var first = await queue.EnterAsync(1, 0, default);
        using var second = await queue.EnterAsync(2, 0, default);
        using var stop = new CancellationTokenSource();
        var cancelled = queue.EnterAsync(3, 0, stop.Token);
        var expires = queue.EnterAsync(1, 2L * DecoderProtocol.MaxBytes, default);
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        var failure = await Assert.ThrowsAsync<ImageProcessingException>(() => expires);
        Assert.Equal(DecoderProtocol.Busy, failure.Message);
        using var stopAfterExpiry = new CancellationTokenSource();
        var refilled = queue.EnterAsync(1, 2L * DecoderProtocol.MaxBytes, stopAfterExpiry.Token);
        Assert.False(refilled.IsCompleted);
        stopAfterExpiry.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => refilled);
        first.Dispose();
        second.Dispose();
        using var a = await queue.EnterAsync(1, 0, default);
        using var b = await queue.EnterAsync(3, 0, default);
    }

    [Fact]
    public async Task Flood_of_staged_images_is_refused_before_buffering_and_leaves_the_other_worker_free()
    {
        var queue = new DecoderAdmission();
        using var active = await queue.EnterAsync(1, 0, default);
        using var cancel = new CancellationTokenSource();
        var decoder = new TenantImageDecoder(
            1,
            new ImageDecoderProcess("/unused", _ => { }),
            queue
        );
        // These streams represent staged 32 MiB files. An unexpected read fails the test;
        // no actual large payload, deliberately slow codec, or memory-pressure test is needed.
        using var staged = new UnreadStage();
        var length = (int)staged.Length;
        long start = GC.GetAllocatedBytesForCurrentThread();
        var waiting = Enumerable
            .Range(0, 4)
            .Select(_ => decoder.ProbeStagedAsync(staged, length, "image/gif", cancel.Token))
            .ToArray();
        var overflow = decoder.ProbeStagedAsync(staged, length, "image/gif", default);
        long allocatedAtAdmission = GC.GetAllocatedBytesForCurrentThread() - start;
        Assert.True(
            allocatedAtAdmission < 1024 * 1024,
            $"Queued preparation allocated {allocatedAtAdmission} bytes."
        );
        Assert.All(waiting, task => Assert.False(task.IsCompleted));
        Assert.True(overflow.IsCompleted);
        Assert.Equal(
            DecoderProtocol.Busy,
            (await Assert.ThrowsAsync<ImageProcessingException>(() => overflow)).Message
        );
        using var other = await queue
            .EnterAsync(2, length, default)
            .WaitAsync(TimeSpan.FromSeconds(2));
        cancel.Cancel();
        foreach (var task in waiting)
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task);
        // While both tenants are still active the exact same backlog fits again after cancel.
        using var again = new CancellationTokenSource();
        var refilled = queue.EnterAsync(1, 4L * length, again.Token);
        Assert.False(refilled.IsCompleted);
        again.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => refilled);
    }

    private sealed class UnreadStage : MemoryStream
    {
        public override long Length => ImageInputPolicy.MaxBytes;

        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken token = default
        ) => throw new InvalidOperationException("A queued upload read its staged bytes.");
    }

    [Fact]
    public async Task Replica_caps_waiting_bytes_across_tenants_and_returns_charge_on_dispatch()
    {
        var queue = new DecoderAdmission();
        using var first = await queue.EnterAsync(1, 0, default);
        using var second = await queue.EnterAsync(2, 0, default);
        using var cancel = new CancellationTokenSource();
        var waiting = Enumerable
            .Range(3, 4)
            .SelectMany(key =>
                Enumerable
                    .Range(0, 2)
                    .Select(_ => queue.EnterAsync(key, DecoderProtocol.MaxBytes, cancel.Token))
            )
            .ToArray();
        Assert.All(waiting, task => Assert.False(task.IsCompleted));
        var full = queue.EnterAsync(7, 1, default);
        Assert.True(full.IsCompleted);
        Assert.Equal(
            DecoderProtocol.Busy,
            (await Assert.ThrowsAsync<ImageProcessingException>(() => full)).Message
        );
        first.Dispose();
        using var running = await waiting[0].WaitAsync(TimeSpan.FromSeconds(2));
        var fitsNow = queue.EnterAsync(7, DecoderProtocol.MaxBytes, cancel.Token);
        Assert.False(fitsNow.IsCompleted);
        cancel.Cancel();
        foreach (var task in waiting.Skip(1).Append(fitsNow))
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task);
    }

    [Fact]
    public async Task Absent_worker_fails_closed_for_storage_and_legacy_inline_hydration()
    {
        using var temp = new TempDirectory();
        var log = new List<string>();
        var missing = new ImageDecoderProcess(Path.Combine(temp.Path, "missing-decoder"), log.Add);
        var store = new ImageBlobStore(
            temp.Path,
            decoder: new TenantImageDecoder(1, missing, new())
        );
        var gif = Convert.FromBase64String(
            "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
        );
        var error = await Assert.ThrowsAsync<ImageProcessingException>(() =>
            store.PutAsync(gif, "image/gif", "img")
        );
        Assert.Equal(DecoderProtocol.Failed, error.Message);
        Assert.NotEmpty(log);
        var input = new System.Text.Json.Nodes.JsonObject
        {
            ["role"] = "user",
            ["parts"] = new System.Text.Json.Nodes.JsonArray(
                new System.Text.Json.Nodes.JsonObject
                {
                    ["inlineData"] = new System.Text.Json.Nodes.JsonObject
                    {
                        ["mimeType"] = "image/gif",
                        ["data"] = Convert.ToBase64String(gif),
                    },
                }
            ),
        };
        error = await Assert.ThrowsAsync<ImageProcessingException>(() =>
            store.HydrateAsync([input], "responses")
        );
        Assert.Equal(DecoderProtocol.Failed, error.Message);
    }
}
