using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Postgres.Archive;
using Foxwarm.Sessions;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests;

/// <summary>
/// Behavior every <see cref="IIdentityLedger"/> shares: committed reservations visible to the
/// Archive's identity resolution and to a reopened ledger, rename validation, and the pending
/// move intent with its startup refusal. Ledger file repair and the SQLite mirror stay in the
/// file-mode identity tests.
/// </summary>
public abstract class IdentityLedgerContractTests
{
    private protected abstract Task<LedgerUnderTest> CreateAsync();

    private protected sealed class LedgerUnderTest(
        Func<IIdentityLedger> open,
        IArchiveStore archive,
        string catalogRoot,
        Func<ValueTask> dispose
    ) : IAsyncDisposable
    {
        /// <summary>A ledger over the same storage, as a restarted process opens it.</summary>
        internal IIdentityLedger Open() => open();

        internal IArchiveStore Archive { get; } = archive;

        internal SessionCatalog Catalog() => new(catalogRoot);

        public ValueTask DisposeAsync() => dispose();
    }

    private static SessionIdentityMoveRecord Move(string phase = "finishing") =>
        new(phase, "old", "new", "main", ["older"], false, null, 1000);

    [Fact]
    public async Task Committed_renames_reserve_both_identities_and_resolve_in_the_Archive()
    {
        await using var subject = await CreateAsync();
        var ledger = subject.Open();
        using (var catalog = subject.Catalog())
            await ledger.InitializeAsync(catalog);
        Assert.False(ledger.IsReserved("old"));
        ledger.ValidateRename("old", "new");
        await ledger.CommitRenameAsync("old", "new");
        Assert.True(ledger.IsReserved("old"));
        Assert.True(ledger.IsReserved("new"));
        Assert.Equal("new", subject.Archive.ResolveCommittedIdentity("old"));

        // Recommitting the same edge is accepted; a different target or a cycle is not.
        await ledger.CommitRenameAsync("old", "new");
        Assert.Throws<InvalidDataException>(() => ledger.ValidateRename("old", "other"));
        await Assert.ThrowsAsync<InvalidDataException>(() => ledger.CommitRenameAsync("old", "other"));
        Assert.Throws<InvalidDataException>(() => ledger.ValidateRename("new", "old"));
        await ledger.CommitRenameAsync("new", "newest");
        Assert.Equal("newest", subject.Archive.ResolveCommittedIdentity("old"));

        var reopened = subject.Open();
        using (var catalog = subject.Catalog())
            await reopened.InitializeAsync(catalog);
        Assert.True(reopened.IsReserved("old"));
        Assert.True(reopened.IsReserved("newest"));
        Assert.False(reopened.IsReserved("unrelated"));
    }

    [Fact]
    public async Task The_pending_move_round_trips_and_blocks_ordinary_startup()
    {
        await using var subject = await CreateAsync();
        var ledger = subject.Open();
        Assert.Null(ledger.ReadPendingMove());
        ledger.ClearPendingMove();
        ledger.WritePendingMove(Move("rolling-back"));
        ledger.WritePendingMove(Move());
        var read = subject.Open().ReadPendingMove()!;
        Assert.Equal(Move().Json().ToJsonString(), read.Json().ToJsonString());
        Assert.Throws<UnsupportedSessionAuthorityException>(() => ledger.ValidateStartupEvidence());
        ledger.ValidateStartupEvidence(allowPendingIdentityRecovery: true);
        using (var catalog = subject.Catalog())
            await Assert.ThrowsAsync<UnsupportedSessionAuthorityException>(() => ledger.InitializeAsync(catalog));
        ledger.ClearPendingMove();
        Assert.Null(subject.Open().ReadPendingMove());
        subject.Open().ValidateStartupEvidence();
    }

    [Fact]
    public async Task Authority_moves_through_the_callback()
    {
        await using var subject = await CreateAsync();
        var moved = new List<(string, string)>();
        subject.Open().MoveArtifacts("old", "new", 2, (from, to) => moved.Add((from, to)));
        Assert.Equal([("old", "new")], moved);
    }
}

public sealed class FileIdentityLedgerContractTests : IdentityLedgerContractTests
{
    private protected override Task<LedgerUnderTest> CreateAsync()
    {
        var temp = new TempDirectory();
        // An installation always has its state directory.
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        return Task.FromResult(
            new LedgerUnderTest(
                () => new FileIdentityLedger(temp.Path),
                new SqliteArchiveStore(temp.Path),
                temp.Path,
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
public sealed class PostgresIdentityLedgerContractTests : IdentityLedgerContractTests
{
    private protected override async Task<LedgerUnderTest> CreateAsync()
    {
        var (database, tenant) = await PgArchiveRowsTests.OpenAsync();
        // The catalog is another store; the ledger only reads its aliases.
        var temp = new TempDirectory();
        return new LedgerUnderTest(
            () => new PgIdentityLedger(tenant),
            new PgArchiveStore(tenant),
            temp.Path,
            async () =>
            {
                temp.Dispose();
                await database.DisposeAsync();
            }
        );
    }

    [Fact]
    public async Task Every_ledger_write_fails_after_takeover_and_leaves_nothing()
    {
        var (database, tenant) = await PgArchiveRowsTests.OpenAsync();
        await using var _ = database;
        var ledger = new PgIdentityLedger(tenant);
        ledger.WritePendingMove(new("finishing", "a", "b", "main", [], false, null, 1));
        await ledger.CommitRenameAsync("a", "b");
        await database.TakeLeaseAsync(tenant.TenantId, "other");
        await Assert.ThrowsAsync<TenantFencedException>(() => ledger.CommitRenameAsync("c", "d"));
        Assert.Throws<TenantFencedException>(() =>
            ledger.WritePendingMove(new("rolling-back", "c", "d", "main", [], false, null, 2))
        );
        Assert.Throws<TenantFencedException>(() => ledger.ClearPendingMove());
        Assert.Equal("a", ledger.ReadPendingMove()!.OldId);
        Assert.Equal(
            1L,
            tenant.Read(tx => (long)tx.Scalar("SELECT count(*) FROM session_id_reservations")!)
        );
    }
}
