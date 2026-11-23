using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class LegacyBlockAuthorityTests
{

    [Fact]
    public void Legacy_archive_range_replay_is_immutable_and_does_not_relax_raw_message_admission()
    {
        using var temp = new TempDirectory();
        var archive = new SqliteArchiveMessageStore(
            Path.Combine(temp.Path, "archive.sqlite"),
            "origin"
        );
        archive.Initialize();
        archive.EnsureBranch();
        var legacy = new ArchiveBlockRecord(
            "origin",
            "main",
            3,
            2,
            "block",
            1,
            2,
            null,
            1,
            4,
            null,
            null,
            "Synthetic legacy summary.",
            null,
            5000
        );
        Assert.Single(archive.WriteBlocks([legacy]));
        Assert.Empty(archive.WriteBlocks([legacy]));
        Assert.Null(Assert.Single(archive.ReadBlocks()).SourceBlockIds);
        Assert.Throws<InvalidDataException>(() =>
            archive.WriteBlocks([legacy with { Summary = "Conflicting summary." }])
        );
        Assert.Throws<InvalidDataException>(() =>
            archive.WriteBlocks([legacy with { Id = 4, SourceStart = 2, SourceEnd = 1 }])
        );
        var raw = legacy.ToMessage();
        ((JsonObject)raw["__meta"]!)["seq"] = 1;
        Assert.Throws<UnsupportedSessionAuthorityException>(() =>
            ArchiveMessageRecord.Create("origin", "main", 1, 5000, raw)
        );
        Assert.Empty(archive.ReadMessages());
    }

    [Theory]
    [InlineData("descending-absent")]
    [InlineData("null")]
    [InlineData("empty")]
    [InlineData("nonpositive")]
    public async Task Malformed_source_provenance_is_not_legacy_absence(string fault)
    {
        using var temp = new TempDirectory();
        await SessionCatalogMigrationTests.Authority(temp.Path, "branch");
        var root = JsonNode
            .Parse(
                await File.ReadAllTextAsync(
                    Path.Combine(temp.Path, "state", "sessions", "branch.json")
                )
            )!
            .AsObject();
        var legacy = new ArchiveBlockRecord(
            "origin",
            "main",
            3,
            2,
            "block",
            1,
            2,
            null,
            1,
            4,
            null,
            null,
            "Synthetic legacy summary.",
            null,
            5000
        ).ToMessage();
        var block = legacy["__meta"]!["contextBlock"]!.AsObject();
        if (fault == "descending-absent")
        {
            block["sourceStart"] = 2;
            block["sourceEnd"] = 1;
        }
        else
            block["sourceBlockIds"] = fault switch
            {
                "null" => null,
                "empty" => new JsonArray(),
                _ => new JsonArray(1, 0, 2),
            };
        root["history"] = new JsonArray(legacy);
        root["meta"]!["messageCount"] = 1;
        Assert.Throws<InvalidDataException>(() =>
            SessionAuthorityDocument.FromNode(root, "branch")
        );
    }

    [Fact]
    public void Serialized_null_source_ids_are_not_the_legacy_SQL_null_shape()
    {
        using var temp = new TempDirectory();
        var database = Path.Combine(temp.Path, "archive.sqlite");
        var archive = new SqliteArchiveMessageStore(database, "origin");
        archive.Initialize();
        archive.EnsureBranch();
        archive.WriteBlocks([
            new ArchiveBlockRecord(
                "origin",
                "main",
                3,
                2,
                "block",
                1,
                2,
                null,
                1,
                4,
                null,
                null,
                "Synthetic legacy summary.",
                null,
                5000
            ),
        ]);
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = database, Pooling = false }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText =
            "UPDATE archive_blocks SET source_block_ids_json='null' WHERE session_id='origin' AND id=3";
        command.ExecuteNonQuery();
        Assert.Throws<InvalidDataException>(() => archive.ReadBlocksRange(3, 3));
        Assert.Throws<InvalidDataException>(() => archive.ReadBlocksNumericRange(3, 3));
    }
}
