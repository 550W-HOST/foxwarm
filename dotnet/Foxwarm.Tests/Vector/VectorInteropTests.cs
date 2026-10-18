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
