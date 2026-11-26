using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Postgres.Archive;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// The Archive row insert the Session authority commit runs inside its own transaction: new
/// keys are returned, exact replays are no-ops, and a conflicting immutable row fails the whole
/// caller transaction.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class PgArchiveRowsTests
{
    private const string Session = Fixture.SessionId;

    internal static async Task<(HostedTestDatabase Database, TenantDb Tenant)> OpenAsync()
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        var tenantId = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(tenantId);
        return (database, new TenantDb(database.OpenApp(), tenantId, epoch));
    }

    internal static ArchiveBlockRecord Block(long id, string summary = "Durable summary", int? score = null) =>
        new(Session, "main", id, 1, "message", id, id, null, id, id, 1000, null, summary, null, 1000, score);

    internal static void Reserve(TenantDb tenant, string id, string canonical) =>
        tenant.Write(tx =>
            tx.Execute(
                "INSERT INTO session_id_reservations (session_id, canonical_session_id, created_at, updated_at) VALUES ($1, $2, 1, 1)",
                id,
                canonical
            )
        );

    private static long Count(TenantDb tenant, string table) =>
        tenant.Read(tx => (long)tx.Scalar($"SELECT count(*) FROM {table}")!);

    private static PgArchiveInserted Insert(
        TenantDb tenant,
        IReadOnlyList<ArchiveBlockRecord> blocks,
        IReadOnlyList<ArchiveMessageRecord> messages
    )
    {
        var batch = PgArchiveBatch.Prepare(Session, blocks, messages);
        return tenant.Write(tx => PgArchiveRows.Insert(tx, batch));
    }

    [Fact]
    public async Task Insert_returns_new_rows_and_exact_replays_are_no_ops()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var first = Fixture.Record(1, "one", 1000);
        var second = Fixture.Record(2, "two", 2000);
        var inserted = Insert(tenant, [Block(1)], [first]);
        Assert.Equal([first.MessageJson], inserted.Messages.Select(row => row.MessageJson));
        Assert.Equal([Block(1)], inserted.Blocks);
        var replay = Insert(tenant, [Block(1), Block(2)], [first, second, second]);
        Assert.Equal([2L], replay.Messages.Select(row => row.Seq));
        Assert.Equal([2L], replay.Blocks.Select(block => block.Id));
        Assert.Empty(Insert(tenant, [Block(2)], [second]).Messages);
        Assert.True(tenant.Read(tx => PgArchiveRows.Stored(tx, Session, replay)));
        Assert.False(
            tenant.Read(tx => PgArchiveRows.Stored(tx, Session, new([], [Fixture.Record(3, "absent", 3000)])))
        );
        var stored = tenant.Read(tx =>
            (string)tx.Scalar("SELECT sequence_data FROM archive_messages WHERE seq = 2")!
        );
        Assert.Equal(
            ArchiveSequenceProjectionTests.Canonical(
                ArchiveSequenceProjection.Build("model", JsonNode.Parse(second.MessageJson)!.AsObject())
            ),
            ArchiveSequenceProjectionTests.Canonical(JsonNode.Parse(stored))
        );
    }

    [Fact]
    public async Task A_conflicting_row_fails_the_caller_transaction_and_leaves_nothing()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        Insert(tenant, [Block(1)], [Fixture.Record(1, "one", 1000)]);
        var message = Assert.Throws<InvalidDataException>(() =>
            Insert(tenant, [Block(2)], [Fixture.Record(2, "two", 2000), Fixture.Record(1, "changed", 1000)])
        );
        Assert.Contains($"{Session}#1", message.Message);
        Assert.Throws<InvalidDataException>(() =>
            Insert(tenant, [Block(3), Block(1, "changed summary")], [Fixture.Record(4, "four", 4000)])
        );
        Assert.Throws<InvalidDataException>(() => Insert(tenant, [Block(1, score: 7)], []));
        // The caller's own statement in the same transaction is rolled back with it.
        await database.CreateTenantTableAsync("probe");
        var batch = PgArchiveBatch.Prepare(Session, [], [Fixture.Record(1, "changed", 1000)]);
        Assert.Throws<InvalidDataException>(() =>
            tenant.Write(tx =>
            {
                tx.Execute("INSERT INTO probe (key, value) VALUES ('k', 'v')");
                return PgArchiveRows.Insert(tx, batch);
            })
        );
        Assert.Equal(0, Count(tenant, "probe"));
        Assert.Equal(1, Count(tenant, "archive_messages"));
        Assert.Equal(1, Count(tenant, "archive_blocks"));
    }

    [Fact]
    public async Task Admission_rejects_rows_outside_the_current_shape_before_any_transaction()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var other = ArchiveMessageRecord.Create("other", "main", 1, 1000, Fixture.Message(1, "x", 1000));
        Assert.Throws<InvalidDataException>(() => PgArchiveBatch.Prepare(Session, [], [other]));
        var message = Fixture.Message(1, "x", 1000);
        message["__meta"]!["seq"] = 9;
        Assert.Throws<InvalidDataException>(() =>
            PgArchiveBatch.Prepare(Session, [], [new(Session, "main", 1, 1000, "user", message, message.ToJsonString())])
        );
        Assert.Throws<InvalidDataException>(() => PgArchiveBatch.Prepare(Session, [Block(1) with { Level = 2 }], []));
        Assert.Equal(0, Count(tenant, "archive_messages"));
    }

    [Fact]
    public async Task Historical_aliases_are_not_writable()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        Reserve(tenant, Session, "c1/renamed");
        Assert.Throws<InvalidOperationException>(() => Insert(tenant, [], [Fixture.Record(1, "one", 1000)]));
        Assert.Equal("c1/renamed", tenant.Read(tx => PgArchiveRows.Resolve(tx, Session)));
        Reserve(tenant, "c1/renamed", Session);
        Assert.Throws<InvalidDataException>(() => tenant.Read(tx => PgArchiveRows.Resolve(tx, Session)));
        Assert.Equal(0, Count(tenant, "archive_messages"));
    }

    [Fact]
    public async Task Exact_deletion_removes_only_rows_stored_exactly_as_given()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var first = Fixture.Record(1, "one", 1000);
        var second = Fixture.Record(2, "two", 2000);
        Insert(tenant, [Block(1), Block(2)], [first, second]);
        Assert.Throws<InvalidDataException>(() =>
            tenant.Write(tx =>
            {
                PgArchiveRows.DeleteMessagesAsync(tx, Session, [second, Fixture.Record(1, "changed", 1000)], false, default)
                    .GetAwaiter()
                    .GetResult();
                return true;
            })
        );
        Assert.Throws<IOException>(() =>
            tenant.Write(tx =>
            {
                PgArchiveRows.DeleteBlocksAsync(tx, Session, [new(Block(2), null, null), new(Block(1, "other"), null, null)], false, default)
                    .GetAwaiter()
                    .GetResult();
                return true;
            })
        );
        Assert.Equal(2, Count(tenant, "archive_messages"));
        Assert.Equal(2, Count(tenant, "archive_blocks"));
        await tenant.WriteAsync(
            async (tx, token) =>
            {
                await PgArchiveRows.DeleteMessagesAsync(tx, Session, [second], true, token);
                await PgArchiveRows.DeleteBlocksAsync(tx, Session, [new(Block(2), null, null)], true, token);
                return true;
            }
        );
        Assert.Equal(1, Count(tenant, "archive_messages"));
        Assert.Equal(1, Count(tenant, "archive_blocks"));
    }

    [Fact]
    public async Task Async_insert_matches_the_synchronous_one()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var batch = PgArchiveBatch.Prepare(Session, [Block(1)], [Fixture.Record(1, "one", 1000)]);
        var inserted = await tenant.WriteAsync((tx, token) => PgArchiveRows.InsertAsync(tx, batch, token));
        Assert.Single(inserted.Messages);
        Assert.Single(inserted.Blocks);
        var replay = await tenant.WriteAsync((tx, token) => PgArchiveRows.InsertAsync(tx, batch, token));
        Assert.Empty(replay.Messages);
        Assert.Empty(replay.Blocks);
    }

    [Fact]
    public async Task A_fenced_insert_leaves_nothing()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        await database.TakeLeaseAsync(tenant.TenantId, "other");
        Assert.Throws<TenantFencedException>(() => Insert(tenant, [Block(1)], [Fixture.Record(1, "one", 1000)]));
        Assert.Equal(0, Count(tenant, "archive_messages"));
        Assert.Equal(0, Count(tenant, "archive_blocks"));
    }

    [Fact]
    public async Task The_runtime_role_may_update_only_identity_columns()
    {
        var (database, _) = await OpenAsync();
        await using var __ = database;
        async Task<bool> Can(string table, string column) =>
            (bool)(await database.ScalarAsync(
                "SELECT has_column_privilege($1, $2, $3, 'UPDATE')",
                PostgresServer.AppRole,
                table,
                column
            ))!;
        var allowed = new Dictionary<string, string[]>
        {
            ["archive_messages"] = ["session_id"],
            ["archive_blocks"] = ["session_id"],
            ["archive_branches"] = ["session_id", "parent_session_id", "updated_at"],
            ["session_id_reservations"] = [],
        };
        foreach (var (table, columns) in allowed)
        {
            var all = (string[])(await database.ScalarAsync(
                "SELECT array_agg(attname::text) FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped",
                table
            ))!;
            foreach (var column in all)
                Assert.True(columns.Contains(column) == await Can(table, column), $"{table}.{column}");
        }
    }
}
