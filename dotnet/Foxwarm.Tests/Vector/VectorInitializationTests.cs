using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Vector;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorInitializationTests
{
    private const string Session = "main/upgrade";

    private static async Task SeedAsync(VectorFixture f, int count)
    {
        var archive = f.Archive(Session);
        archive.EnsureBranch();
        var blocks = Enumerable
            .Range(1, count)
            .Select(index =>
                f.Block(Session, block: index, first: index, last: index) with
                {
                    RawStartTimestamp = index * 1000,
                    RawEndTimestamp = index * 1000 + 500,
                    CreatedAt = 9000000,
                    MemoryFacts = null,
                }
            )
            .ToArray();
        archive.WriteBlocks(blocks);
        archive.SetVectorCheckpoint(block: count);
        var rows = blocks
            .Select(block =>
            {
                var row = VectorRows.Block(block, archive)!;
                row["start_timestamp"] = 9000000;
                row["end_timestamp"] = 9000000;
                row["vector"] = new JsonArray(
                    VectorEmbeddingPeer
                        .Embedding("violet")
                        .Select(value => (JsonNode?)JsonValue.Create((double)value))
                        .ToArray()
                );
                return row;
            })
            .ToArray();
        using var table = new VectorTable();
        await table.OpenAsync(f.Dense);
        await table.AddAsync(rows, merge: false);
    }

    private static int Versions(VectorFixture f) =>
        Directory
            .GetFiles(Path.Combine(f.Dense, "messages_v7.lance", "_versions"), "*.manifest")
            .Length;

    [Fact]
    public async Task Child_completes_historical_upgrade_before_ready_and_reopens_without_repair_updates()
    {
        await using var f = await VectorFixture.CreateAsync();
        await SeedAsync(f, 700);
        var watch = Stopwatch.StartNew();
        await using (var service = new VectorService(f.Data, f.Configuration(child: true)))
        {
            var starting = service.StartAsync();
            Assert.False(service.Ready);
            await starting.WaitAsync(TimeSpan.FromMinutes(5));
            Assert.True(service.Ready);
            await service.WaitForStartupAsync();
            Console.WriteLine(
                $"Child upgrade: 700 historical blocks, {watch.ElapsedMilliseconds} ms"
            );
            Assert.Equal(
                700,
                VectorRuntime.Integer((await service.StatusAsync(Session))["lastIndexedBlockId"])
            );
            Assert.Equal(
                1,
                VectorRuntime.Integer(
                    Assert.Single(
                        (
                            await service.SearchAsync(
                                "violet",
                                5,
                                new(SessionIds: [Session], StartTime: 1000, EndTime: 1500)
                            )
                        ).Hits
                    )["block_id"]
                )
            );
        }
        var versions = Versions(f);
        watch.Restart();
        await using (var reopened = new VectorService(f.Data, f.Configuration(child: true)))
        {
            await reopened.StartAsync();
            await reopened.WaitForStartupAsync();
            Assert.True(reopened.Ready);
            Assert.Equal(versions, Versions(f));
            Console.WriteLine(
                $"Child upgrade reopen: {watch.ElapsedMilliseconds} ms, no new native versions"
            );
        }
    }

    [Fact]
    public async Task Disposal_during_required_initialization_settles_the_owned_child()
    {
        await using var f = await VectorFixture.CreateAsync();
        await SeedAsync(f, 700);
        var versions = Versions(f);
        await using var service = new VectorService(f.Data, f.Configuration(child: true));
        var starting = service.StartAsync();
        await VectorStorageTests.UntilAsync(() => Versions(f) > versions);
        Assert.False(starting.IsCompleted);
        Assert.False(service.Ready);
        using var process = Process.GetProcessById(service.ChildPid!.Value);
        await service.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.ThrowsAnyAsync<Exception>(() => starting);
        Assert.True(process.HasExited);
        Assert.Null(service.ChildPid);
        Assert.False(service.Ready);
    }

    [Fact]
    public async Task Parent_disconnect_during_initialization_cancels_the_child_without_a_second_pipe_reader()
    {
        await using var f = await VectorFixture.CreateAsync();
        await SeedAsync(f, 700);
        var versions = Versions(f);
        var name = "foxwarm-vector-test-" + Guid.NewGuid().ToString("N");
        using var pipe = new NamedPipeServerStream(
            name,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly
        );
        using var process = Process.Start(VectorService.ChildStart(name))!;
        try
        {
            await pipe.WaitForConnectionAsync().WaitAsync(TimeSpan.FromSeconds(10));
            using var sending = new SemaphoreSlim(1, 1);
            await VectorWire.WriteAsync(
                pipe,
                sending,
                new JsonObject
                {
                    ["version"] = 1,
                    ["id"] = 1,
                    ["method"] = "init",
                    ["input"] = new JsonObject
                    {
                        ["root"] = f.Data,
                        ["configuration"] = JsonSerializer.SerializeToNode(
                            f.Configuration(child: true),
                            VectorWire.Json
                        ),
                    },
                }
            );
            await VectorStorageTests.UntilAsync(() => Versions(f) > versions);
            pipe.Dispose();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(process.HasExited);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill();
                await process.WaitForExitAsync();
            }
        }
    }

    [Fact]
    public async Task Child_initialization_failure_is_unavailable_and_reopening_after_repair_recovers()
    {
        await using var f = await VectorFixture.CreateAsync();
        await SeedAsync(f, 3);
        void SetKind(string kind)
        {
            using var db = new SqliteConnection($"Data Source={f.Database};Pooling=False");
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText =
                "UPDATE archive_blocks SET source_kind=$kind WHERE session_id=$session AND id=2";
            command.Parameters.AddWithValue("$kind", kind);
            command.Parameters.AddWithValue("$session", Session);
            command.ExecuteNonQuery();
        }
        SetKind("unsupported");
        await using (var service = new VectorService(f.Data, f.Configuration(child: true)))
        {
            await Assert.ThrowsAnyAsync<Exception>(() => service.StartAsync());
            Assert.False(service.Ready);
            Assert.Equal(
                "VECTOR_UNAVAILABLE",
                (
                    await Assert.ThrowsAsync<VectorUnavailableException>(() =>
                        service.SearchAsync("violet", 5)
                    )
                ).Code
            );
        }
        SetKind("message");
        await using var recovered = new VectorService(f.Data, f.Configuration(child: true));
        await recovered.StartAsync();
        await recovered.WaitForStartupAsync();
        Assert.True(recovered.Ready);
        Assert.Equal(
            3,
            (
                await recovered.SearchAsync(
                    "violet",
                    5,
                    new(SessionIds: [Session], StartTime: 1000, EndTime: 4000)
                )
            )
                .Hits
                .Count
        );
    }
}
