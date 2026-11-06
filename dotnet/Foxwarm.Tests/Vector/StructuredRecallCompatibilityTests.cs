using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class StructuredRecallCompatibilityTests
{
    private const string Source = "compatibility";

    private static async Task SeedAsync(VectorFixture f, bool mixed)
    {
        var rows = new List<JsonObject>();
        await using (var manager = await f.ManagerAsync())
        {
            var source = await manager.CreateNamedAsync("main", Source, null, null);
            for (var index = 1; index <= 3; index++)
            {
                var available = mixed && index == 3;
                var text = $"violet compatibility {index} " + new string('x', 700) + " late-filter";
                var block = f.Block(
                    source.Id,
                    block: index,
                    first: index,
                    last: index,
                    summary: text
                ) with
                {
                    Agent = source.Agent,
                    RawStartTimestamp = available ? 1000 : null,
                    RawEndTimestamp = available ? 1000 : null,
                    MemoryFacts = new JsonArray(
                        new JsonObject { ["kind"] = "fact", ["text"] = text }
                    ),
                };
                if (available)
                    source.Archive.WriteBlocks([block]);
                foreach (var row in VectorRows.Facts(block))
                {
                    row["vector"] = new JsonArray(
                        VectorEmbeddingPeer
                            .Embedding("violet")
                            .Select(value => (JsonNode?)JsonValue.Create((double)value))
                            .ToArray()
                    );
                    rows.Add(row);
                }
            }
            // Keep the fixture's dense rows as retained fact hits, not extra block hits.
            source.Archive.SetVectorCheckpoint(block: 3);
        }
        using var table = new VectorTable();
        await table.OpenAsync(f.Dense);
        await table.AddAsync(rows, merge: false);
    }

    private static JsonObject Args() =>
        new()
        {
            ["vector_query"] = "violet",
            ["scope"] = "current-agent",
            ["contentFilter"] = "late-filter",
            ["limit"] = 1,
        };

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Static_compatibility_sources_continue_and_do_not_block_later_available_sources(
        bool mixed
    )
    {
        await using var f = await VectorFixture.CreateAsync();
        await SeedAsync(f, mixed);
        await using var manager = await f.ManagerAsync();
        await manager.Vector.WaitForStartupAsync();
        var caller = await manager.CreateNamedAsync("main", "caller", null, null);
        var args = Args();
        var requests = f.Peer.Requests.Count;
        var sources = new List<JsonObject>();
        for (var index = 0; index < 5; index++)
        {
            var page = await ArchiveRecallTool.ExecuteAsync(
                manager,
                caller,
                args,
                programmatic: true
            );
            Assert.Null(page["error"]);
            Assert.Equal(3, page["availableCount"]!.GetValue<int>());
            var source = Assert.Single(page["items"]!.AsArray())!.AsObject();
            sources.Add(source);
            Assert.Equal(index + 1, source["rank"]!.GetValue<int>());
            if (index == 1)
            {
                var repeated = await ArchiveRecallTool.ExecuteAsync(
                    manager,
                    caller,
                    args,
                    programmatic: true
                );
                Assert.True(JsonNode.DeepEquals(page, repeated));
            }
            if (page["nextCursor"] is null)
            {
                Assert.True(page["windowComplete"]!.GetValue<bool>());
                break;
            }
            args["cursor"] = page["nextCursor"]!.DeepClone();
        }
        Assert.Equal(3, sources.Count);
        Assert.Equal(
            3,
            sources.Select(source => source["key"]!.GetValue<string>()).Distinct().Count()
        );
        var compatibility = sources
            .Where(source => source["kind"]!.GetValue<string>() == "unavailable")
            .ToArray();
        Assert.Equal(mixed ? 2 : 3, compatibility.Length);
        Assert.All(
            compatibility,
            source =>
            {
                Assert.Empty(source["messages"]!.AsArray());
                Assert.Contains(
                    "violet compatibility",
                    source["fallbackExcerpt"]!.GetValue<string>()
                );
                // The original match is beyond the bounded excerpt, but selection is already frozen.
                Assert.DoesNotContain("late-filter", source["fallbackExcerpt"]!.GetValue<string>());
            }
        );
        if (mixed)
            Assert.Equal("block", sources[^1]["kind"]!.GetValue<string>());
        Assert.Equal(requests + 1, f.Peer.Requests.Count);
    }

    [Fact]
    public async Task Cached_compatibility_still_requires_current_source_authority()
    {
        await using var f = await VectorFixture.CreateAsync();
        await SeedAsync(f, mixed: false);
        await using var manager = await f.ManagerAsync();
        await manager.Vector.WaitForStartupAsync();
        await manager.CreateAgentAsync("destination", false);
        var caller = await manager.CreateNamedAsync("main", "caller", null, null);
        var args = Args();
        var first = await ArchiveRecallTool.ExecuteAsync(manager, caller, args, programmatic: true);
        args["cursor"] = first["nextCursor"]!.DeepClone();
        await manager.MoveIdentityAsync(
            caller,
            new JsonObject
            {
                ["sessionId"] = Source,
                ["newAgentName"] = "destination",
                ["newSessionId"] = "moved",
            }
        );
        var denied = await ArchiveRecallTool.ExecuteAsync(
            manager,
            caller,
            args,
            programmatic: true
        );
        Assert.NotNull(denied["error"]);
        Assert.Null(denied["items"]);
    }

    [Fact]
    public async Task Formerly_available_source_loss_is_not_replaced_with_a_compatibility_excerpt()
    {
        await using var f = await VectorFixture.CreateAsync();
        await SeedAsync(f, mixed: true);
        await using var manager = await f.ManagerAsync();
        await manager.Vector.WaitForStartupAsync();
        var caller = await manager.CreateNamedAsync("main", "caller", null, null);
        var args = Args();
        for (var index = 0; index < 2; index++)
        {
            var page = await ArchiveRecallTool.ExecuteAsync(
                manager,
                caller,
                args,
                programmatic: true
            );
            Assert.Null(page["error"]);
            args["cursor"] = page["nextCursor"]!.DeepClone();
        }
        // Inject loss of the canonical record after selection. This is a storage-failure
        // fixture, not an Archive mutation API or a change to immutable-write rules.
        using (var db = new SqliteConnection($"Data Source={f.Database};Pooling=False"))
        {
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText = "DELETE FROM archive_blocks WHERE session_id=$session AND id=3";
            command.Parameters.AddWithValue("$session", Source);
            Assert.Equal(1, command.ExecuteNonQuery());
        }
        var missing = await ArchiveRecallTool.ExecuteAsync(
            manager,
            caller,
            args,
            programmatic: true
        );
        Assert.NotNull(missing["error"]);
        Assert.Null(missing["items"]);
    }
}
