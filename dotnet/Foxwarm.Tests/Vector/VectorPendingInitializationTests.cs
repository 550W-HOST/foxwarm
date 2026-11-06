using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorPendingInitializationTests
{
    private sealed class InitializationGate : IDisposable
    {
        private const string MissingSource = "main/repair-gate";
        private readonly TaskCompletionSource entered = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        private readonly TaskCompletionSource release = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );

        internal static async Task<InitializationGate> CreateAsync(VectorFixture fixture)
        {
            // An unavailable source exercises the existing diagnostic after all Archive
            // read connections have closed, before initialization can finish.
            var row = VectorRows.Block(
                fixture.Block(MissingSource),
                fixture.Archive(MissingSource)
            )!;
            row["vector"] = new JsonArray(
                VectorEmbeddingPeer
                    .Embedding("violet")
                    .Select(value => (JsonNode?)JsonValue.Create((double)value))
                    .ToArray()
            );
            using var table = new VectorTable();
            await table.OpenAsync(fixture.Dense);
            await table.AddAsync([row], merge: false);
            return new();
        }

        internal void Attach(VectorService service) =>
            service.Diagnostic = (code, session) =>
            {
                if (code != "VECTOR_SOURCE_TIME_UNAVAILABLE" || session != MissingSource)
                    return;
                entered.TrySetResult();
                release.Task.GetAwaiter().GetResult();
            };

        internal Task WaitAsync() => entered.Task.WaitAsync(TimeSpan.FromSeconds(10));

        internal void Release() => release.TrySetResult();

        public void Dispose() => Release();
    }

    [Fact]
    public async Task Pending_mutations_dispatch_after_repair_without_losing_facts_baselines_or_indexing()
    {
        await using var f = await VectorFixture.CreateAsync();
        f.Append("main/rename", 1, "violet moved checkpoint");
        f.Append("main/parent", 1, "violet inherited source");
        await using (var seed = new VectorService(f.Data, f.Configuration()))
        {
            await seed.StartAsync();
            await seed.WaitForStartupAsync();
        }
        // Failed creation may leave derived rows without a committed Archive source.
        var orphanRows = VectorRows.Raw(
            VectorRows.Segments(f.Archive("main/rename").ReadMessages())[0]
        );
        foreach (var row in orphanRows)
        {
            row["id"] = "uncommitted-reset";
            row["session_id"] = "main/reset";
            row["vector"] = new JsonArray(
                VectorEmbeddingPeer
                    .Embedding("violet")
                    .Select(value => (JsonNode?)JsonValue.Create((double)value))
                    .ToArray()
            );
        }
        using (var table = new VectorTable())
        {
            await table.OpenAsync(f.Dense);
            await table.AddAsync(orphanRows, merge: false);
        }
        await VectorInitializationTests.SeedAsync(f, 4096);
        await using var service = new VectorService(f.Data, f.Configuration(lexical: true));
        using var gate = await InitializationGate.CreateAsync(f);
        gate.Attach(service);
        var starting = service.StartAsync();
        await gate.WaitAsync();
        Assert.False(service.Ready);
        Assert.True(service.Initializing);
        f.Append("main/scheduled", 1, "violet scheduled while repair pending");
        f.Archive("main/fork").EnsureBranch("main/parent", 1, 0);
        var block = f.Block("main/facts") with { RawStartTimestamp = 1000, RawEndTimestamp = 2000 };
        f.Archive("main/facts").EnsureBranch();
        f.Archive("main/facts").WriteBlocks([block]);
        // Ordinary startup backfill does not reconstruct facts at an already indexed block.
        f.Archive("main/facts").SetVectorCheckpoint(block: 1);
        var facts = service.FactsAsync(block);
        var schedule = service.ScheduleAsync("main/scheduled", 1, 9000, 0);
        var force = service.ForceAsync("main/scheduled", 1, 0);
        var rename = service.RenameAsync("main/rename", "main/renamed");
        var fork = service.ForkAsync("main/fork");
        var reset = service.ResetAsync("main/reset");
        var mutations = new Task[] { facts, schedule, force, rename, fork, reset };
        await Task.Delay(100);
        Assert.All(mutations, task => Assert.False(task.IsCompleted));
        gate.Release();
        await Task.WhenAll(mutations.Append(starting)).WaitAsync(TimeSpan.FromSeconds(20));
        await service.WaitForStartupAsync();
        Assert.Equal(1, await force);
        Assert.Equal(1, f.Archive("main/renamed").VectorCheckpoint().RawLastIndexedSeq);
        Assert.Equal(1, f.Archive("main/fork").VectorCheckpoint().RawLastIndexedSeq);
        Assert.Equal(2, f.Archive("main/fork").VectorCheckpoint().RawTailStartSeq);
        Assert.Equal(0, f.Archive("main/reset").VectorCheckpoint().RawLastIndexedSeq);
        Assert.Empty(
            (await service.SearchAsync("violet", 5, new(SessionIds: ["main/reset"]))).Hits
        );
        Assert.NotEmpty(
            (await service.SearchAsync("violet", 5, new(SessionIds: ["main/scheduled"]))).Hits
        );
        Assert.Contains(
            (await service.SearchAsync("violet", 5, new(SessionIds: ["main/facts"]))).Hits,
            hit => hit["matched_facts"] is JsonArray { Count: > 0 }
        );
    }

    [Fact]
    public async Task Main_move_waits_before_moving_Archive_and_fork_keeps_its_captured_baseline()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using (var seed = await f.ManagerAsync())
        {
            var moving = await seed.CreateNamedAsync("main", "upgrade", null, null);
            var parent = await seed.CreateNamedAsync("main", "parent", null, null);
            await ForkClearLifecycleTests.AppendAsync(
                moving,
                VectorFixture.Message("violet moving authority")
            );
            await ForkClearLifecycleTests.AppendAsync(
                parent,
                VectorFixture.Message("violet fork authority")
            );
            await seed.ForceVectorIndexAsync(moving);
            await seed.ForceVectorIndexAsync(parent);
        }
        await VectorInitializationTests.SeedAsync(f, 4096);
        var gate = await InitializationGate.CreateAsync(f);
        await using var manager = await f.ManagerAsync(
            lexical: true,
            waitForVector: false,
            configureVector: gate.Attach
        );
        using var held = gate;
        await gate.WaitAsync();
        Assert.False(manager.Vector.Ready);
        Assert.True(manager.Vector.Initializing);
        var owner = await manager.RequiredAsync("upgrade");
        var parentOwner = await manager.RequiredAsync("parent");
        var movingTask = manager.MoveIdentityAsync(
            owner,
            new JsonObject { ["sessionId"] = owner.Id, ["newSessionId"] = "renamed" }
        );
        var forkingTask = manager.ForkAsync(parentOwner, "captured");
        await Task.Delay(100);
        Assert.False(movingTask.IsCompleted);
        Assert.False(forkingTask.IsCompleted);
        Assert.Equal(4096, f.Archive("upgrade").ReadBlocks().Count);
        Assert.Empty(f.Archive("renamed").ReadBlocks());
        Assert.Equal("upgrade", owner.Id);
        gate.Release();
        await Task.WhenAll(movingTask, forkingTask).WaitAsync(TimeSpan.FromSeconds(20));
        var fork = await forkingTask;
        Assert.Equal("renamed", owner.Id);
        Assert.Equal(4096, f.Archive("renamed").ReadBlocks().Count);
        Assert.Equal(1, fork.Archive.ReadBranch()!.MessageCap);
        Assert.True(fork.Archive.VectorCheckpoint().RawLastIndexedSeq >= 1);
        await manager.ForceVectorIndexAsync(fork);
        Assert.Equal(
            fork.Entry.Snapshot().NextMessageSeq - 1,
            fork.Archive.VectorCheckpoint().RawLastIndexedSeq
        );
        Assert.Contains(
            (
                await manager.Vector.SearchAsync(
                    "violet",
                    5,
                    new(SessionIds: ["upgrade"], StartTime: 1000, EndTime: 1500)
                )
            ).Hits,
            hit =>
                VectorText.Text(hit["session_id"]) == "upgrade"
                && VectorRuntime.Integer(hit["block_id"]) == 1
        );
        await manager.ClearAsync(owner);
        Assert.Equal(4096, owner.Archive.ReadBlocks().Count);
    }

    [Fact]
    public async Task Main_shutdown_cancels_pending_hook_waits_before_disposing_the_initializing_owner()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using (var seed = await f.ManagerAsync())
        {
            var owner = await seed.CreateNamedAsync("main", "writer", null, null);
            await ForkClearLifecycleTests.AppendAsync(
                owner,
                VectorFixture.Message("violet initial authority")
            );
        }
        await VectorInitializationTests.SeedAsync(f, 4096);
        var gate = await InitializationGate.CreateAsync(f);
        await using var manager = await f.ManagerAsync(
            waitForVector: false,
            configureVector: gate.Attach
        );
        using var held = gate;
        await gate.WaitAsync();
        Assert.False(manager.Vector.Ready);
        Assert.True(manager.Vector.Initializing);
        var writer = await manager.RequiredAsync("writer");
        await ForkClearLifecycleTests.AppendAsync(
            writer,
            VectorFixture.Message("violet committed during repair")
        );
        var force = manager.ForceVectorIndexAsync(writer);
        Assert.False(force.IsCompleted);
        var shutdown = manager.ShutdownAsync().WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            force.WaitAsync(TimeSpan.FromSeconds(10))
        );
        gate.Release();
        await shutdown;
        Assert.False(manager.Vector.Ready);
        Assert.Null(manager.Vector.ChildPid);
        Assert.Equal(2, f.Archive("writer").ReadMessages().Count);
    }
}
