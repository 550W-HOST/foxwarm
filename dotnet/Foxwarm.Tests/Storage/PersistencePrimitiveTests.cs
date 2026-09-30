using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class PersistencePrimitiveTests
{
    [Fact]
    public void AuthorityDocumentPreservesOpenJsonAndRejectsKnownUnsupportedState()
    {
        var root = FixtureAuthority();
        root["futureTopLevel"] = new JsonObject { ["2"] = "two", ["10"] = "ten", ["enabled"] = true };
        ((JsonObject)((JsonObject)((JsonArray)root["history"]!)[0]!)["__meta"]!)["futureMeta"] = 12.5;
        var document = SessionAuthorityDocument.FromOwned(root, Fixture.SessionId);
        var roundTrip = JsonNode.Parse(document.ToJson()) as JsonObject;
        Assert.True(JsonNode.DeepEquals(root, roundTrip));

        var mailbox = (JsonObject)root.DeepClone();
        mailbox["lastAppliedMailboxId"] = 1;
        Assert.Throws<UnsupportedSessionAuthorityException>(() => SessionAuthorityDocument.FromOwned(mailbox, Fixture.SessionId));
        var queue = (JsonObject)root.DeepClone();
        ((JsonArray)queue["queue"]!).Add(new JsonObject
        {
            ["type"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "later", ["opaque"] = "preserved" }),
            ["futureQueue"] = new JsonObject { ["keep"] = true }
        });
        var queued = SessionAuthorityDocument.FromOwned(queue, Fixture.SessionId).CloneRoot();
        Assert.True(JsonNode.DeepEquals(queue["queue"], queued["queue"]));
        var compact = (JsonObject)root.DeepClone();
        ((JsonArray)compact["queue"]!).Add(new JsonObject { ["type"] = "compact-commit" });
        Assert.Throws<UnsupportedSessionAuthorityException>(() => SessionAuthorityDocument.FromOwned(compact, Fixture.SessionId));
        var block = (JsonObject)root.DeepClone();
        ((JsonObject)((JsonObject)((JsonArray)block["history"]!)[0]!)["__meta"]!)["contextBlock"] = new JsonObject { ["id"] = 1 };
        Assert.Throws<UnsupportedSessionAuthorityException>(() => SessionAuthorityDocument.FromOwned(block, Fixture.SessionId));
        var preserved = (JsonObject)root.DeepClone();
        ((JsonObject)((JsonObject)((JsonArray)preserved["history"]!)[0]!)["__meta"]!)["preservedFromBlockId"] = 1;
        var preservedRoundTrip = SessionAuthorityDocument.FromOwned(preserved, Fixture.SessionId).CloneRoot();
        Assert.True(JsonNode.DeepEquals(preserved, preservedRoundTrip));
        var version = (JsonObject)root.DeepClone();
        version["sessionStateVersion"] = 2;
        Assert.Throws<UnsupportedSessionAuthorityException>(() => SessionAuthorityDocument.FromOwned(version, Fixture.SessionId));
    }

    [Fact]
    public void NewArchiveProjectionRejectsNonBinary64IntegerAndClrDecimalBeforeDatabaseWrite()
    {
        var overPrecise = Fixture.Message(1, "number", 1000);
        ((JsonObject)((JsonArray)overPrecise["parts"]!)[0]!)["opaque"] = JsonNode.Parse("9007199254740993");
        Assert.Throws<UnsupportedSessionAuthorityException>(() => ArchiveMessageRecord.Create(Fixture.SessionId, "main", 1, 1000, overPrecise));

        var decimalValue = Fixture.Message(1, "decimal", 1000);
        ((JsonObject)((JsonArray)decimalValue["parts"]!)[0]!)["opaque"] = JsonValue.Create(0.1m);
        Assert.Throws<UnsupportedSessionAuthorityException>(() => ArchiveMessageRecord.Create(Fixture.SessionId, "main", 1, 1000, decimalValue));
    }

    [Fact]
    public void ArchiveStoreUsesExactReplayConflictAndInsertedOnlyRollback()
    {
        using var temp = new TempDirectory();
        var store = new SqliteArchiveMessageStore(Path.Combine(temp.Path, "state", "archive-store.sqlite"), Fixture.SessionId);
        store.Initialize();
        var first = Fixture.Record(1, "one", 1000);
        var second = Fixture.Record(2, "two", 2000);
        Assert.Equal([first], store.WriteMessages([first]));
        Assert.Empty(store.WriteMessages([first]));

        var conflict = Fixture.Record(1, "different", 1000);
        Assert.Throws<InvalidDataException>(() => store.WriteMessages([second, conflict]));
        Assert.Equal([1L], store.ReadMessages().Select(record => record.Seq));

        var inserted = store.WriteMessages([first, second]);
        Assert.Equal([2L], inserted.Select(record => record.Seq));
        store.RollbackInsertedMessages(inserted);
        var remaining = Assert.Single(store.ReadMessages());
        Assert.Equal(first.MessageJson, remaining.MessageJson);

        var third = Fixture.Record(3, "three", 3000);
        store.WriteMessages([second, third]);
        var missing = Fixture.Record(4, "missing", 4000);
        Assert.Throws<InvalidDataException>(() => store.RollbackInsertedMessages([second, missing]));
        Assert.Equal([1L, 2L, 3L], store.ReadMessages().Select(record => record.Seq));
    }

    [Fact]
    public void ArchiveStoreRejectsAnIncompatibleSameNamedTable()
    {
        using var temp = new TempDirectory();
        var databasePath = Path.Combine(temp.Path, "archive-store.sqlite");
        using (var connection = new SqliteConnection($"Data Source={databasePath}"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "CREATE TABLE archive_messages(session_id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(session_id,seq))";
            command.ExecuteNonQuery();
        }
        var store = new SqliteArchiveMessageStore(databasePath, Fixture.SessionId);
        Assert.Throws<InvalidDataException>(store.Initialize);
    }

    [Fact]
    public void ArchiveStoreAllowsAnOrdinaryBranchButRejectsLineageAndBlocks()
    {
        using var temp = new TempDirectory();
        var databasePath = Path.Combine(temp.Path, "archive-store.sqlite");
        var store = new SqliteArchiveMessageStore(databasePath, Fixture.SessionId);
        store.Initialize();
        using (var connection = new SqliteConnection($"Data Source={databasePath}"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = """
                CREATE TABLE archive_branches(
                  session_id TEXT PRIMARY KEY,parent_session_id TEXT,
                  fork_message_seq INTEGER NOT NULL DEFAULT 0,fork_block_id INTEGER NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
                INSERT INTO archive_branches VALUES($session,NULL,0,0,1,1);
                """;
            command.Parameters.AddWithValue("$session", Fixture.SessionId);
            command.ExecuteNonQuery();
        }
        store.Initialize();
        using (var connection = new SqliteConnection($"Data Source={databasePath}"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "UPDATE archive_branches SET parent_session_id='parent',fork_message_seq=1 WHERE session_id=$session";
            command.Parameters.AddWithValue("$session", Fixture.SessionId);
            command.ExecuteNonQuery();
        }
        Assert.Throws<UnsupportedSessionAuthorityException>(store.Initialize);
    }

    [Theory]
    [InlineData(AtomicJsonWriteStage.BeforeTempWrite)]
    [InlineData(AtomicJsonWriteStage.AfterTempFileSync)]
    [InlineData(AtomicJsonWriteStage.BeforeRename)]
    public void AtomicWriterClassifiesPreRenameFailuresAsUncommitted(AtomicJsonWriteStage failedStage)
    {
        using var temp = new TempDirectory();
        var baseline = SessionAuthorityDocument.FromOwned(FixtureAuthority(), Fixture.SessionId);
        var path = new LinuxAtomicJsonFile(temp.Path, "state/sessions/c1/fixture.json");
        path.Write(baseline);
        var changedRoot = FixtureAuthority();
        changedRoot["futureTopLevel"] = "new";
        var changed = SessionAuthorityDocument.FromOwned(changedRoot, Fixture.SessionId);
        var failing = new LinuxAtomicJsonFile(temp.Path, "state/sessions/c1/fixture.json", stage =>
        {
            if (stage == failedStage) throw new IOException("injected precommit failure");
        });
        Assert.Throws<IOException>(() => failing.Write(changed));
        Assert.True(JsonNode.DeepEquals(baseline.CloneRoot(), path.Read(Fixture.SessionId).CloneRoot()));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path.FilePath)!, "*.tmp-*"));
    }

    [Theory]
    [InlineData(AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)]
    [InlineData(AtomicJsonWriteStage.AfterDirectorySync)]
    public void AtomicWriterClassifiesPostRenameFailuresAsCommitted(AtomicJsonWriteStage failedStage)
    {
        using var temp = new TempDirectory();
        var changedRoot = FixtureAuthority();
        changedRoot["futureTopLevel"] = "published";
        var changed = SessionAuthorityDocument.FromOwned(changedRoot, Fixture.SessionId);
        var failing = new LinuxAtomicJsonFile(temp.Path, "state/sessions/c1/fixture.json", stage =>
        {
            if (stage == failedStage) throw new IOException("injected postcommit failure");
        });
        var error = Assert.Throws<AuthorityCommittedException>(() => failing.Write(changed));
        Assert.True(error.AuthorityCommitted);
        Assert.True(JsonNode.DeepEquals(changed.CloneRoot(), failing.Read(Fixture.SessionId).CloneRoot()));
    }

    [Fact]
    public void AtomicWriterFlushesRenamesSyncsDirectoryAndNormallyReopens()
    {
        using var temp = new TempDirectory();
        var stages = new List<AtomicJsonWriteStage>();
        var writer = new LinuxAtomicJsonFile(temp.Path, "state/sessions/c1/fixture.json", stages.Add);
        var document = SessionAuthorityDocument.FromOwned(FixtureAuthority(), Fixture.SessionId);
        writer.Write(document);
        Assert.Equal(Enum.GetValues<AtomicJsonWriteStage>(), stages);
        if (OperatingSystem.IsLinux()) Assert.Equal(DirectorySyncResult.Synced, writer.LastDirectorySyncResult);
        Assert.True(JsonNode.DeepEquals(document.CloneRoot(), writer.Read(Fixture.SessionId).CloneRoot()));
    }

    internal static JsonObject FixtureAuthority(IReadOnlyList<JsonObject>? messages = null)
    {
        var history = new JsonArray((messages ?? [Fixture.Message(1, "one", 1000)]).Select(message => (JsonNode)message.DeepClone()).ToArray());
        return new JsonObject
        {
            ["sessionStateVersion"] = 1,
            ["history"] = history,
            ["persistentMemorySnapshot"] = "fixture snapshot",
            ["promptCacheKey"] = "fixture-cache-key",
            ["stats"] = new JsonObject
            {
                ["totalCachedTokens"] = 0, ["totalInputTokens"] = 0,
                ["totalOutputTokens"] = 0, ["lastUsage"] = null
            },
            ["busy"] = false,
            ["queue"] = new JsonArray(),
            ["meta"] = new JsonObject { ["lastMessageTime"] = 1000, ["messageCount"] = history.Count },
            ["currentNode"] = "master",
            ["agent"] = "main",
            ["historyVersion"] = 0,
            ["nextMessageSeq"] = history.Count + 1,
            ["nextBlockId"] = 1,
            ["lastAppliedMailboxId"] = 0,
        };
    }
}

internal static class Fixture
{
    public const string SessionId = "c1/fixture";
    public static JsonObject Message(int seq, string text, double timestamp) => new()
    {
        ["role"] = seq == 3 ? "tool" : seq == 2 || seq == 4 ? "model" : "user",
        ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
        ["__meta"] = new JsonObject { ["timestamp"] = timestamp, ["seq"] = seq }
    };
    public static ArchiveMessageRecord Record(int seq, string text, double timestamp)
    {
        var message = Message(seq, text, timestamp);
        return ArchiveMessageRecord.Create(SessionId, "main", seq, timestamp, message);
    }
}

internal sealed class TempDirectory : IDisposable
{
    public TempDirectory()
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"foxwarm-c1-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Path);
    }
    public string Path { get; }
    public void Dispose() { try { Directory.Delete(Path, recursive: true); } catch { } }
}
