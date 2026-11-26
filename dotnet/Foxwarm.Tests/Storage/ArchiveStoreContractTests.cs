using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Postgres.Archive;
using Foxwarm.Sessions;
using Foxwarm.Tests.Hosted;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

/// <summary>
/// Observable behavior every <see cref="IArchiveStore"/> shares: immutable rows with exact
/// replay and inserted-only rollback, fork lineage caps, friction scores and opaque metadata,
/// the committed identity boundary, read purity, sequence paging and direct effect records.
/// SQLite schema validation and migration stay in the file-mode test classes.
/// </summary>
public abstract class ArchiveStoreContractTests
{
    private protected abstract Task<ArchiveUnderTest> CreateAsync();

    private protected sealed class ArchiveUnderTest(
        IArchiveStore store,
        Action<IArchiveSession> initialize,
        Action<string, string> reserve,
        Func<IReadOnlyList<ToolEffectRow>> directEffects,
        Func<ValueTask> dispose
    ) : IAsyncDisposable
    {
        internal IArchiveStore Store { get; } = store;

        /// <summary>A Session view, opened as its owner opens it before writing.</summary>
        internal IArchiveSession Session(string id)
        {
            var session = Store.ForSession(id);
            initialize(session);
            return session;
        }

        /// <summary>Commits a reservation edge, as the identity ledger does.</summary>
        internal void Reserve(string id, string canonical) => reserve(id, canonical);

        internal IReadOnlyList<ToolEffectRow> DirectEffects() => directEffects();

        public ValueTask DisposeAsync() => dispose();
    }

    private static ArchiveMessageRecord Raw(string owner, long seq, string text) =>
        ArchiveMessageRecord.Create(
            owner,
            "main",
            seq,
            seq * 1000,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
                ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq * 1000 },
            }
        );

    private static ArchiveMessageRecord Record(string owner, int seq) =>
        ArchiveMessageRecord.Create(owner, "main", seq, seq * 1000, Fixture.Message(seq, owner + " " + seq, seq * 1000));

    private static ArchiveBlockRecord Block(
        string owner,
        long id,
        int level,
        string kind,
        long first,
        long last,
        JsonArray? children = null
    ) =>
        new(
            owner,
            "main",
            id,
            level,
            kind,
            first,
            last,
            children,
            kind == "message" ? first : 1,
            kind == "message" ? last : 4,
            1000,
            4000,
            owner + " block " + id,
            null,
            id * 1000
        );

    private static ArchiveBlockRecord Scored(long id, int? score) =>
        new("parent", "main", id, 1, "message", id, id, null, id, id, 1000, 1000, "Durable source summary " + id, null, 1000, score);

    internal static ToolEffectRow Effect(string? session, string tool) =>
        new(session, 0, 0, 0, "main", 1700000000000, 12.5, "timer-script", tool, "builtin", null, "n1", "write",
            "ok", null, null, null, "[\"r1\"]", "summary " + tool, null, "timer", "t1", null, "run-1", null);

    [Fact]
    public async Task Rows_use_exact_replay_conflict_and_inserted_only_rollback()
    {
        await using var archive = await CreateAsync();
        var store = archive.Session(Fixture.SessionId);
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
    public async Task Receipts_complete_after_commit_and_compaction_writes_blocks_and_messages_together()
    {
        await using var archive = await CreateAsync();
        var store = archive.Session(Fixture.SessionId);
        var receipt = await store.EnqueueMessagesAsync([Fixture.Record(1, "one", 1000)]);
        Assert.Single(await receipt.Completion);
        Assert.Empty(await (await store.EnqueueMessagesAsync([])).Completion);
        var block = Block(Fixture.SessionId, 1, 1, "message", 1, 2);
        var compaction = await store.EnqueueCompactionAsync([block], [Fixture.Record(2, "two", 2000)]);
        var (blocks, messages) = await compaction.Completion;
        Assert.Equal([1L], blocks.Select(row => row.Id));
        Assert.Equal([2L], messages.Select(row => row.Seq));
        var conflicting = await store.EnqueueCompactionAsync(
            [Block(Fixture.SessionId, 2, 1, "message", 3, 3)],
            [Fixture.Record(1, "changed", 1000)]
        );
        await Assert.ThrowsAsync<InvalidDataException>(() => conflicting.Completion);
        Assert.Equal([1L], store.ReadBlocks().Select(row => row.Id));
        Assert.Equal(2, store.ReadMessages().Count);
        store.RollbackInsertedMessages(messages);
        store.RollbackInsertedBlocks(blocks);
        Assert.Empty(store.ReadBlocks());
        Assert.Single(store.ReadMessages());
    }

    [Theory]
    [InlineData("created-timestamp")]
    [InlineData("raw-missing-metadata")]
    [InlineData("raw-sequence")]
    public async Task Current_admission_rejects_historical_metadata_inconsistency(string kind)
    {
        await using var archive = await CreateAsync();
        var store = archive.Session(Fixture.SessionId);
        var message = Fixture.Message(1, "Current admission", 1001);
        ArchiveMessageRecord record;
        if (kind == "created-timestamp")
            record = ArchiveMessageRecord.Create(Fixture.SessionId, "main", 1, 2002, message);
        else
        {
            if (kind == "raw-missing-metadata")
                message.Remove("__meta");
            else
                message["__meta"]!["seq"] = 90;
            record = new(Fixture.SessionId, "main", 1, 1001, "user", message, message.ToJsonString());
        }
        Assert.Throws<InvalidDataException>(() => store.WriteMessages([record]));
        await Assert.ThrowsAsync<InvalidDataException>(async () =>
        {
            var receipt = await store.EnqueueMessagesAsync([record]);
            await receipt.Completion;
        });
        Assert.Empty(store.ReadMessages());
    }

    [Fact]
    public async Task Independent_callers_keep_their_own_rollback_targets()
    {
        await using var archive = await CreateAsync();
        archive.Session("initial");
        using var start = new ManualResetEventSlim();
        var callers = Enumerable
            .Range(0, 8)
            .Select(index =>
                Task.Run(() =>
                {
                    var session = $"session-{index}";
                    var store = archive.Session(session);
                    start.Wait();
                    for (var seq = 1; seq <= 16; seq++)
                    {
                        var row = ArchiveMessageRecord.Create(
                            session,
                            "main",
                            seq,
                            seq * 1000,
                            Fixture.Message(seq, $"{session}/{seq}", seq * 1000)
                        );
                        var inserted = store.WriteMessages([row]);
                        Assert.Single(inserted);
                        Assert.Empty(store.WriteMessages([row]));
                        Assert.Equal(seq, store.ReadMessages().Count);
                        store.RollbackInsertedMessages(inserted);
                        Assert.Equal(seq - 1, store.ReadMessages().Count);
                        Assert.Single(store.WriteMessages([row]));
                    }
                })
            )
            .ToArray();
        start.Set();
        await Task.WhenAll(callers).WaitAsync(TimeSpan.FromSeconds(60));
        for (var index = 0; index < callers.Length; index++)
            Assert.Equal(16, archive.Store.ForSession($"session-{index}").ReadMessages().Count);
    }

    [Fact]
    public async Task Effective_nested_sources_obey_cumulative_fork_caps_without_copying_or_mutating_archive()
    {
        await using var archive = await CreateAsync();
        var parent = archive.Session("parent");
        parent.EnsureBranch();
        parent.WriteMessages(Enumerable.Range(1, 4).Select(seq => Raw("parent", seq, "old parent " + seq)).ToArray());
        parent.WriteBlocks([Block("parent", 1, 1, "message", 1, 4), Block("parent", 2, 2, "block", 1, 1, new JsonArray(1))]);
        var oldPayloads = parent.ReadMessages().Select(row => row.MessageJson).ToArray();
        var child = archive.Session("child");
        child.EnsureBranch("parent", 4, 2);
        child.WriteMessages([Raw("child", 5, "child before nested fork")]);
        child.WriteBlocks([Block("child", 3, 1, "message", 5, 5)]);
        var nested = archive.Session("nested");
        nested.EnsureBranch("child", 5, 3);
        var zero = archive.Session("zero");
        zero.EnsureBranch("parent", 0, 0);
        var branch = nested.ReadBranch();
        parent.WriteMessages([Raw("parent", 5, "late parent must not leak"), Raw("parent", 6, "late parent 6")]);
        parent.WriteBlocks([Block("parent", 3, 1, "message", 5, 6)]);
        child.WriteMessages([Raw("child", 6, "late child must not leak")]);
        child.WriteBlocks([Block("child", 4, 1, "message", 6, 6)]);
        nested.WriteMessages([Raw("nested", 6, "owned grandchild suffix")]);
        Assert.Equal(
            ["parent", "parent", "parent", "parent", "child", "nested"],
            nested.ReadEffectiveMessagesRange(1, 9).Select(row => row.SessionId)
        );
        Assert.Equal([1L, 2L, 3L], nested.ReadEffectiveBlocksRange(1, 9).Select(row => row.Id));
        Assert.Equal([1L, 2L, 3L], nested.ReadEffectiveBlocksNumericRange(null, null).Select(row => row.Id));
        Assert.Equal(6, nested.ReadEffectiveMessagesNumericRange(null, null).Count);
        Assert.Equal([6L, 5L], nested.ReadEffectiveMessagesPage(null, null, 2, descending: true).Select(row => row.Seq));
        Assert.Equal([2L, 3L], nested.ReadEffectiveMessagesBetween(2000, 4000).Select(row => row.Seq));
        Assert.Equal(new ArchiveStats(6, 1, 6), nested.EffectiveMessageStats());
        Assert.Equal(
            ["parent", "parent", "child"],
            nested.EffectiveBlockTopology().Select(row => row.SourceSessionId)
        );
        Assert.Equal(
            new (string, long?, long?)[] { ("nested", null, null), ("child", 5, 3), ("parent", 4, 2) },
            nested.VectorLineage().Select(scope => (scope.SessionId, scope.MaxMessageSeq, scope.MaxBlockId))
        );
        Assert.Equal(3, nested.EffectiveBlockHighWater());
        Assert.Equal(0, zero.EffectiveBlockHighWater());
        Assert.Empty(zero.ReadEffectiveMessagesRange(1, 9));
        Assert.Empty(zero.ReadEffectiveBlocksRange(1, 9));
        Assert.Equal(branch, nested.ReadBranch());
        Assert.Equal(0, zero.ReadBranch()!.BlockCap);
        Assert.Single(nested.ReadMessages());
        Assert.Empty(nested.ReadBlocks());
        Assert.Equal(oldPayloads, parent.ReadMessages().Take(4).Select(row => row.MessageJson));
        Assert.Throws<InvalidDataException>(() => nested.EnsureBranch("parent", 5, 3));
        Assert.Null(nested.EnsureBranch("child", 5, 3));
        var reader = new ArchiveContextReader(nested);
        var expanded = reader.Expand("nested", 2, 6000)!;
        Assert.Equal("parent", expanded["items"]![0]!["sourceSessionId"]!.GetValue<string>());
        Assert.True(expanded["items"]![0]!["inherited"]!.GetValue<bool>());
        var raw = reader.Expand("nested", 1, 6000)!;
        Assert.Equal(4, raw["totalItems"]!.GetValue<int>());
        Assert.DoesNotContain("late parent", raw.ToJsonString());
    }

    [Fact]
    public async Task Branch_compensation_removes_only_the_inserted_owned_row_and_not_parent_sources()
    {
        await using var archive = await CreateAsync();
        var parent = archive.Session("parent");
        parent.EnsureBranch();
        parent.WriteMessages([Raw("parent", 1, "immutable")]);
        var child = archive.Session("child");
        var inserted = child.EnsureBranch("parent", 1, 0);
        Assert.Throws<IOException>(() => child.RollbackInsertedBranch(inserted! with { CreatedAt = inserted.CreatedAt + 1 }));
        child.RollbackInsertedBranch(inserted);
        Assert.Null(child.ReadBranch());
        Assert.Single(parent.ReadMessages());
        Assert.NotNull(parent.ReadBranch());
    }

    [Fact]
    public async Task Block_reads_select_by_range_limit_and_source_time()
    {
        await using var archive = await CreateAsync();
        var parent = archive.Session("parent");
        parent.EnsureBranch();
        parent.WriteMessages(Enumerable.Range(1, 4).Select(seq => Raw("parent", seq, "p" + seq)).ToArray());
        // A legacy block without source timestamps resolves them from its lineage rows.
        parent.WriteBlocks([
            Block("parent", 1, 1, "message", 1, 2) with { RawStartTimestamp = null, RawEndTimestamp = null },
            Block("parent", 2, 1, "message", 3, 4) with { RawStartTimestamp = 3000, RawEndTimestamp = 4000 },
        ]);
        var child = archive.Session("child");
        child.EnsureBranch("parent", 4, 2);
        Assert.Equal([2L, 1L], parent.ReadBlocksNumericRange(null, null, limit: 2, descending: true).Select(row => row.Id));
        Assert.Equal([2L], parent.ReadBlocksNumericRange(1.5, null).Select(row => row.Id));
        Assert.Equal([1L], parent.ReadBlocksNumericRange(null, null, startTime: 1000, endTime: 2500).Select(row => row.Id));
        Assert.Equal([2L], parent.ReadBlocksNumericRange(null, null, startTime: 2500).Select(row => row.Id));
        Assert.Equal([1L, 2L], parent.ReadBlocksRange(1, 2).Select(row => row.Id));
        Assert.Equal(new ArchiveStats(2, 2, 3), parent.MessageStats(2, 3));
        Assert.Equal([2L, 3L], parent.ReadMessagesNumericRange(1.5, 3.5).Select(row => row.Seq));
        Assert.Equal(3, parent.ReadMessageBySeq(3)!.Seq);
        Assert.Null(parent.ReadMessageBySeq(9));
        Assert.Throws<ArgumentOutOfRangeException>(() => parent.ReadMessagesRange(0, 2));
        Assert.Throws<ArgumentOutOfRangeException>(() => parent.ReadBlocksRange(2, 1));
        Assert.Equal([1L, 2L], child.ReadEffectiveBlocksNumericRange(null, null).Select(row => row.Id));
    }

    [Fact]
    public async Task Substantive_windows_skip_tool_rows_and_hidden_messages()
    {
        await using var archive = await CreateAsync();
        var store = archive.Session(Fixture.SessionId);
        var hidden = Fixture.Message(4, "hidden", 4000);
        hidden["modelVisible"] = false;
        store.WriteMessages([
            Fixture.Record(1, "one", 1000),
            Fixture.Record(2, "two", 2000),
            Fixture.Record(3, "tool", 3000),
            ArchiveMessageRecord.Create(Fixture.SessionId, "main", 4, 4000, hidden),
            Fixture.Record(5, "five", 5000),
        ]);
        Assert.Equal(
            [5L, 2L],
            store.ReadMessagesNumericRange(null, null, limit: 2, descending: true, substantiveWindow: true).Select(row => row.Seq)
        );
    }

    [Fact]
    public async Task Friction_score_is_inherited_and_part_of_the_immutable_block_identity()
    {
        await using var archive = await CreateAsync();
        var parent = archive.Session("parent");
        parent.EnsureBranch();
        parent.WriteBlocks([Scored(1, null), Scored(2, 0), Scored(3, 100)]);
        var child = archive.Session("child");
        child.EnsureBranch("parent", 3, 3);
        var inherited = child.ReadEffectiveBlocksRange(1, 3);
        Assert.Equal(new int?[] { null, 0, 100 }, inherited.Select(block => block.FrictionScore));
        Assert.False(inherited[0].ToContextMeta().ContainsKey("frictionScore"));
        Assert.Equal(0, inherited[1].ToMessage()["__meta"]!["contextBlock"]!["frictionScore"]!.GetValue<int>());
        Assert.Equal(100, new ArchiveContextReader(child).Expand("child", 3, 6000)!["block"]!["frictionScore"]!.GetValue<int>());
        Assert.Contains("frictionScore=100", new ArchiveContextReader(child).Block(3)!.ToMessage().ToJsonString());
        Assert.Empty(parent.WriteBlocks([Scored(3, 100)]));
        Assert.Throws<InvalidDataException>(() => parent.WriteBlocks([Scored(3, 99)]));
        Assert.Throws<IOException>(() => parent.RollbackInsertedBlocks([Scored(3, 99)]));
        Assert.Equal(100, parent.ReadBlocks()[2].FrictionScore);
    }

    [Fact]
    public async Task Opaque_provider_metadata_is_stored_and_read_unchanged()
    {
        await using var archive = await CreateAsync();
        var store = archive.Session("opaque");
        var metadata = new[]
        {
            "{\"providerSpecificFields\":{\"signature\":\"old\"},\"sourceModelId\":\"a/wire\"}",
            "{\"extraFields\":{\"nested\":{\"nullValue\":null},\"list\":[null,2]},\"sourceModelId\":\"a/wire\"}",
            "{\"extraFields\":{},\"providerSpecificFields\":{\"signature\":\"both\"},\"sourceModelId\":\"a/wire\"}",
            "{}",
        };
        var messages = metadata
            .Select((text, index) => new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "Synthetic archived answer" }),
                ["providerMeta"] = JsonNode.Parse(text),
                ["__meta"] = new JsonObject { ["seq"] = index + 1, ["timestamp"] = 1001 + index },
            })
            .ToArray();
        store.WriteMessages(
            messages.Select((message, index) => ArchiveMessageRecord.Create("opaque", "main", index + 1, 1001 + index, message)).ToArray()
        );
        var read = archive.Store.ForSession("opaque").ReadMessages();
        Assert.Equal(messages.Length, read.Count);
        for (var index = 0; index < messages.Length; index++)
            Assert.True(JsonNode.DeepEquals(messages[index], read[index].Message));
    }

    [Fact]
    public async Task Committed_aliases_read_through_but_never_bind_writes()
    {
        await using var archive = await CreateAsync();
        var original = archive.Session("old");
        original.EnsureBranch();
        original.WriteMessages([Raw("old", 1, "before move")]);
        original.WriteBlocks([Block("old", 1, 1, "message", 1, 1)]);
        var child = archive.Session("fork");
        child.EnsureBranch("old", 1, 1);
        archive.Store.RenameIdentity("old", "new");
        archive.Reserve("old", "new");
        var alias = archive.Store.ForSession("old");
        Assert.Equal("new", alias.CanonicalSessionId);
        Assert.Equal("new", Assert.Single(alias.ReadMessages()).SessionId);
        Assert.Equal("new", alias.ReadBranch()!.SessionId);
        Assert.True(alias.HasReadOnlyIdentity());
        Assert.Equal("new", archive.Store.ResolveCommittedIdentity("old"));
        Assert.True(await archive.Store.HasLifetimeRowsAsync("old"));
        Assert.True(await archive.Store.HasLifetimeRowsAsync("new"));
        Assert.Throws<InvalidOperationException>(() => alias.WriteMessages([Raw("old", 2, "late")]));
        Assert.Throws<InvalidOperationException>(() => alias.EnsureBranch());
        Assert.Equal("new", archive.Store.ForSession("fork").ReadBranch()!.ParentSessionId);
        Assert.Equal(
            new[] { "new", "fork" },
            archive.Store.ForSession("fork").VectorLineage().Select(scope => scope.SessionId).Reverse()
        );
        Assert.Single(archive.Store.ForSession("fork").ReadEffectiveMessagesRange(1, 9));
        var moved = archive.Session("new");
        Assert.Single(moved.WriteMessages([Raw("new", 2, "after move")]));
        using var identities = archive.Store.OpenIdentityReader()!;
        Assert.Equal("new", identities.Resolve("old"));
        Assert.Equal(((long?, string?)?)(1000, "main"), identities.FirstMessage("new"));
        Assert.Null(identities.FirstMessage("old"));
    }

    [Fact]
    public async Task Reading_an_unknown_identity_creates_nothing()
    {
        await using var archive = await CreateAsync();
        archive.Session("known").WriteMessages([Raw("known", 1, "x")]);
        var ghost = archive.Store.ForSession("ghost");
        Assert.Empty(ghost.ReadMessages());
        Assert.Empty(ghost.ReadBlocks());
        Assert.Null(ghost.ReadBranch());
        Assert.Empty(ghost.ReadEffectiveMessagesRange(1, 9));
        Assert.False(ghost.HasReadOnlyIdentity());
        Assert.Equal("ghost", ghost.CanonicalSessionId);
        Assert.False(await archive.Store.HasLifetimeRowsAsync("ghost"));
    }

    [Fact]
    public async Task Sequence_counts_and_paging_follow_own_rows()
    {
        await using var archive = await CreateAsync();
        var a = archive.Session("a");
        a.EnsureBranch();
        a.WriteMessages(Enumerable.Range(1, 5).Select(seq => Record("a", seq)).ToArray());
        var b = archive.Session("b");
        b.EnsureBranch("a", 2, 0);
        b.WriteMessages([Record("b", 3), Record("b", 4)]);
        var counts = archive.Store.SequenceCounts(["a", "b", "none"]);
        Assert.Equal((5L, 5L), counts["a"]);
        Assert.Equal((2L, 4L), counts["b"]);
        Assert.Equal((0L, 0L), counts["none"]);

        using var reader = archive.Store.OpenSequenceReader()!;
        var span = reader.Span(new SessionCatalog.SequenceSession("a", null, 5000, false, 5))!;
        Assert.Equal(new ArchiveSpan("a", 1, 1000, 5, 5000), span);
        Assert.Null(reader.Span(new SessionCatalog.SequenceSession("none", null, 0, false, 0)));
        Assert.Equal(5, reader.SeqBefore("a", span, null));
        Assert.Equal(2, reader.SeqBefore("a", span, new ArchiveSequenceCursor(3000)));
        Assert.Equal(3, reader.SeqBefore("a", span, new ArchiveSequenceCursor(4000, "a", 4)));
        Assert.Equal(3, reader.SeqBefore("a", span, new ArchiveSequenceCursor(3000, "z", 1)));
        Assert.Equal(2, reader.SeqBefore("a", span, new ArchiveSequenceCursor(3000, "0", 1)));
        Assert.Equal(0, reader.SeqBefore("a", span, new ArchiveSequenceCursor(500)));
        Assert.Equal(new (long, double)[] { (4, 4000), (3, 3000) }, reader.Positions(span, 4, 2));

        var range = reader.ReadRange("a", span, 3, 4);
        Assert.Equal([3L, 4L], range.Rows.Select(row => row.Seq));
        Assert.Equal(["tool", "model"], range.Rows.Select(row => row.Role));
        Assert.Equal(2, range.Context!.Seq);
        Assert.Equal("a 4", range.Rows[1].Data["text"]!.GetValue<string>());
        Assert.Equal(5, range.MaxSeq);

        var after = reader.ReadAfter("a", span, null, 2500, 2);
        Assert.Equal([3L, 4L], after.Rows.Select(row => row.Seq));
        Assert.True(after.HasMore);
        var tail = reader.ReadAfter("a", span, 4, 0, 5);
        Assert.Equal([5L], tail.Rows.Select(row => row.Seq));
        Assert.False(tail.HasMore);
        Assert.Null(tail.Context);
        Assert.Empty(reader.ReadAfter("a", span, 5, 0, 5).Rows);

        // An unchanged idle Session reuses its span; new rows show once the catalog reports them.
        a.WriteMessages([Record("a", 6)]);
        Assert.Equal(5, reader.Span(new SessionCatalog.SequenceSession("a", null, 5000, false, 5))!.LastSeq);
        Assert.Equal(6, reader.Span(new SessionCatalog.SequenceSession("a", null, 6000, false, 6))!.LastSeq);
    }

    [Fact]
    public async Task Direct_effect_records_are_appended_and_follow_identity_renames()
    {
        await using var archive = await CreateAsync();
        archive.Session("old");
        await archive.Store.RecordDirectEffectAsync(Effect("old", "exec"));
        await archive.Store.RecordDirectEffectAsync(Effect(null, "foxwarm_call"));
        archive.Store.RenameIdentity("old", "new");
        var rows = archive.DirectEffects();
        Assert.Equal([Effect("new", "exec"), Effect(null, "foxwarm_call")], rows);
    }
}

public sealed class FileArchiveStoreContractTests : ArchiveStoreContractTests
{
    private protected override Task<ArchiveUnderTest> CreateAsync()
    {
        var temp = new TempDirectory();
        var store = new SqliteArchiveStore(temp.Path);
        SqliteConnection Open()
        {
            var connection = new SqliteConnection(
                new SqliteConnectionStringBuilder { DataSource = store.DatabasePath, Pooling = false }.ToString()
            );
            connection.Open();
            return connection;
        }
        return Task.FromResult(
            new ArchiveUnderTest(
                store,
                session => ((SqliteArchiveMessageStore)session).Initialize(),
                (id, canonical) =>
                {
                    using var connection = Open();
                    using var command = connection.CreateCommand();
                    command.CommandText =
                        "INSERT INTO archive_session_id_reservations VALUES($id,$canonical,1,1)";
                    command.Parameters.AddWithValue("$id", id);
                    command.Parameters.AddWithValue("$canonical", canonical);
                    command.ExecuteNonQuery();
                },
                () =>
                {
                    using var connection = Open();
                    using var command = connection.CreateCommand();
                    command.CommandText = $"SELECT session_id,{ArchiveToolEffects.Columns} FROM {ArchiveToolEffects.DirectTable} ORDER BY id";
                    using var reader = command.ExecuteReader();
                    var rows = new List<ToolEffectRow>();
                    string? Text(int column) => reader.IsDBNull(column) ? null : reader.GetString(column);
                    while (reader.Read())
                        rows.Add(
                            new(Text(0), 0, 0, 0, Text(1), reader.GetInt64(2), reader.IsDBNull(3) ? null : reader.GetDouble(3),
                                reader.GetString(4), reader.GetString(5), Text(6), Text(7), Text(8), Text(9), reader.GetString(10),
                                Text(11), Text(12), Text(13), Text(14), Text(15), reader.IsDBNull(16) ? null : reader.GetInt64(16),
                                Text(17), Text(18), Text(19), Text(20), Text(21))
                        );
                    return rows;
                },
                () =>
                {
                    temp.Dispose();
                    return ValueTask.CompletedTask;
                }
            )
        );
    }
}

[Trait("Backend", "postgres")]
public sealed class PostgresArchiveStoreContractTests : ArchiveStoreContractTests
{
    private protected override async Task<ArchiveUnderTest> CreateAsync()
    {
        var (database, tenant) = await PgArchiveRowsTests.OpenAsync();
        var store = new PgArchiveStore(tenant);
        return new ArchiveUnderTest(
            store,
            _ => { },
            (id, canonical) => PgArchiveRowsTests.Reserve(tenant, id, canonical),
            () => store.ReadDirectEffects().Select(item => item.Row).ToArray(),
            database.DisposeAsync
        );
    }

    private static long Count(TenantDb tenant, string table) =>
        tenant.Read(tx => (long)tx.Scalar($"SELECT count(*) FROM {table}")!);

    [Fact]
    public async Task Every_write_fails_after_takeover_and_leaves_nothing()
    {
        var (database, tenant) = await PgArchiveRowsTests.OpenAsync();
        await using var _ = database;
        var store = new PgArchiveStore(tenant);
        var session = store.ForSession(Fixture.SessionId);
        var message = Fixture.Record(1, "one", 1000);
        var block = PgArchiveRowsTests.Block(1);
        var inserted = session.WriteMessages([message]);
        var insertedBlocks = session.WriteBlocks([block]);
        var branch = store.ForSession("child").EnsureBranch(Fixture.SessionId, 1, 1);
        await database.TakeLeaseAsync(tenant.TenantId, "other");
        string State() =>
            string.Join(
                ",",
                new[] { "archive_messages", "archive_blocks", "archive_branches", "archive_direct_effects" }.Select(table =>
                    Count(tenant, table)
                )
            )
            + tenant.Read(tx => tx.Scalar("SELECT string_agg(session_id, ',' ORDER BY session_id) FROM archive_branches"));
        var before = State();
        Assert.Throws<TenantFencedException>(() => session.WriteMessages([Fixture.Record(2, "two", 2000)]));
        Assert.Throws<TenantFencedException>(() => session.WriteBlocks([PgArchiveRowsTests.Block(2)]));
        await Assert.ThrowsAsync<TenantFencedException>(async () =>
            await (await session.EnqueueMessagesAsync([Fixture.Record(2, "two", 2000)])).Completion
        );
        await Assert.ThrowsAsync<TenantFencedException>(async () =>
            await (await session.EnqueueCompactionAsync([PgArchiveRowsTests.Block(2)], [Fixture.Record(2, "two", 2000)])).Completion
        );
        Assert.Throws<TenantFencedException>(() => session.RollbackInsertedMessages(inserted));
        Assert.Throws<TenantFencedException>(() => session.RollbackInsertedBlocks(insertedBlocks));
        Assert.Throws<TenantFencedException>(() => store.ForSession("other").EnsureBranch());
        Assert.Throws<TenantFencedException>(() => store.ForSession("child").RollbackInsertedBranch(branch));
        Assert.Throws<TenantFencedException>(() => store.RenameIdentity(Fixture.SessionId, "c1/moved"));
        await Assert.ThrowsAsync<TenantFencedException>(() => store.RecordDirectEffectAsync(Effect(null, "exec")));
        Assert.Equal(before, State());
        Assert.Equal("1,1,1,0child", before);
    }
}
