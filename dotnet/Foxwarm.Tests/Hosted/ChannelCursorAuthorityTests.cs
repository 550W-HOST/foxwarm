using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class ChannelCursorAuthorityTests
{
    [Fact]
    public async Task EachTenantOwnsItsCursorAndAStaleStoreCannotRewindTheNextEpoch()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await db.ExecuteOwnerAsync("INSERT INTO tenants(name) VALUES('other-tenant'); INSERT INTO tenant_leases(tenant_id) SELECT tenant_id FROM tenants WHERE name='other-tenant'");
        var app = db.OpenApp();
        var a = await db.TenantIdAsync();
        var b = await db.TenantIdAsync("other-tenant");
        ChannelCursors Store(int tenant,long epoch) => new(new PgStateDocuments(new TenantDb(app,tenant,epoch)));
        var previous = Store(a,await db.TakeLeaseAsync(a));
        var other = Store(b,await db.TakeLeaseAsync(b));
        await previous.SaveAsync("bot","matrix-account",new JsonObject { ["next_batch"]="a1" });
        Assert.Null(await other.ReadAsync("bot","matrix-account"));
        await other.SaveAsync("bot","matrix-account",new JsonObject { ["next_batch"]="b1" });
        var epoch = await db.TakeLeaseAsync(a,"next/boot");
        var current = Store(a,epoch);
        Assert.Equal("a1",(await current.ReadAsync("bot","matrix-account"))!["next_batch"]!.ToString());
        await current.SaveAsync("bot","matrix-account",new JsonObject { ["next_batch"]="a2" });
        await Assert.ThrowsAsync<TenantFencedException>(()=>previous.SaveAsync("bot","matrix-account",new JsonObject { ["next_batch"]="stale" }));
        Assert.Equal("a2",(await Store(a,epoch).ReadAsync("bot","matrix-account"))!["next_batch"]!.ToString());
        Assert.Equal("b1",(await other.ReadAsync("bot","matrix-account"))!["next_batch"]!.ToString());
        Assert.Null(await current.ReadAsync("bot","different-account"));
    }
}
