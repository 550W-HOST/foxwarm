using Foxwarm.Images;

namespace Foxwarm.Tests;

public sealed class DecoderAdmissionTests
{
    [Fact]
    public async Task Two_workers_serve_distinct_tenants_and_rotate_backlogged_tenants_in_order()
    {
        var queue = new DecoderAdmission();
        using var first = await queue.EnterAsync(1, default);
        var more = queue.EnterAsync(1, default);
        using var second = await queue.EnterAsync(2, default);
        var third = queue.EnterAsync(3, default);
        var fourth = queue.EnterAsync(4, default);
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
        using var first = await queue.EnterAsync(1, default);
        using var second = await queue.EnterAsync(2, default);
        using var stop = new CancellationTokenSource();
        var cancelled = queue.EnterAsync(3, stop.Token);
        var expires = queue.EnterAsync(1, default);
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        var failure = await Assert.ThrowsAsync<ImageProcessingException>(() => expires);
        Assert.Equal(DecoderProtocol.Busy, failure.Message);
        first.Dispose();
        second.Dispose();
        using var a = await queue.EnterAsync(1, default);
        using var b = await queue.EnterAsync(3, default);
    }

    [Fact]
    public async Task Absent_worker_fails_closed_for_storage_and_legacy_inline_hydration()
    {
        using var temp = new TempDirectory();
        var log = new List<string>();
        var missing = new ImageDecoderProcess(Path.Combine(temp.Path, "missing-decoder"), log.Add);
        var store = new ImageBlobStore(temp.Path, decoder: new TenantImageDecoder(1, missing));
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
