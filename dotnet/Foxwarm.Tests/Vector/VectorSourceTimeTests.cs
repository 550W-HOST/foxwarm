using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorSourceTimeTests
{
    private static JsonObject[] LegacyFacts(VectorFixture f, string session, int count)
    {
        var result = new List<JsonObject>();
        for (var id = 1; id <= count; id++)
        {
            var block = f.Block(session, block: id, first: id, last: id) with
            {
                CreatedAt = 900000,
                RawStartTimestamp = 1000,
                RawEndTimestamp = 2000,
                MemoryFacts = new JsonArray(
                    new JsonObject { ["kind"] = "fact", ["text"] = "violet fact A " + id },
                    new JsonObject { ["kind"] = "decision", ["text"] = "violet fact B " + id }
                ),
            };
            f.Archive(session).WriteBlocks([block]);
            foreach (var row in VectorRows.Facts(block))
            {
                // Existing versions used the creation time in both source columns.
                row["start_timestamp"] = 900000;
                row["end_timestamp"] = 900000;
                row["vector"] = new JsonArray(
                    VectorEmbeddingPeer
                        .Embedding("violet")
                        .Select(value => (JsonNode?)JsonValue.Create((double)value))
                        .ToArray()
                );
                result.Add(row);
            }
        }
        f.Archive(session).SetVectorCheckpoint(block: count);
        return result.ToArray();
    }

    private static async Task<JsonObject[]> ReadRows(string directory)
    {
        using var connection = new lancedb.Connection();
        await connection.Connect(directory);
        using var table = await connection.OpenTable("messages_v7");
        return (await table.Query().ToList())
            .Select(row => JsonSerializer.SerializeToNode(row)!.AsObject())
            .OrderBy(row => row["id"]!.GetValue<string>(), StringComparer.Ordinal)
            .ToArray();
    }

    [Fact]
    public async Task Startup_repairs_all_fact_rows_across_batches_without_changing_fact_content_or_vectors()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string session = "main/fact's";
        var rows = LegacyFacts(f, session, 257);
        var missing = (JsonObject)rows[0].DeepClone();
        missing["id"] = "missing-block";
        missing["block_id"] = 999;
        using (var table = new VectorTable())
        {
            await table.OpenAsync(f.Dense);
            await table.AddAsync(rows.Append(missing).ToArray(), merge: false);
        }
        var before = await ReadRows(f.Dense);
        var diagnostics = new List<string>();
        var watch = Stopwatch.StartNew();
        await using (var service = new VectorService(f.Data, f.Configuration()))
        {
            service.Diagnostic = (code, _) => diagnostics.Add(code);
            await service.StartAsync();
            await service.WaitForStartupAsync();
            Console.WriteLine(
                $"Fact source-time repair: 515 rows, 258 locators, {watch.ElapsedMilliseconds} ms"
            );
            var dated = await service.SearchAsync(
                "violet",
                1024,
                new(SessionIds: [session], StartTime: 1500, EndTime: 2500)
            );
            Assert.Equal(257, dated.Hits.Count);
            Assert.All(
                dated.Hits,
                hit => Assert.Equal(2, hit["source_group_size"]!.GetValue<int>())
            );
            Assert.Empty(
                (
                    await service.SearchAsync(
                        "violet",
                        20,
                        new(SessionIds: [session], StartTime: 800000)
                    )
                ).Hits
            );
            Assert.Contains(
                (await service.SearchAsync("violet", 1024, new(SessionIds: [session]))).Hits,
                hit => hit["id"]!.GetValue<string>() == "missing-block"
            );
        }
        Assert.Contains("VECTOR_SOURCE_TIME_UNAVAILABLE", diagnostics);
        var after = await ReadRows(f.Dense);
        Assert.Equal(before.Length, after.Length);
        for (var index = 0; index < before.Length; index++)
        {
            var unknown = after[index]["id"]!.GetValue<string>() == "missing-block";
            if (unknown)
            {
                Assert.Null(after[index]["start_timestamp"]);
                Assert.Null(after[index]["end_timestamp"]);
            }
            else
            {
                Assert.Equal(1000, VectorRuntime.Number(after[index]["start_timestamp"]));
                Assert.Equal(2000, VectorRuntime.Number(after[index]["end_timestamp"]));
            }
            before[index].Remove("start_timestamp");
            before[index].Remove("end_timestamp");
            after[index].Remove("start_timestamp");
            after[index].Remove("end_timestamp");
            Assert.True(JsonNode.DeepEquals(before[index], after[index]));
        }
        using var reopened = new VectorTable();
        await reopened.OpenAsync(f.Dense);
        await reopened.RepairSourceTimesAsync(
            (_, _) =>
                throw new InvalidOperationException(
                    "Completed repair must not resolve sources again."
                )
        );
    }

    [Fact]
    public async Task Interrupted_fact_repair_retries_without_a_completion_marker()
    {
        await using var f = await VectorFixture.CreateAsync();
        var rows = LegacyFacts(f, "main/retry", 3);
        using (var table = new VectorTable())
        {
            await table.OpenAsync(f.Dense);
            await table.AddAsync(rows, merge: false);
            var resolved = 0;
            await Assert.ThrowsAsync<IOException>(() =>
                table.RepairSourceTimesAsync(
                    (_, _) =>
                    {
                        if (++resolved == 2)
                            throw new IOException("synthetic interrupted Archive read");
                        return (1000, 2000);
                    }
                )
            );
        }
        var partial = await ReadRows(f.Dense);
        Assert.Equal(2, partial.Count(row => VectorRuntime.Number(row["start_timestamp"]) == 1000));
        Assert.Equal(
            4,
            partial.Count(row => VectorRuntime.Number(row["start_timestamp"]) == 900000)
        );
        using (var table = new VectorTable())
        {
            await table.OpenAsync(f.Dense);
            await table.RepairSourceTimesAsync((_, _) => (1000, 2000));
        }
        Assert.All(
            await ReadRows(f.Dense),
            row => Assert.Equal(1000, VectorRuntime.Number(row["start_timestamp"]))
        );
    }

    [Fact]
    public async Task Archive_failure_during_repair_leaves_Vector_unavailable_and_can_recover_on_reopen()
    {
        await using var f = await VectorFixture.CreateAsync();
        var rows = LegacyFacts(f, "main/broken", 1);
        using (var table = new VectorTable())
        {
            await table.OpenAsync(f.Dense);
            await table.AddAsync(rows, merge: false);
        }
        void SetKind(string kind)
        {
            using var db = new SqliteConnection($"Data Source={f.Database};Pooling=False");
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText =
                "UPDATE archive_blocks SET source_kind=$kind WHERE session_id='main/broken'";
            command.Parameters.AddWithValue("$kind", kind);
            command.ExecuteNonQuery();
        }
        SetKind("unsupported");
        await using (var service = new VectorService(f.Data, f.Configuration()))
        {
            await Assert.ThrowsAsync<InvalidDataException>(() => service.StartAsync());
            var error = await Assert.ThrowsAsync<VectorUnavailableException>(() =>
                service.SearchAsync("violet", 5)
            );
            Assert.Equal("VECTOR_UNAVAILABLE", error.Code);
        }
        SetKind("message");
        await using var recovered = new VectorService(f.Data, f.Configuration());
        await recovered.StartAsync();
        await recovered.WaitForStartupAsync();
        Assert.Single(
            (await recovered.SearchAsync("violet", 5, new(StartTime: 1500, EndTime: 2500))).Hits
        );
    }

    [Fact]
    public async Task Retained_block_ranges_survive_missing_endpoint_rows_and_unknown_ranges_do_not_use_creation_time()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string session = "main/retained-blocks";
        var archive = f.Archive(session);
        archive.EnsureBranch();
        var known = f.Block(session, first: 1, last: 2) with
        {
            RawStartTimestamp = 1000,
            RawEndTimestamp = 2000,
            CreatedAt = 900000,
            MemoryFacts = null,
        };
        var unknown = f.Block(session, block: 2, first: 3, last: 4) with
        {
            CreatedAt = 900000,
            MemoryFacts = null,
        };
        archive.WriteBlocks([known, unknown]);
        archive.SetVectorCheckpoint(block: 2);
        Assert.Empty(archive.ReadMessages());
        var rows = new[] { known, unknown }
            .Select(block =>
            {
                var row = VectorRows.Block(block, archive)!;
                // The old producer fell back to creation time when endpoint rows were absent,
                // even when the Archive block retained its canonical source timestamps.
                row["timestamp"] = 900000;
                row["start_timestamp"] = 900000;
                row["end_timestamp"] = 900000;
                row["vector"] = new JsonArray(
                    VectorEmbeddingPeer
                        .Embedding("violet")
                        .Select(value => (JsonNode?)JsonValue.Create((double)value))
                        .ToArray()
                );
                return row;
            })
            .ToArray();
        using (var table = new VectorTable())
        {
            await table.OpenAsync(f.Dense);
            await table.AddAsync(rows, merge: false);
        }
        var before = await ReadRows(f.Dense);
        await using (var service = new VectorService(f.Data, f.Configuration()))
        {
            await service.StartAsync();
            await service.WaitForStartupAsync();
            var dated = await service.SearchAsync(
                "violet",
                5,
                new(SessionIds: [session], StartTime: 1500, EndTime: 2500)
            );
            Assert.Equal(1, VectorRuntime.Integer(Assert.Single(dated.Hits)["block_id"]));
            Assert.Empty(
                (
                    await service.SearchAsync(
                        "violet",
                        5,
                        new(SessionIds: [session], StartTime: 800000)
                    )
                ).Hits
            );
            Assert.Equal(
                2,
                (await service.SearchAsync("violet", 5, new(SessionIds: [session]))).Hits.Count
            );
        }
        var after = await ReadRows(f.Dense);
        for (var index = 0; index < before.Length; index++)
        {
            if (VectorRuntime.Integer(after[index]["block_id"]) == 1)
            {
                Assert.Equal(1000, VectorRuntime.Number(after[index]["start_timestamp"]));
                Assert.Equal(2000, VectorRuntime.Number(after[index]["end_timestamp"]));
            }
            else
            {
                Assert.Null(after[index]["start_timestamp"]);
                Assert.Null(after[index]["end_timestamp"]);
            }
            before[index].Remove("start_timestamp");
            before[index].Remove("end_timestamp");
            after[index].Remove("start_timestamp");
            after[index].Remove("end_timestamp");
            Assert.True(JsonNode.DeepEquals(before[index], after[index]));
        }
        Assert.Equal(
            1000,
            VectorRuntime.Number(VectorRows.Block(known, archive)!["start_timestamp"])
        );
        Assert.Null(VectorRows.Block(unknown, archive)!["start_timestamp"]);
        using var lexical = ArchiveSearchIndex.Open(
            Path.Combine(f.Temp.Path, "retained-blocks.sqlite")
        );
        lexical.Blocks(
            session,
            new[] { known, unknown }.Select(VectorLexicalRuntime.BlockDocuments).ToArray(),
            2
        );
        Assert.Single(
            lexical.Query("violet", new(SessionIds: [session], StartTime: 1500, EndTime: 2500), 5)
        );
        Assert.Empty(lexical.Query("violet", new(SessionIds: [session], StartTime: 800000), 5));
    }
}
