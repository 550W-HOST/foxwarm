using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Vector;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorInitializationTests
{
    private const string Session = "upgrade";

    internal static async Task SeedAsync(VectorFixture f, int count)
    {
        var archive = f.Archive(Session);
        archive.EnsureBranch();
        var blocks = Enumerable
            .Range(1, count)
            .Select(index =>
                f.Block(
                    Session,
                    block: index,
                    first: index,
                    last: index,
                    summary: "violet StableMixedIdentifier"
                ) with
                {
                    Agent = "main",
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
        // Reproduce a pre-upgrade native table even when Main created the fixture first.
        using var connection = new lancedb.Connection();
        await connection.Connect(f.Dense);
        using var native = await connection.OpenTable("messages_v7");
        await native.ReplaceFieldMetadata("start_timestamp", new Dictionary<string, string>());
    }

    private static int Versions(VectorFixture f) =>
        Directory
            .GetFiles(Path.Combine(f.Dense, "messages_v7.lance", "_versions"), "*.manifest")
            .Length;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Main_HTTP_and_Sessions_are_available_before_historical_repair_completes(
        bool child
    )
    {
        await using var f = await VectorFixture.CreateAsync();
        await using (var seed = await f.ManagerAsync())
            await seed.CreateNamedAsync("main", "upgrade", null, null);
        await SeedAsync(f, 4096);
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "config.yaml"),
            new JsonObject
            {
                ["dbWorkers"] = child,
                ["vector"] = new JsonObject { ["baseUrl"] = f.Peer.BaseUrl },
                ["vectorMaintenance"] = false,
            }.ToJsonString()
        );
        var versions = Versions(f);
        var settings = await HttpServerSettings.CaptureDesktopAsync(f.Data);
        var watch = Stopwatch.StartNew();
        await using var host = await MainHost.CreateAsync(
            [],
            f.Data,
            f.Work,
            new ModelConfiguration(f.Data),
            settings,
            null
        );
        await host.StartAsync();
        using var client = new HttpClient { BaseAddress = new(settings.Address.BaseUrl) };
        client.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("health")).StatusCode);
        var elapsed = watch.ElapsedMilliseconds;
        using var search = await client.GetAsync("api/history/search?query=violet");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, search.StatusCode);
        Assert.Contains("VECTOR_UNAVAILABLE", await search.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("api/sessions")).StatusCode);
        Assert.True(Versions(f) < versions + 33);
        Console.WriteLine(
            $"Main readiness: child={child}, HTTP={elapsed} ms, repair versions={Versions(f) - versions}/33"
        );
        await VectorStorageTests.UntilAsync(() => Versions(f) > versions);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("health")).StatusCode);
        Assert.True(Versions(f) < versions + 33);
        // Host disposal interrupts committed batches; the next owner resumes existing native commits.
        await host.DisposeAsync();
        var interruptedVersions = Versions(f);
        await using var resumed = new VectorService(f.Data, f.Configuration(child));
        await resumed.StartAsync();
        await resumed.WaitForStartupAsync();
        Assert.True(resumed.Ready);
        Assert.InRange(Versions(f) - versions, 33, 34);
        Assert.Equal(
            1,
            VectorRuntime.Integer(
                Assert.Single(
                    (
                        await resumed.SearchAsync(
                            "violet",
                            5,
                            new(SessionIds: [Session], StartTime: 1000, EndTime: 1500)
                        )
                    ).Hits
                )["block_id"]
            )
        );
        Console.WriteLine(
            $"Resumed: child={child}, before restart={interruptedVersions - versions} versions, total={Versions(f) - versions}, elapsed={watch.ElapsedMilliseconds} ms"
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Recall_during_repair_uses_bounded_exact_Archive_fallback_and_source_dates(
        bool child
    )
    {
        await using var f = await VectorFixture.CreateAsync();
        await using (var seed = await f.ManagerAsync())
        {
            var seededOwner = await seed.CreateNamedAsync("main", "upgrade", null, null);
            await ForkClearLifecycleTests.AppendAsync(
                seededOwner,
                VectorFixture.Message("persisted authority")
            );
        }
        await SeedAsync(f, 4096);
        await using var manager = await f.ManagerAsync(child: child, waitForVector: false);
        Assert.False(manager.Vector.Ready);
        var recalled = await VectorRecall.SearchAsync(
            manager.Vector,
            manager.ArchiveReader,
            "StableMixedIdentifier",
            5,
            new(SessionIds: [Session], StartTime: 1000, EndTime: 1500),
            "current-session",
            Session,
            bounded: true
        );
        Assert.Equal("bounded identifier fallback (Vector unavailable)", recalled.SearchLabel);
        Assert.Single(recalled.Sources);
        Assert.Empty(f.Peer.Requests);
        Assert.False(manager.Vector.Ready);
        var owner = await manager.RequiredAsync(Session);
        var structured = await ArchiveRecallTool.ExecuteAsync(
            manager,
            owner,
            new JsonObject
            {
                ["vector_query"] = "StableMixedIdentifier",
                ["scope"] = "current-session",
                ["startTime"] = "1970-01-01T00:00:01Z",
                ["endTime"] = "1970-01-01T00:00:01.5Z",
            },
            programmatic: true
        );
        Assert.Null(structured["error"]);
        Assert.False(structured["complete"]!.GetValue<bool>());
        Assert.True(structured["bounded"]!.GetValue<bool>());
        Assert.Single(structured["items"]!.AsArray());
        var unavailable = await Assert.ThrowsAsync<VectorUnavailableException>(() =>
            VectorRecall.SearchAsync(
                manager.Vector,
                manager.ArchiveReader,
                "StableMixedIdentifier",
                5,
                new(),
                "current-agent",
                null
            )
        );
        Assert.Equal("VECTOR_UNAVAILABLE", unavailable.Code);
    }

    [Fact]
    public async Task Child_completes_historical_upgrade_before_ready_and_reopens_without_repair_updates()
    {
        await using var f = await VectorFixture.CreateAsync();
        await SeedAsync(f, 4096);
        var initialVersions = Versions(f);
        var watch = Stopwatch.StartNew();
        await using (var service = new VectorService(f.Data, f.Configuration(child: true)))
        {
            var starting = service.StartAsync();
            Assert.False(service.Ready);
            await starting.WaitAsync(TimeSpan.FromMinutes(5));
            Assert.True(service.Ready);
            Assert.Equal(initialVersions + 33, Versions(f));
            await service.WaitForStartupAsync();
            Console.WriteLine(
                $"Child upgrade: 4096 historical blocks, {watch.ElapsedMilliseconds} ms, {Versions(f) - initialVersions} versions"
            );
            Assert.Equal(
                4096,
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
        await SeedAsync(f, 4096);
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
        await SeedAsync(f, 4096);
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
