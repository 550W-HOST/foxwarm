using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Foxwarm.Tests.Hosted;
using Npgsql;

namespace Foxwarm.Tests.Storage;

[Trait("Backend", "postgres")]
public sealed class PostgresTaskRowStoreTests
{
    [Fact]
    public async Task Rules_produce_the_same_results_over_sqlite_and_postgres_rows()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var (store, _) = await OpenAsync(database, temp.Path);
        using var postgres = new TaskStore(store, id => id, _ => []);
        using var sqlite = new TaskStore(temp.Path, id => id, _ => []);
        Assert.Equal(TaskRowStoreTests.Run(sqlite), TaskRowStoreTests.Run(postgres));
    }

    [Theory]
    [InlineData("insert", false)]
    [InlineData("update", false)]
    [InlineData("settle notification", false)]
    [InlineData("add note", false)]
    [InlineData("insert", true)]
    [InlineData("update", true)]
    [InlineData("settle notification", true)]
    [InlineData("add note", true)]
    public async Task Every_write_at_a_stale_epoch_is_fenced_without_changing_rows(string operation, bool direct)
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var (store, tenant) = await OpenAsync(database, temp.Path);
        store.Run(TaskRowAccess.Write, rows =>
        {
            Insert(rows, "existing");
            rows.Update("existing", "assignmentRevision", 1L, "assignmentNotificationStatus", "pending");
            rows.AddNote("existing", null, "user", "original note", 10);
            return true;
        });
        var epoch = await database.TakeLeaseAsync(tenant.TenantId, "next");
        Assert.Throws<TenantFencedException>(() => store.Run(direct ? TaskRowAccess.Direct : TaskRowAccess.Write, rows =>
        {
            switch (operation)
            {
                case "insert": Insert(rows, "new"); break;
                case "update": rows.Update("existing", "title", "replacement"); break;
                case "settle notification": rows.SettlePendingNotification("existing", "assignmentNotificationStatus", "sent", 1); break;
                case "add note": rows.AddNote("existing", null, "user", "stale note", 20); break;
                default: throw new ArgumentOutOfRangeException(nameof(operation));
            }
            return true;
        }));
        using var current = new PgTaskRowStore(new TenantDb(database.OpenApp(), tenant.TenantId, epoch));
        current.Run(TaskRowAccess.Read, rows =>
        {
            Assert.Null(rows.Read("new"));
            var existing = rows.Read("existing")!;
            Assert.Equal("existing", (string?)existing["title"]);
            Assert.Equal("pending", (string?)existing["assignmentNotificationStatus"]);
            Assert.Equal("original note", (string?)Assert.Single(rows.LatestNotes("existing", 10))["text"]);
            return true;
        });
    }

    [Fact]
    public async Task Read_snapshot_is_stable_and_only_a_write_callback_rolls_back_its_earlier_statements()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var (store, tenant) = await OpenAsync(database, temp.Path);
        using var other = new PgTaskRowStore(tenant);
        Assert.False(store.Exists);
        store.Run(TaskRowAccess.Read, snapshot =>
        {
            Assert.Null(snapshot.Read("direct"));
            // Another writer commits while the snapshot is open: a separate flow, as another
            // thread of the owner would be; a body's own flow can't open a second transaction.
            OnSeparateFlow(() =>
                Assert.Throws<CallbackFailure>(() => other.Run<bool>(TaskRowAccess.Direct, rows =>
                {
                    Insert(rows, "direct");
                    throw new CallbackFailure();
                }))
            );
            Assert.Null(snapshot.Read("direct"));
            return true;
        });
        Assert.True(store.Exists);
        Assert.NotNull(store.Run(TaskRowAccess.Direct, rows => rows.Read("direct")));
        Assert.Throws<CallbackFailure>(() => store.Run<bool>(TaskRowAccess.Write, rows =>
        {
            Insert(rows, "transaction");
            throw new CallbackFailure();
        }));
        Assert.Null(store.Run(TaskRowAccess.Direct, rows => rows.Read("transaction")));
    }

    [Fact]
    public async Task A_task_row_access_from_inside_a_transaction_body_is_refused_and_writes_nothing()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var (store, tenant) = await OpenAsync(database, temp.Path);
        using var other = new PgTaskRowStore(tenant);
        store.Run(TaskRowAccess.Write, rows =>
        {
            Insert(rows, "outer");
            return true;
        });
        foreach (var access in new[] { TaskRowAccess.Direct, TaskRowAccess.Read, TaskRowAccess.Write })
        {
            var entered = false;
            var refusal = Assert.Throws<InvalidOperationException>(() =>
                store.Run(TaskRowAccess.Read, _ => other.Run(access, rows =>
                {
                    entered = true;
                    Insert(rows, "nested-" + access);
                    return true;
                }))
            );
            Assert.Contains("opened a second transaction", refusal.Message);
            Assert.False(entered && access != TaskRowAccess.Direct, $"{access} ran its body");
            Assert.Null(store.Run(TaskRowAccess.Direct, rows => rows.Read("nested-" + access)));
        }
        Assert.NotNull(store.Run(TaskRowAccess.Direct, rows => rows.Read("outer")));
    }

    private sealed class CallbackFailure : Exception;

    // Runs on a thread that doesn't inherit the caller's execution context, so no transaction
    // scope of the caller flows into it.
    private static void OnSeparateFlow(Action action)
    {
        System.Runtime.ExceptionServices.ExceptionDispatchInfo? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                action();
            }
            catch (Exception error)
            {
                failure = System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error);
            }
        });
        thread.UnsafeStart();
        thread.Join();
        failure?.Throw();
    }

    [Fact]
    public async Task Lost_commit_reply_returns_the_original_result_after_verifying_the_transaction()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var id = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(id);
        await using var proxy = PgTcpProxy.For(database.AppConnectionString);
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(database.AppConnectionString))
        {
            Pooling = false,
            CommandTimeout = 3,
            Timeout = 5,
        }.ConnectionString;
        using var store = new PgTaskRowStore(new TenantDb(database.OpenApp(routed), id, epoch));
        var result = store.Run(TaskRowAccess.Write, rows =>
        {
            Insert(rows, "created");
            rows.AddNote("created", null, "user", "once", 1);
            proxy.HoldExisting(toServer: false, toClient: true);
            return "accepted";
        });
        Assert.Equal("accepted", result);
        Assert.Equal(1, store.Run(TaskRowAccess.Read, rows => rows.NoteCount("created")));
    }

    [Fact]
    public async Task Tied_task_orders_and_note_insertion_order_match_sqlite()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var (postgres, _) = await OpenAsync(database, temp.Path);
        using var sqlite = new SqliteTaskRowStore(temp.Path);
        Assert.Equal(OrderedRows(sqlite), OrderedRows(postgres));

        static string[] OrderedRows(ITaskRowStore store)
        {
            store.Run(TaskRowAccess.Write, rows =>
            {
                Insert(rows, "parent");
                foreach (var id in new[] { "\U00010000", "\uE000", "a" })
                {
                    Insert(rows, id);
                    rows.Update(id, "parentTaskId", "parent", "status", "active");
                }
                rows.AddNote("parent", null, "user", "first", 9);
                rows.AddNote("parent", "s", "session", "second", 1);
                return true;
            });
            return store.Run(TaskRowAccess.Read, rows =>
            new[]
            {
                new JsonArray(rows.List(new TaskListFilter(null, null, false), 10).ToArray()).ToJsonString(),
                new JsonArray(rows.ActiveTasks().ToArray()).ToJsonString(),
                new JsonArray(rows.Children("parent", 10).ToArray()).ToJsonString(),
                new JsonArray(rows.LatestNotes("parent", 10).ToArray()).ToJsonString(),
            });
        }
    }

    private static void Insert(ITaskRows rows, string id) =>
        rows.Insert("id", id, "title", id, "status", "open", "createdAt", 1L, "updatedAt", 1L);

    private static async Task<(ITaskRowStore Store, TenantDb Tenant)> OpenAsync(
        HostedTestDatabase database,
        string scratch
    )
    {
        var id = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(id);
        var tenant = new TenantDb(database.OpenApp(), id, epoch);
        return (new PostgresStorageContext(tenant, scratch).Tasks, tenant);
    }
}
