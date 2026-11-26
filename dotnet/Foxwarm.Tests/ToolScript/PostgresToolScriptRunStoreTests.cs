using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Tests.Hosted;
using Foxwarm.ToolScript;

namespace Foxwarm.Tests;

[Trait("Backend", "postgres")]
public sealed class PostgresToolScriptRunStoreTests
{
    [Fact]
    public async Task Reopened_store_lists_by_owner_status_update_time_and_byte_order_ties()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var scratch = new TempDirectory();
        var id = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(id);
        var tenant = new TenantDb(database.OpenApp(), id, epoch);
        var store = new PostgresStorageContext(tenant, scratch.Path).ToolScriptRuns;
        Assert.False(store.Exists("newest"));
        Assert.Null(await store.ReadAsync("newest", default));
        await store.WriteAsync(Record("\U00010000", 10), default);
        await store.WriteAsync(Record("\uE000", 10), default);
        await store.WriteAsync(Record("newest", 11, "waiting"), default);
        await store.WriteAsync(Record("other", 12, owner: "other"), default);
        var replacement = Record("newest", 13, "waiting");
        replacement["stdout"] = new string('é', 131072) + "🦊\0";
        await store.WriteAsync(replacement, default);
        tenant.Write(tx => tx.Execute(
            """
            INSERT INTO toolscript_runs (run_id, owner, status, updated_at, record)
            VALUES ('unreadable', 'owner', 'completed', 14, $1)
            """,
            "{unreadable"u8.ToArray()
        ));

        var reopened = new PostgresStorageContext(tenant, scratch.Path).ToolScriptRuns;
        Assert.True(reopened.Exists("newest"));
        Assert.True(JsonNode.DeepEquals(replacement, await reopened.ReadAsync("newest", default)));
        Assert.Equal(new[] { "newest", "\uE000", "\U00010000" }, await List(reopened, null, 3));
        Assert.Equal(new[] { "\uE000" }, await List(reopened, "completed", 1));
        Assert.Equal(new[] { "newest" }, await List(reopened, "waiting", 10));
    }

    [Fact]
    public async Task Fenced_inserts_and_replacements_preserve_the_committed_run()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var scratch = new TempDirectory();
        var id = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(id);
        var pool = database.OpenApp();
        var store = new PostgresStorageContext(new TenantDb(pool, id, epoch), scratch.Path).ToolScriptRuns;
        var saved = Record("existing", 1, "waiting");
        await store.WriteAsync(saved, default);
        var nextEpoch = await database.TakeLeaseAsync(id, "next");
        await Assert.ThrowsAsync<TenantFencedException>(() => store.WriteAsync(Record("existing", 2), default));
        await Assert.ThrowsAsync<TenantFencedException>(() => store.WriteAsync(Record("new", 2), default));
        var current = new PostgresStorageContext(new TenantDb(pool, id, nextEpoch), scratch.Path).ToolScriptRuns;
        Assert.False(current.Exists("new"));
        Assert.True(JsonNode.DeepEquals(saved, await current.ReadAsync("existing", default)));
    }

    private static async Task<string[]> List(IToolScriptRunStore store, string? status, int limit) =>
        (await store.ListAsync("owner", limit, status, default)).Select(row => (string)row["runId"]!).ToArray();

    private static JsonObject Record(string runId, long updatedAt, string status = "completed", string owner = "owner") =>
        new() { ["runId"] = runId, ["updatedAt"] = updatedAt, ["status"] = status, ["ownerSessionId"] = owner };
}
