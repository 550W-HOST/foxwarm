using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorTimeFilterTests
{
    [Fact]
    public async Task Transient_dates_precede_message_and_block_scan_limits_and_resolve_inherited_endpoints()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "main/time-window";
        const string query = "StableMixedIdentifier";
        var archive = f.Archive(id);
        archive.EnsureBranch();
        archive.WriteMessages(
            Enumerable
                .Range(1, 2002)
                .Select(seq =>
                {
                    var timestamp = seq == 1 ? 1 : 1000;
                    var message = VectorFixture.Message(query);
                    message["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = timestamp };
                    return ArchiveMessageRecord.Create(id, "main", seq, timestamp, message);
                })
                .ToArray()
        );
        archive.WriteBlocks(
            Enumerable
                .Range(1, 1002)
                .Select(seq =>
                    f.Block(id, block: seq, first: seq, last: seq, summary: query) with
                    {
                        CreatedAt = 9000,
                    }
                )
                .ToArray()
        );
        var hits = ArchiveLexicalRecall.Search(archive, query, 10, new(StartTime: 1, EndTime: 2));
        Assert.Equal(2, hits.Count);
        Assert.Contains(hits, hit => VectorRuntime.Integer(hit["block_id"]) == 1);
        Assert.Contains(
            hits,
            hit =>
                hit["kind"]!.GetValue<string>() == "raw"
                && VectorRuntime.Integer(hit["start_seq"]) == 1
        );
        Assert.Empty(
            ArchiveLexicalRecall.Search(archive, query, 10, new(StartTime: 0, EndTime: 1))
        );

        const string child = "main/time-child";
        var inherited = f.Archive(child);
        inherited.EnsureBranch(id, 1, 0);
        var block = f.Block(child, first: 1, last: 1, summary: query) with { CreatedAt = 9000 };
        inherited.WriteBlocks([block]);
        var childHits = ArchiveLexicalRecall.Search(
            inherited,
            query,
            10,
            new(StartTime: 1, EndTime: 2)
        );
        Assert.Equal(2, childHits.Count);
        Assert.Contains(
            childHits,
            hit =>
                hit["session_id"]!.GetValue<string>() == child
                && hit["kind"]!.GetValue<string>() == "block"
        );
        var hydrated = ArchiveContextReader.HydrateBlock(inherited, block);
        Assert.Equal(1, hydrated.RawStartTimestamp);
        Assert.Equal(1, hydrated.RawEndTimestamp);
    }

    [Fact]
    public void Persistent_dates_precede_fts_candidate_limits_and_use_block_source_ranges()
    {
        using var temp = new TempDirectory();
        using var index = ArchiveSearchIndex.Open(Path.Combine(temp.Path, "archive-search.sqlite"));
        const string id = "main/fts-time";
        JsonObject Row(int seq, long timestamp) =>
            new()
            {
                ["session_id"] = id,
                ["agent"] = "main",
                ["memory_kind"] = "raw",
                ["source_key"] = seq.ToString(),
                ["source_family"] = $"{id}:raw:{seq}-{seq}",
                ["seq"] = seq,
                ["start_seq"] = seq,
                ["end_seq"] = seq,
                ["raw_start_seq"] = seq,
                ["raw_end_seq"] = seq,
                ["timestamp"] = timestamp,
                ["text"] = "StableMixedIdentifier",
            };
        index.Raw(
            id,
            Enumerable.Range(1, 201).Select(seq => Row(seq, seq == 201 ? 1 : 1000)).ToArray(),
            201
        );
        var hits = index.Query(
            "StableMixedIdentifier",
            new(SessionIds: [id], StartTime: 1, EndTime: 2),
            1
        );
        Assert.NotEmpty(hits);
        Assert.All(hits, hit => Assert.Equal(201, VectorRuntime.Integer(hit["seq"])));
        Assert.Empty(
            index.Query("StableMixedIdentifier", new(SessionIds: [id], StartTime: 0, EndTime: 1), 1)
        );
        var block = new ArchiveBlockRecord(
            id,
            "main",
            1,
            1,
            "message",
            1,
            2,
            null,
            1,
            2,
            100,
            200,
            "BlockSourceIdentifier",
            new JsonArray(new JsonObject { ["kind"] = "fact", ["text"] = "BlockSourceIdentifier" }),
            9000
        );
        index.Blocks(id, [VectorLexicalRuntime.BlockDocuments(block)], 1);
        Assert.NotEmpty(
            index.Query(
                "BlockSourceIdentifier",
                new(SessionIds: [id], StartTime: 150, EndTime: 250),
                1
            )
        );
        Assert.Empty(
            index.Query("BlockSourceIdentifier", new(SessionIds: [id], StartTime: 1000), 1)
        );
    }
}
