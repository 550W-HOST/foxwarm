using System.Text.Json.Nodes;
using Foxwarm.Limits;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Tests.Limits;

// The blob limit's write admission: reservations, one write per key, the measurement, an
// artifact's writes together, and the Session authorities' image writes.
public sealed partial class TenantLimitAdmissionTests
{
    // A 1×1 PNG.
    private static readonly byte[] Pixel = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    );

    // A blob store whose creates can be held, made to fail, or counted; its synchronous
    // existence check fails, so admission must not use it.
    private sealed class ControlledStore(IBlobStore inner) : IBlobStore
    {
        internal TaskCompletionSource? Hold;
        internal readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal Exception? Fail;
        internal int Creates;
        internal long? LostPutDeadline;

        public Task<bool> CreateAsync(string key, ReadOnlyMemory<byte> content, bool keepExisting,
            Action<long?> uncertain, CancellationToken token)
        {
            if (LostPutDeadline is long deadline)
            {
                uncertain(deadline);
                throw new IOException("PUT outcome unknown");
            }
            return CreateAsync(key, content, keepExisting, token);
        }

        public bool Exists(string key) => throw new InvalidOperationException("Synchronous existence check.");

        public Task<bool> ExistsAsync(string key, CancellationToken token) => Task.FromResult(inner.Exists(key));

        public async Task<bool> CreateAsync(string key, ReadOnlyMemory<byte> content, bool keepExisting, CancellationToken token)
        {
            Interlocked.Increment(ref Creates);
            Entered.TrySetResult();
            if (Hold is { } hold)
                await hold.Task.WaitAsync(token);
            if (Fail is { } fail)
                throw fail;
            return await inner.CreateAsync(key, content, keepExisting, token);
        }

        public Task<byte[]> ReadAllAsync(string key, CancellationToken token) => inner.ReadAllAsync(key, token);

        public Stream OpenRead(string key) => inner.OpenRead(key);

        public Task<byte[]> ReadRangeAsync(string key, long offset, int count, CancellationToken token) =>
            inner.ReadRangeAsync(key, offset, count, token);

        public IReadOnlyList<string> List(string prefix) => inner.List(prefix);

        public string? LocalPath(string key) => inner.LocalPath(key);
    }

    [Fact]
    public async Task AnAbsentHeadAfterTheDeadlineRefundsAndForcesOneMoreMeasurement()
    {
        using var temp = new TempDirectory();
        var inner = new ControlledStore(new Foxwarm.Images.ImageBlobFiles(temp.Path))
            { LostPutDeadline = Environment.TickCount64 - 1 };
        long stored = 0;
        var quota = new BlobQuota(100, _ => Task.FromResult(stored));
        await Assert.ThrowsAsync<IOException>(() => quota.Apply(inner).CreateAsync(Key('a'), new byte[100], true, default));
        Assert.Equal(0, await quota.UsedAsync(default));
        stored = 100; // A server commit just after the client's final negative observation.
        Assert.Equal(100, await quota.UsedAsync(default));
    }

    [Fact]
    public async Task ReusingContentDoesNotRequireAUsageMeasurement()
    {
        using var temp = new TempDirectory();
        var inner = new Foxwarm.Images.ImageBlobFiles(temp.Path);
        await inner.CreateAsync(Key('a'), Pixel, true, default);
        var quota = new BlobQuota(0, _ => throw new IOException("storage unavailable"));
        Assert.False(await quota.Apply(inner).CreateAsync(Key('a'), Pixel, true, default));
    }

    [Fact]
    public async Task ReusingAnArtifactRasterReservesOnlyItsRevision()
    {
        using var temp = new TempDirectory();
        var inner = new Foxwarm.Artifacts.ArtifactBlobFiles(temp.Path);
        var first = new Foxwarm.Artifacts.ArtifactStore(temp.Path, blobs: inner);
        var document = await new Foxwarm.Artifacts.ArtifactPreparer().ImageAsync(Pixel, "Blue", null, default);
        var receipt = await first.PublishAsync("owner", document, image: Pixel);
        var id = receipt["receipt"]!["artifactId"]!.GetValue<string>();
        var manifestBytes = System.Text.Encoding.UTF8.GetByteCount(receipt.ToJsonText());
        var used = manifestBytes + Pixel.Length;
        var quota = new BlobQuota(used + manifestBytes, _ => Task.FromResult((long)used));
        var store = new Foxwarm.Artifacts.ArtifactStore(temp.Path, blobs: quota.Apply(inner));
        document["title"] = "Gold";
        var second = await store.PublishAsync("owner", document, id, 1, image: Pixel);
        Assert.Equal(2, second["receipt"]!["revision"]!.GetValue<long>());
        Assert.Equal(used + manifestBytes, await quota.UsedAsync(default));
    }

    [Fact]
    public async Task BlobReservationsAreAtomicAndReturnedOnDuplicateFailureAndCancellation()
    {
        using var temp = new TempDirectory();
        var store = new ControlledStore(new Foxwarm.Images.ImageBlobFiles(temp.Path))
        {
            Hold = new(TaskCreationOptions.RunContinuationsAsynchronously),
        };
        var quota = new BlobQuota(1000, _ => Task.FromResult(0L));
        var limited = quota.Apply(store);
        // A write in flight holds its bytes: a second that fits alone but not beside it is refused.
        var first = limited.CreateAsync(Key('a'), new byte[600], keepExisting: true, default);
        await store.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(600, quota.ReservedBytes);
        await Assert.ThrowsAsync<TenantLimitException>(() =>
            limited.CreateAsync(Key('b'), new byte[600], keepExisting: true, default).WaitAsync(TimeSpan.FromSeconds(5))
        );
        store.Hold.SetResult();
        Assert.True(await first);
        Assert.Equal(0, quota.ReservedBytes);
        Assert.Equal(600, await quota.UsedAsync(default));
        // A duplicate costs nothing.
        Assert.False(await limited.CreateAsync(Key('a'), new byte[300], keepExisting: true, default));
        Assert.Equal(600, await quota.UsedAsync(default));
        // A failed write returns its reservation.
        store.Fail = new IOException("disk failure");
        await Assert.ThrowsAsync<IOException>(() =>
            limited.CreateAsync(Key('c'), new byte[300], keepExisting: true, default)
        );
        store.Fail = null;
        Assert.Equal(0, quota.ReservedBytes);
        // So does a cancelled one.
        store.Hold = new(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancel = new CancellationTokenSource();
        var cancelled = limited.CreateAsync(Key('d'), new byte[300], keepExisting: true, cancel.Token);
        await WaitForAsync(() => quota.ReservedBytes == 300);
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        Assert.Equal(0, quota.ReservedBytes);
        Assert.Equal(600, await quota.UsedAsync(default));
    }

    [Fact]
    public async Task CreatesOfOneKeyShareTheFirstWrite()
    {
        using var temp = new TempDirectory();
        var store = new ControlledStore(new Foxwarm.Images.ImageBlobFiles(temp.Path))
        {
            Hold = new(TaskCreationOptions.RunContinuationsAsynchronously),
        };
        var quota = new BlobQuota(1000, _ => Task.FromResult(0L));
        var limited = quota.Apply(store);
        var first = limited.CreateAsync(Key('a'), new byte[600], keepExisting: true, default);
        await store.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // The same content again: it waits for the first write instead of reserving again.
        var second = limited.CreateAsync(Key('a'), new byte[600], keepExisting: true, default);
        await Task.Delay(100);
        Assert.False(second.IsCompleted);
        store.Hold.SetResult();
        Assert.True(await first.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.False(await second.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(1, store.Creates);
        Assert.Equal(600, await quota.UsedAsync(default));
    }

    [Fact]
    public async Task AFailedMeasurementIsAStorageErrorAndIsTriedAgain()
    {
        using var temp = new TempDirectory();
        var measurements = 0;
        var quota = new BlobQuota(
            1000,
            _ => ++measurements == 1 ? throw new IOException("storage unavailable") : Task.FromResult(100L)
        );
        var limited = quota.Apply(new Foxwarm.Images.ImageBlobFiles(temp.Path));
        await Assert.ThrowsAsync<IOException>(() =>
            limited.CreateAsync(Key('a'), new byte[10], keepExisting: true, default)
        );
        Assert.True(await limited.CreateAsync(Key('a'), new byte[10], keepExisting: true, default));
        Assert.Equal(2, measurements);
        Assert.Equal(110, await quota.UsedAsync(default));
    }

    [Fact]
    public async Task AnArtifactsResourceAndRevisionAreAdmittedTogether()
    {
        using var temp = new TempDirectory();
        var document = await new Foxwarm.Artifacts.ArtifactPreparer().ImageAsync(Pixel, "Pixel", null, default);
        // Room for the image, not for the image and its revision.
        var quota = new BlobQuota(Pixel.Length + 16, _ => Task.FromResult(0L));
        var store = new Foxwarm.Artifacts.ArtifactStore(
            temp.Path,
            blobs: quota.Apply(new Foxwarm.Artifacts.ArtifactBlobFiles(temp.Path))
        );
        var error = await Assert.ThrowsAsync<TenantLimitException>(() =>
            store.PublishAsync("owner", document, image: Pixel)
        );
        Assert.Equal("blobBytes", error.Limit);
        // Nothing was stored, so nothing is counted.
        Assert.Equal(0, await quota.UsedAsync(default));
        Assert.Equal(0, quota.ReservedBytes);
    }

    [Fact]
    public async Task AuthorityImageWritesCountAgainstTheBlobLimit()
    {
        await using var f = await Fixture.Create(Limits with { BlobBytes = 16 });
        var owner = await f.Manager.CreateNamedAsync("main", "images", null, null);
        JsonObject Message() =>
            new()
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["inlineData"] = new JsonObject
                        {
                            ["mimeType"] = "image/png",
                            ["data"] = Convert.ToBase64String(Pixel),
                        },
                    }
                ),
            };
        // New input (queue ingress, a tool result) is refused at the limit.
        await Assert.ThrowsAsync<TenantLimitException>(() =>
            owner.AuthorityStore.Images.ExternalizeMessageAsync(Message())
        );
        // A write a commit needs is admitted over the limit, and counted.
        using (BlobQuota.AllowOverLimit(owner.AuthorityStore.Images.Blobs))
            await owner.AuthorityStore.Images.ExternalizeMessageAsync(Message());
        Assert.Equal(Pixel.Length, await f.Manager.BlobQuota!.UsedAsync(default));
    }

    private static async Task WaitForAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
                throw new TimeoutException("Condition not reached.");
            await Task.Delay(10);
        }
    }
}
