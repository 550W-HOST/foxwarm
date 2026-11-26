using System.Text;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Models;
using Foxwarm.Tests.Hosted;
using Microsoft.Data.Sqlite;
using Npgsql;

namespace Foxwarm.Tests;

[Trait("Backend", "postgres")]
public sealed class PostgresTextRedactionStoreContractTests : TextRedactionStoreContractTests
{
    private protected override async Task<Owner> CreateAsync() => await Tenant.OpenAsync();

    /// <summary>The tenant's redaction cache; a hand-over is a takeover at the next epoch.</summary>
    private sealed class Tenant(HostedTestDatabase database, int tenantId, long epoch) : Owner
    {
        private int owners;

        internal HostedTestDatabase Database => database;

        internal TenantDb Current { get; private set; } = new(database.OpenApp(), tenantId, epoch);

        internal static async Task<Tenant> OpenAsync()
        {
            var server = await PostgresServer.SharedAsync();
            var database = await server.CreateDatabaseAsync();
            var tenantId = await database.TenantIdAsync();
            return new Tenant(database, tenantId, await database.TakeLeaseAsync(tenantId, "owner-0"));
        }

        private protected override async Task ChangeOwnerAsync()
        {
            var next = await database.TakeLeaseAsync(tenantId, "owner-" + ++owners);
            Current = new TenantDb(database.OpenApp(), tenantId, next);
        }

        internal Task TakeOverAsync() => ChangeOwnerAsync();

        internal override TextRedactionRecordStore OpenStore(
            byte[] key,
            TimeProvider? clock = null,
            long slotLimit = TextRedactionRecordStore.DefaultSlotBytes,
            long knownLimit = 1 << 20
        ) => PgTextRedactionStore.Open(Current, key, knownLimit, clock, slotLimit)!;

        internal override long SlotCount() => Count("SELECT count(*) FROM text_redaction_slots");

        internal long Count(string sql) =>
            Convert.ToInt64(database.ScalarAsync(sql).GetAwaiter().GetResult());

        public override async ValueTask DisposeAsync()
        {
            await database.DisposeAsync();
            await base.DisposeAsync();
        }
    }

    private static readonly byte[] Key = Enumerable.Range(0, 64).Select(i => (byte)i).ToArray();

    private static readonly TextRedactionOptions Options = new(
        new("http://127.0.0.1:1/classify"),
        null,
        0.5,
        1
    )
    {
        KnownLabels = TextRedactionKnownLabels.All,
    };

    private static TextRedactor.Found Alice(string text) =>
        new(text.IndexOf("Alice", StringComparison.Ordinal), 5, "unused", "Alice", ["private_person"]);

    [Fact]
    public async Task Writes_of_a_replaced_owner_are_fenced_and_leave_nothing()
    {
        await using var tenant = await Tenant.OpenAsync();
        const string kept = "Kept Alice";
        const string late = "Late Alice";
        var previous = tenant.OpenStore(Key);
        var previousDb = tenant.Current;
        var fenced = 0;
        previousDb.Fenced += _ => fenced++;
        previous.PutSlot(Options, TextRedactor.Digest(kept), [Alice(kept)], []);
        previous.PutKnown("placeholder-kept", "Alice", ["private_person"]);
        previous.Flush();
        await tenant.TakeOverAsync();

        // Every kind of write the previous owner still makes is refused by the fence.
        previous.PutSlot(Options, TextRedactor.Digest(late), [Alice(late)], []);
        previous.PutKnown("placeholder-late", "Mallory", ["private_person"]);
        previous.Flush();
        previous.TouchSlot(Options, TextRedactor.Digest(kept));
        previous.TouchKnown("placeholder-kept");
        previous.Flush();
        previous.DeleteSlot(Options, TextRedactor.Digest(kept));
        previous.DeleteKnown("placeholder-kept");
        previous.Flush();
        Assert.True(fenced >= 3);
        // Opening a store with another key would clear the records: that write is fenced too.
        Assert.Null(PgTextRedactionStore.Open(previousDb, [.. Key.Reverse()], 1 << 20));
        previous.Dispose();

        using var current = tenant.OpenStore(Key);
        Assert.NotNull(current.ReadSlot(Options, TextRedactor.Digest(kept)));
        Assert.Null(current.ReadSlot(Options, TextRedactor.Digest(late)));
        Assert.Equal(["Alice"], current.ReadKnown().Select(known => known.Original));
        Assert.Equal(1, tenant.Count("SELECT count(*) FROM text_redaction_slots"));
        Assert.Equal(1, tenant.Count("SELECT count(*) FROM text_redaction_known"));
    }

    [Fact]
    public async Task Records_are_sealed_and_another_key_reads_nothing_and_clears_them()
    {
        await using var tenant = await Tenant.OpenAsync();
        using (var secrets = tenant.Secrets())
        {
            var redactor = secrets.TextRedactor();
            Assert.True(redactor.TryRegister(redactor.Placeholder("Alice"u8), "Alice", ["private_person"]));
            var placeholder = redactor.Placeholder("Alice"u8);
            await tenant.HandOverAsync();
            await using var connection = new NpgsqlConnection(tenant.Database.SuperuserConnectionString);
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand(
                "SELECT data FROM text_redaction_known UNION ALL SELECT data FROM text_redaction_slots",
                connection
            );
            await using var reader = await command.ExecuteReaderAsync();
            var rows = 0;
            while (await reader.ReadAsync())
            {
                rows++;
                var bytes = (byte[])reader[0];
                foreach (var value in new[] { "Alice", placeholder, TextRedactor.Prefix })
                {
                    Assert.Equal(-1, bytes.AsSpan().IndexOf(Encoding.UTF8.GetBytes(value)));
                    Assert.Equal(-1, bytes.AsSpan().IndexOf(Encoding.Unicode.GetBytes(value)));
                }
            }
            Assert.Equal(1, rows);
        }

        using (var foreign = PgTextRedactionStore.Open(tenant.Current, [.. Key.Reverse()], 1 << 20)!)
            Assert.Empty(foreign.ReadKnown());
        Assert.Equal(0, tenant.Count("SELECT count(*) FROM text_redaction_known"));
    }

    // The PostgreSQL store reads what the file store sealed with the same key, so records move
    // between the backends as bytes.
    [Fact]
    public async Task Records_sealed_by_the_file_store_open_unchanged()
    {
        await using var tenant = await Tenant.OpenAsync();
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, TextRedactionStore.FileName);
        const string text = "Hi 🦊 Alice";
        using (var file = TextRedactionStore.Open(path, Key, 1 << 20)!)
        {
            file.PutSlot(Options, TextRedactor.Digest(text), [Alice(text)], []);
            file.PutKnown("placeholder", "Alice", ["private_person"]);
            file.Flush();
        }
        // Copy the file store's rows as bytes into the tenant's tables.
        var rows = new List<(string Sql, object[] Values)>();
        using (var source = new SqliteConnection("Data Source=" + path + ";Pooling=False"))
        {
            source.Open();
            foreach (var (select, insert) in new[]
            {
                ("SELECT 'check', value FROM meta", "INSERT INTO text_redaction_meta(key, value) VALUES($1, $2)"),
                ("SELECT identity, slot, data, used FROM slots", "INSERT INTO text_redaction_slots(identity, slot, data, used) VALUES($1, $2, $3, $4)"),
                ("SELECT id, data, seq FROM known", "INSERT INTO text_redaction_known(id, data, seq) VALUES($1, $2, $3)"),
            })
            {
                using var read = source.CreateCommand();
                read.CommandText = select;
                using var reader = read.ExecuteReader();
                while (reader.Read())
                {
                    var values = new object[reader.FieldCount];
                    reader.GetValues(values);
                    rows.Add((insert, values));
                }
            }
        }
        tenant.Current.Write(tx =>
        {
            foreach (var (sql, values) in rows)
                tx.Execute(sql, values);
            return true;
        });
        SqliteConnection.ClearAllPools();
        using var store = tenant.OpenStore(Key);
        var ranges = store.ReadSlot(Options, TextRedactor.Digest(text));
        var range = Assert.Single(ranges!);
        Assert.Equal((false, 6, 5, "private_person"), (range.Literal, range.Start, range.Length, Assert.Single(range.Labels)));
        Assert.Equal(["Alice"], store.ReadKnown().Select(known => known.Original));
    }

    [Fact]
    public async Task An_unavailable_database_leaves_redaction_in_memory()
    {
        await using var tenant = await Tenant.OpenAsync();
        tenant.Current.Close();
        Assert.Null(PgTextRedactionStore.Open(tenant.Current, Key, 1 << 20));
    }
}
