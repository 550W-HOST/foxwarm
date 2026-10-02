using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ArchiveLineageTests
{
    private static ArchiveMessageRecord Raw(string owner, long seq, string text) => ArchiveMessageRecord.Create(owner, "main", seq, seq * 1000,
        new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }), ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq * 1000 } });
    private static ArchiveBlockRecord Block(string owner, long id, int level, string kind, long first, long last, JsonArray? children = null) =>
        new(owner, "main", id, level, kind, first, last, children, kind == "message" ? first : 1, kind == "message" ? last : 4, 1000, 4000, owner + " block " + id, null, id * 1000);

    [Fact]
    public void Effective_nested_sources_obey_cumulative_fork_caps_without_copying_or_mutating_archive()
    {
        using var temp = new TempDirectory(); var db = Path.Combine(temp.Path, "archive.sqlite");
        var parent = new SqliteArchiveMessageStore(db, "parent"); parent.Initialize(); parent.EnsureBranch();
        parent.WriteMessages(Enumerable.Range(1, 4).Select(seq => Raw("parent", seq, "old parent " + seq)).ToArray());
        parent.WriteBlocks([Block("parent", 1, 1, "message", 1, 4), Block("parent", 2, 2, "block", 1, 1, new JsonArray(1))]);
        var oldPayloads = parent.ReadMessages().Select(row => row.MessageJson).ToArray();
        var child = new SqliteArchiveMessageStore(db, "child"); child.Initialize(); child.EnsureBranch("parent", 4, 2);
        child.WriteMessages([Raw("child", 5, "child before nested fork")]); child.WriteBlocks([Block("child", 3, 1, "message", 5, 5)]);
        var nested = new SqliteArchiveMessageStore(db, "nested"); nested.Initialize(); nested.EnsureBranch("child", 5, 3);
        var zero = new SqliteArchiveMessageStore(db, "zero"); zero.Initialize(); zero.EnsureBranch("parent", 0, 0);
        var branch = nested.ReadBranch();
        parent.WriteMessages([Raw("parent", 5, "late parent must not leak"), Raw("parent", 6, "late parent 6")]);
        parent.WriteBlocks([Block("parent", 3, 1, "message", 5, 6)]);
        child.WriteMessages([Raw("child", 6, "late child must not leak")]); child.WriteBlocks([Block("child", 4, 1, "message", 6, 6)]);
        nested.WriteMessages([Raw("nested", 6, "owned grandchild suffix")]);
        Assert.Equal(["parent", "parent", "parent", "parent", "child", "nested"], nested.ReadEffectiveMessagesRange(1, 9).Select(row => row.SessionId));
        Assert.Equal([1L, 2L, 3L], nested.ReadEffectiveBlocksRange(1, 9).Select(row => row.Id));
        Assert.Equal(3, nested.EffectiveBlockHighWater()); Assert.Equal(0, zero.EffectiveBlockHighWater());
        Assert.Empty(zero.ReadEffectiveMessagesRange(1, 9)); Assert.Empty(zero.ReadEffectiveBlocksRange(1, 9));
        Assert.Equal(branch, nested.ReadBranch()); Assert.Equal(0, zero.ReadBranch()!.BlockCap);
        Assert.Single(nested.ReadMessages()); Assert.Empty(nested.ReadBlocks());
        Assert.Equal(oldPayloads, parent.ReadMessages().Take(4).Select(row => row.MessageJson));
        var reader = new ArchiveContextReader(nested);
        var expanded = reader.Expand("nested", 2, 6000)!;
        Assert.Equal("parent", expanded["items"]![0]!["sourceSessionId"]!.GetValue<string>());
        Assert.True(expanded["items"]![0]!["inherited"]!.GetValue<bool>());
        var raw = reader.Expand("nested", 1, 6000)!;
        Assert.Equal(4, raw["totalItems"]!.GetValue<int>());
        Assert.DoesNotContain("late parent", raw.ToJsonString());
    }

    [Fact]
    public void Branch_compensation_removes_only_the_inserted_owned_row_and_not_parent_sources()
    {
        using var temp = new TempDirectory(); var db = Path.Combine(temp.Path, "archive.sqlite");
        var parent = new SqliteArchiveMessageStore(db, "parent"); parent.Initialize(); parent.EnsureBranch(); parent.WriteMessages([Raw("parent", 1, "immutable")]);
        var child = new SqliteArchiveMessageStore(db, "child"); child.Initialize(); var inserted = child.EnsureBranch("parent", 1, 0);
        child.RollbackInsertedBranch(inserted); Assert.Null(child.ReadBranch()); Assert.Single(parent.ReadMessages());
        Assert.NotNull(parent.ReadBranch());
    }
}
