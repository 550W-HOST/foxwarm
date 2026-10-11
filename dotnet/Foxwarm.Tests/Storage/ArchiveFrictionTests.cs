using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class ArchiveFrictionTests
{
    private static ArchiveBlockRecord Block(long id, int? score) =>
        new(
            "parent",
            "main",
            id,
            1,
            "message",
            id,
            id,
            null,
            id,
            id,
            1000,
            1000,
            "Durable source summary " + id,
            null,
            1000,
            score
        );

    private static bool HasScore(string path)
    {
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA table_info(archive_blocks)";
        using var reader = command.ExecuteReader();
        while (reader.Read())
            if (reader.GetString(1) == "friction_score")
                return true;
        return false;
    }

    [Fact]
    public void Read_old_archive_is_nonmutating_then_owned_migration_preserves_unscored_and_inherited_zero_and_high_scores()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "archive.sqlite");
        var parent = new SqliteArchiveMessageStore(path, "parent");
        parent.Initialize();
        parent.EnsureBranch();
        parent.WriteBlocks([Block(1, null)]);
        using (
            var connection = new SqliteConnection(
                new SqliteConnectionStringBuilder
                {
                    DataSource = path,
                    Mode = SqliteOpenMode.ReadWrite,
                    Pooling = false,
                }.ToString()
            )
        )
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "ALTER TABLE archive_blocks DROP COLUMN friction_score";
            command.ExecuteNonQuery();
        }
        var reader = new SqliteArchiveMessageStore(path, "parent");
        Assert.Null(Assert.Single(reader.ReadBlocks()).FrictionScore);
        Assert.False(HasScore(path));
        reader.Initialize();
        Assert.True(HasScore(path));
        reader.WriteBlocks([Block(2, 0), Block(3, 100)]);
        var child = new SqliteArchiveMessageStore(path, "child");
        child.Initialize();
        child.EnsureBranch("parent", 3, 3);
        var inherited = child.ReadEffectiveBlocksRange(1, 3);
        Assert.Equal(new int?[] { null, 0, 100 }, inherited.Select(block => block.FrictionScore));
        Assert.False(inherited[0].ToContextMeta().ContainsKey("frictionScore"));
        Assert.Equal(
            0,
            inherited[1].ToMessage()["__meta"]!["contextBlock"]!["frictionScore"]!.GetValue<int>()
        );
        var expansion = new ArchiveContextReader(child).Expand("child", 3, 6000)!;
        Assert.Equal(100, expansion["block"]!["frictionScore"]!.GetValue<int>());
        Assert.Contains(
            "frictionScore=100",
            new ArchiveContextReader(child).Block(3)!.ToMessage().ToJsonString()
        );
        Assert.Equal(
            new int?[] { null, 0, 100 },
            new SqliteArchiveMessageStore(path, "child")
                .ReadEffectiveBlocksRange(1, 3)
                .Select(block => block.FrictionScore)
        );
    }

    [Fact]
    public void Score_is_part_of_the_immutable_block_identity_for_duplicate_writes_and_compensation()
    {
        using var temp = new TempDirectory();
        var store = new SqliteArchiveMessageStore(
            Path.Combine(temp.Path, "archive.sqlite"),
            "parent"
        );
        store.Initialize();
        store.EnsureBranch();
        store.WriteBlocks([Block(1, 73)]);
        Assert.Empty(store.WriteBlocks([Block(1, 73)]));
        Assert.Throws<InvalidDataException>(() => store.WriteBlocks([Block(1, 74)]));
        Assert.Throws<IOException>(() => store.RollbackInsertedBlocks([Block(1, 74)]));
        Assert.Equal(73, Assert.Single(store.ReadBlocks()).FrictionScore);
    }
}
