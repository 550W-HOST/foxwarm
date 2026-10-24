using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorInteropTests
{
    private static JsonObject Record(string id, long seq, string text) =>
        new()
        {
            ["v"] = 1,
            ["kind"] = "message",
            ["sessionId"] = id,
            ["agent"] = "main",
            ["seq"] = seq,
            ["timestamp"] = seq * 1000,
            ["role"] = "user",
            ["message"] = new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
                ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq * 1000 },
            },
        };

    [Fact]
    public async Task Startup_matches_Source_for_retained_alias_rows_and_drains_later_canonical_work()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "main/retained-current";
        const string oldId = "main/retained-old";
        var input = new JsonObject
        {
            ["config"] = new JsonObject
            {
                ["vector"] = new JsonObject
                {
                    ["baseUrl"] = f.Peer.BaseUrl,
                    ["lexicalIndex"] = true,
                    ["hybridSearch"] = true,
                },
                ["dbWorkers"] = false,
                ["vectorMaintenance"] = false,
            },
            ["sessionId"] = id,
            ["oldSessionId"] = oldId,
            ["records"] = new JsonArray(Record(id, 1, "violet retained moved message")),
            ["blocks"] = JsonSerializer.SerializeToNode(new[] { f.Block(id) }, VectorWire.Json),
            ["append"] = Record(id, 2, "violet later legitimate queued work"),
            ["runSource"] = true,
        };
        var inputPath = Path.Combine(f.Temp.Path, "retained-input.json");
        await File.WriteAllTextAsync(inputPath, EcmaJson.Stringify(input));
        var source = await VectorFixture.SourceAsync(
            "retained-alias",
            Path.Combine(f.Temp.Path, "source"),
            inputPath,
            Path.Combine(f.Temp.Path, "source-result.json")
        );
        Assert.Equal(id, source["canonical"]!.GetValue<string>());
        Assert.Equal(id, Assert.Single(source["maxima"]!.AsArray())!["sessionId"]!.GetValue<string>());
        Assert.Equal(id, Assert.Single(source["candidates"]!.AsArray())!["sessionId"]!.GetValue<string>());
        Assert.Equal(2, source["physicalMessages"]!.AsArray().Count);
        Assert.Equal(2, source["physicalBlocks"]!.AsArray().Count);
        Assert.Equal(0, source["oldCheckpoint"]!["rawLastIndexedSeq"]!.GetValue<long>());
        Assert.Equal(0, source["oldCheckpoint"]!["lastIndexedBlockId"]!.GetValue<long>());
        Assert.Equal(2, source["currentCheckpoint"]!["rawLastIndexedSeq"]!.GetValue<long>());
        Assert.Equal(1, source["currentCheckpoint"]!["lastIndexedBlockId"]!.GetValue<long>());

        input["runSource"] = false;
        await File.WriteAllTextAsync(inputPath, EcmaJson.Stringify(input));
        await VectorFixture.SourceAsync(
            "retained-alias", f.Data, inputPath, Path.Combine(f.Temp.Path, "managed-seed.json")
        );
        Assert.Equal(id, f.Archive(oldId).CanonicalSessionId);
        Assert.Equal(id, Assert.Single(f.Archive(oldId).ReadMessages()).SessionId);
        await using (var runtime = new VectorRuntime(f.Data, f.Configuration(lexical: true)))
        {
            await runtime.StartAsync();
            await runtime.WaitForStartupAsync().WaitAsync(TimeSpan.FromSeconds(5));
            // Before the repair, dense startup forces the physical-only old ID,
            // and successful identity-mismatch exits requeue it forever.
            await runtime.Lexical.WaitForIdleAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(id, Assert.Single(f.Archive().LocalVectorMaxima()).SessionId);
            f.Append(id, 2, "violet later legitimate queued work");
            Assert.Equal(2, await runtime.ForceAsync(id, 2, 1));
            await runtime.Lexical.WaitForIdleAsync().WaitAsync(TimeSpan.FromSeconds(5));
            var hits = await runtime.Lexical.QueryAsync("legitimate", 5, new(SessionIds: [id]));
            Assert.Single(hits.Hits);
        }
        using var index = ArchiveSearchIndex.Open(Path.Combine(f.Dense, "archive-search.sqlite"));
        Assert.Equal(0, index.Checkpoint(oldId).RawLastIndexedSeq);
        Assert.Equal(0, index.Checkpoint(oldId).LastIndexedBlockId);
        Assert.Equal(2, index.Checkpoint(id).RawLastIndexedSeq);
        Assert.Equal(1, index.Checkpoint(id).LastIndexedBlockId);
        Assert.Equal(0, f.Archive(oldId).VectorCheckpoint().RawLastIndexedSeq);

        // The same retained Source data reopens through the supervised owner.
        await using (var child = new VectorService(f.Data, f.Configuration(child: true, lexical: true)))
        {
            await child.StartAsync();
            await child.WaitForStartupAsync().WaitAsync(TimeSpan.FromSeconds(5));
            f.Append(id, 3, "violet child later queued work");
            Assert.Equal(3, await child.ForceAsync(id, 3, 1));
            await child.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.Equal(3, index.Checkpoint(id).RawLastIndexedSeq);
        Assert.Equal(0, index.Checkpoint(oldId).RawLastIndexedSeq);
        using var archiveDb = new Microsoft.Data.Sqlite.SqliteConnection(
            new Microsoft.Data.Sqlite.SqliteConnectionStringBuilder
            {
                DataSource = f.Database,
                Mode = Microsoft.Data.Sqlite.SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        archiveDb.Open();
        using var count = archiveDb.CreateCommand();
        count.CommandText = "SELECT (SELECT count(*) FROM archive_messages WHERE session_id=$s) + (SELECT count(*) FROM archive_blocks WHERE session_id=$s)";
        count.Parameters.AddWithValue("$s", oldId);
        Assert.Equal(2L, count.ExecuteScalar());
    }

    [Fact]
    public async Task Real_Source_to_CSharp_to_Source_indexing_preserves_Archive_progress_Lance_rows_and_lineage_clipping()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "main/interop";
        var root = Path.Combine(f.Temp.Path, "interop");
        var block = f.Block(id, first: 1, last: 2);
        var config = new JsonObject
        {
            ["vector"] = new JsonObject
            {
                ["baseUrl"] = f.Peer.BaseUrl,
                ["lexicalIndex"] = true,
                ["hybridSearch"] = true,
            },
            ["dbWorkers"] = false,
            ["vectorMaintenance"] = false,
        };
        var input = new JsonObject
        {
            ["config"] = config,
            ["sessionId"] = id,
            ["records"] = new JsonArray(
                Record(id, 1, "violet Source first"),
                Record(id, 2, "violet Source second")
            ),
            ["blocks"] = JsonSerializer.SerializeToNode(new[] { block }, VectorWire.Json),
            ["facts"] = new JsonObject
            {
                ["sessionId"] = id,
                ["agent"] = "main",
                ["sourceStartSeq"] = 1,
                ["sourceEndSeq"] = 2,
                ["blockId"] = 1,
                ["blockLevel"] = 1,
                ["createdAt"] = 4000,
                ["facts"] = block.MemoryFacts!.DeepClone(),
            },
        };
        var inputPath = Path.Combine(f.Temp.Path, "interop-input.json");
        await File.WriteAllTextAsync(inputPath, EcmaJson.Stringify(input));
        var created = await VectorFixture.SourceAsync(
            "storage-create",
            root,
            inputPath,
            Path.Combine(f.Temp.Path, "source-created.json")
        );
        Assert.Equal(3, created["rows"]!.AsArray().Count);
        var archivePath = Path.Combine(root, "state", "archive-store.sqlite");
        var archive = new SqliteArchiveMessageStore(archivePath, id);
        Assert.Equal(2, archive.VectorCheckpoint().RawLastIndexedSeq);
        await using (var runtime = new VectorRuntime(root, VectorConfiguration.Capture(config)))
        {
            await runtime.StartAsync();
            await runtime.WaitForStartupAsync();
            Assert.True(runtime.Lexical.Status(id)["ready"]!.GetValue<bool>());
            var record = Record(id, 3, "violet CSharp third");
            archive.WriteMessages([
                ArchiveMessageRecord.Create(id, "main", 3, 3000, record["message"]!.AsObject()),
            ]);
            await runtime.ForceAsync(id, 3, 1);
            await runtime.IndexFactsAsync(block);
            var clipped = await runtime.SearchAsync(
                "violet",
                10,
                new(LineageSessions: [new(id, 2, 0)])
            );
            Assert.All(
                clipped.Hits,
                hit => Assert.DoesNotContain("CSharp third", hit.ToJsonString())
            );
            Assert.Contains(clipped.Hits, hit => VectorRuntime.Integer(hit["end_seq"]) == 2);
            await runtime.Lexical.WaitForIdleAsync();
        }
        input["append"] = Record(id, 4, "violet Source fourth");
        input["options"] = new JsonObject
        {
            ["lineageSessions"] = new JsonArray(
                new JsonObject
                {
                    ["sessionId"] = id,
                    ["maxMessageSeq"] = 2,
                    ["maxBlockId"] = 0,
                }
            ),
        };
        await File.WriteAllTextAsync(inputPath, EcmaJson.Stringify(input));
        var returned = await VectorFixture.SourceAsync(
            "storage-return",
            root,
            inputPath,
            Path.Combine(f.Temp.Path, "source-returned.json")
        );
        Assert.Equal(3, returned["checkpoint"]!["rawLastIndexedSeq"]!.GetValue<long>());
        Assert.Equal(1, returned["checkpoint"]!["lastIndexedBlockId"]!.GetValue<long>());
        Assert.Equal(3, returned["rows"]!.AsArray().Count);
        Assert.Contains(
            returned["rows"]!.AsArray(),
            row => row!["id"]!.GetValue<string>() == id + ":1-4:0"
        );
        Assert.All(
            returned["hits"]!.AsArray(),
            hit => Assert.DoesNotContain("fourth", hit!.ToJsonString())
        );
        Assert.Equal(4, archive.VectorCheckpoint().RawLastIndexedSeq);
        using var reopened = ArchiveSearchIndex.Open(
            Path.Combine(root, "state", "db", "archive-search.sqlite")
        );
        Assert.Equal(4, reopened.Checkpoint(id).RawLastIndexedSeq);
    }
}
