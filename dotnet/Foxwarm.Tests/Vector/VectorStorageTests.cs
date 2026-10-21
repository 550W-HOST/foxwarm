using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorStorageTests
{
    [Fact]
    public async Task Disabled_owner_has_no_directory_native_owner_embedding_or_lifecycle_side_effects()
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "disabled");
        await using var service = new VectorService(
            root,
            VectorConfiguration.Capture(new() { ["vector"] = false })
        );
        await service.StartAsync();
        await service.ScheduleAsync("main/unused", 3, 8000, 1);
        await service.RenameAsync("main/old", "main/new");
        await service.ForkAsync("main/fork");
        await service.ResetAsync("main/unused");
        var error = await Assert.ThrowsAsync<VectorUnavailableException>(() =>
            service.SearchAsync("needle", 5)
        );
        Assert.Equal("VECTOR_DISABLED", error.Code);
        Assert.False(error.Retryable);
        Assert.Null(service.ChildPid);
        Assert.Equal("disabled", service.Mode);
        Assert.False(Directory.Exists(root));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Actual_owner_indexes_committed_SQLite_and_searches_in_each_dbWorkers_mode(
        bool child
    )
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "main/owner'quoted";
        f.Append(id, 1, "violet initial context");
        f.Append(id, 2, "orange alternate context");
        var block = f.Block(id, first: 1, last: 2);
        f.Archive(id).WriteBlocks([block]);
        await using var service = new VectorService(
            f.Data,
            f.Configuration(child) with
            {
                MaintenanceEnabled = true,
            }
        );
        await service.StartAsync();
        await service.WaitForStartupAsync();
        Assert.Equal(child ? "worker" : "local", service.Mode);
        Assert.Equal(child, service.ChildPid.HasValue);
        var status = await service.StatusAsync(id);
        Assert.Equal(2, VectorRuntime.Integer(status["lastIndexedSeq"]));
        Assert.Equal(1, VectorRuntime.Integer(status["lastIndexedBlockId"]));
        await service.FactsAsync(block);
        await service.FactsAsync(block);
        var result = await service.SearchAsync("violet", 10, new(SessionIds: [id]));
        Assert.NotEmpty(result.Hits);
        Assert.All(result.Hits, hit => Assert.Equal(id, hit["session_id"]!.GetValue<string>()));
        Assert.Contains(result.Hits, hit => hit["matched_facts"] is JsonArray { Count: 1 });
        Assert.All(f.Peer.Requests, request => Assert.Equal("qwen3-embedding:0.6b", request.Model));
        Assert.Contains(
            f.Peer.Requests,
            request => request.Input == VectorText.QueryPrefix + "violet"
        );
        f.Append(id, 3, "violet committed suffix");
        await service.ScheduleAsync(id, 3, 10, 1);
        Assert.Equal(2, VectorRuntime.Integer((await service.StatusAsync(id))["lastIndexedSeq"]));
        Assert.NotNull((await service.StatusAsync(id))["maxLatencyDeadline"]);
        Assert.Equal(3, await service.ForceAsync(id, 3, 1));
        Assert.Contains(
            "committed suffix",
            (await service.SearchAsync("violet", 5, new(SessionIds: [id]))).Hits.First(hit =>
                hit["kind"]!.GetValue<string>() == "raw"
            )["text"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Force_returns_its_captured_run_without_waiting_for_later_committed_appends()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "main/captured-force";
        f.Append(id, 1, "violet initial");
        await using var runtime = new VectorRuntime(f.Data, f.Configuration());
        await runtime.StartAsync();
        await runtime.WaitForStartupAsync();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Peer.BeforeResponse = async _ =>
        {
            entered.TrySetResult();
            await release.Task;
        };
        f.Append(id, 2, "violet captured suffix");
        runtime.Schedule(id, 2, 10, 0);
        var forced = runtime.ForceAsync(id, 2, 0);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            f.Append(id, 3, "violet later append");
            runtime.Schedule(id, 3, 10, 0);
            release.TrySetResult();
            Assert.Equal(2, await forced.WaitAsync(TimeSpan.FromSeconds(5)));
            var status = runtime.Status(id);
            Assert.Equal(2, VectorRuntime.Integer(status["lastIndexedSeq"]));
            Assert.Equal(3, VectorRuntime.Integer(status["latestLocalMessageSeq"]));
            Assert.Equal(1, VectorRuntime.Integer(status["pendingMessageCount"]));
            Assert.NotNull(status["maxLatencyDeadline"]);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task Dense_tail_deletion_precedes_embedding_failure_and_retry_rebuilds_without_advancing_failed_progress()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "main/failure";
        f.Append(id, 1, "violet initial");
        await using var runtime = new VectorRuntime(f.Data, f.Configuration());
        await runtime.StartAsync();
        await runtime.WaitForStartupAsync();
        f.Append(id, 2, "violet new suffix");
        f.Peer.Fail = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => runtime.ForceAsync(id, 2, 0));
        Assert.Equal(1, f.Archive(id).VectorCheckpoint().RawLastIndexedSeq);
        f.Peer.Fail = false;
        Assert.Empty((await runtime.SearchAsync("violet", 5, new(SessionIds: [id]))).Hits);
        Assert.Equal(2, await runtime.ForceAsync(id, 2, 0));
        var repaired = (
            await runtime.SearchAsync("violet", 5, new(SessionIds: [id]))
        ).Hits.Single();
        Assert.Contains("initial", repaired["text"]!.GetValue<string>());
        Assert.Contains("new suffix", repaired["text"]!.GetValue<string>());
        Assert.Equal(1, f.Archive(id).VectorCheckpoint().RawTailStartSeq);
        var requests = f.Peer.Requests.Count;
        Assert.Equal(2, await runtime.ForceAsync(id, 2, 0));
        Assert.Equal(requests, f.Peer.Requests.Count);
    }

    [Fact]
    public async Task Worker_exit_rejects_pending_call_and_replacement_waits_for_confirmed_exit_without_local_fallback()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "main/supervision";
        f.Append(id, 1, "violet persisted after restart");
        await using var service = new VectorService(f.Data, f.Configuration(child: true));
        await service.StartAsync();
        await service.WaitForStartupAsync();
        var oldPid = service.ChildPid!.Value;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Peer.BeforeResponse = async input =>
        {
            if (input.StartsWith(VectorText.QueryPrefix, StringComparison.Ordinal))
            {
                entered.TrySetResult();
                await release.Task;
            }
        };
        var pending = service.SearchAsync("violet", 5, new(SessionIds: [id]));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var process = Process.GetProcessById(oldPid);
        process.Kill();
        await process.WaitForExitAsync();
        var error = await Assert.ThrowsAsync<VectorUnavailableException>(() =>
            pending.WaitAsync(TimeSpan.FromSeconds(5))
        );
        Assert.Equal("VECTOR_UNAVAILABLE", error.Code);
        release.TrySetResult();
        f.Peer.BeforeResponse = null;
        await UntilAsync(() => service.Ready && service.ChildPid is { } pid && pid != oldPid);
        await service.WaitForStartupAsync();
        Assert.Equal("worker", service.Mode);
        Assert.NotEmpty((await service.SearchAsync("violet", 5, new(SessionIds: [id]))).Hits);
        await service.DisposeAsync();
        Assert.Null(service.ChildPid);
        await Assert.ThrowsAsync<VectorUnavailableException>(() =>
            service.SearchAsync("violet", 5)
        );
    }

    internal static async Task UntilAsync(Func<bool> condition)
    {
        var timeout = Stopwatch.StartNew();
        while (!condition())
        {
            if (timeout.Elapsed > TimeSpan.FromSeconds(10))
                throw new TimeoutException("Expected Vector owner condition did not settle.");
            await Task.Delay(25);
        }
    }
}
