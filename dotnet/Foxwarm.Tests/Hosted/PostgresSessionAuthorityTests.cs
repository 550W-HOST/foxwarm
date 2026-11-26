using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Postgres.Archive;
using Foxwarm.Hosted.Postgres.Authority;
using Foxwarm.Sessions;
using Npgsql;
using static Foxwarm.Tests.SessionAuthorityContractTests;

namespace Foxwarm.Tests.Hosted;

/// <summary>A tenant database with the PostgreSQL Session authority over it.</summary>
internal sealed class PgAuthorityFixture : IAsyncDisposable
{
    private PgAuthorityFixture(HostedTestDatabase database, TenantDb tenant, string scratch)
    {
        Database = database;
        Tenant = tenant;
        Backend = new PostgresSessionAuthorityBackend(
            tenant,
            new PgArchiveStore(tenant).ForSession,
            scratch,
            null
        );
        Backend.Committed = stats => Commits.Add(stats);
    }

    internal HostedTestDatabase Database { get; }

    internal TenantDb Tenant { get; }

    internal PostgresSessionAuthorityBackend Backend { get; }

    internal List<PgSessionCommitStats> Commits { get; } = [];

    internal static async Task<PgAuthorityFixture> OpenAsync(string scratch, string? connectionString = null)
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        var tenantId = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(tenantId);
        return new(database, new TenantDb(database.OpenApp(connectionString), tenantId, epoch), scratch);
    }

    /// <summary>The next commit runs <paramref name="action"/> just before its COMMIT.</summary>
    internal void BeforeNextCommit(Action action)
    {
        Backend.BeforeCommit = _ =>
        {
            Backend.BeforeCommit = null;
            action();
        };
    }

    internal long Count(string table) => Tenant.Read(tx => (long)tx.Scalar($"SELECT count(*) FROM {table}")!);

    /// <summary>Every stored row of the authority and Archive tables, for unchanged-state checks.</summary>
    internal string Dump() =>
        Tenant.Read(tx =>
            string.Join(
                "\n",
                new[] { "session_heads", "session_segments", "session_envelope_parts", "archive_messages", "archive_blocks" }.Select(
                    table =>
                        table
                        + ":"
                        + tx.Scalar($"SELECT coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)), '') FROM {table} t")
                )
            )
        );

    public ValueTask DisposeAsync() => Database.DisposeAsync();
}

[Trait("Backend", "postgres")]
public sealed class PostgresSessionAuthorityContractTests : SessionAuthorityContractTests, IAsyncLifetime
{
    private PgAuthorityFixture fixture = null!;

    private protected override ISessionAuthorityBackend Backend => fixture.Backend;

    private protected override void FailNextCommit() =>
        fixture.BeforeNextCommit(() =>
            throw new IOException("Injected failure before the authority transaction commits.")
        );

    public async Task InitializeAsync() => fixture = await PgAuthorityFixture.OpenAsync(Temp.Path);

    public async Task DisposeAsync() => await fixture.DisposeAsync();
}

[Trait("Backend", "postgres")]
public sealed class PostgresSegmentedAuthorityCountTests : SegmentedAuthorityCountTests, IAsyncLifetime
{
    private PgAuthorityFixture fixture = null!;
    private Counters counts = null!;

    private protected override ISessionAuthorityBackend Segmented => fixture.Backend;

    private protected override SegmentedAuthorityCounters Counts => counts;

    public async Task InitializeAsync()
    {
        fixture = await PgAuthorityFixture.OpenAsync(Temp.Path);
        counts = new Counters(fixture);
        fixture.Backend.Committed = stats =>
        {
            counts.Heads++;
            counts.Records += stats.RecordsWritten;
        };
    }

    public async Task DisposeAsync() => await fixture.DisposeAsync();

    private sealed class Counters(PgAuthorityFixture fixture) : SegmentedAuthorityCounters
    {
        internal int Heads;
        internal int Records;

        internal override int HeadWrites => Heads;
        internal override int RecordsWritten => Records;
        internal override int SegmentCount => (int)fixture.Count("session_segments");

        internal override void ResetCounters() => (Heads, Records) = (0, 0);
    }
}
