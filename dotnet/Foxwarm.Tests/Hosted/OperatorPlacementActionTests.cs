using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Operator;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Foxwarm.Secrets;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class OperatorPlacementActionTests
{
    [Fact]
    public async Task ActionsUseTheObservedGrantAndReportDurableRequestsSeparatelyFromDraining()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await using var op = new PgDatabase(db.OperatorConnectionString, "placement-operator");
        await using var owner = db.OpenOwner();
        using var root = new TempDirectory();
        var store = new OperatorStore(
            op,
            KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(Path.Combine(root.Path, "kek")))
        );
        var bearer = await OperatorStore.IssueAsync(owner, default);
        var listener = OperatorListener.From(
            DeploymentConfiguration.Parse(
                """
                url: 'https://{slug}.test'
                health: {port: 3031}
                blobs: {backend: postgres}
                operator: {url: 'https://ops.test', port: 3032}
                """
            )
        );
        async Task<(int Status, JsonNode Json)> Call(
            string method,
            string path,
            JsonObject? data = null
        )
        {
            var context = new DefaultHttpContext();
            context.Request.Method = method;
            context.Request.Path = OperatorServer.Path + path;
            context.Request.Host = new HostString("ops.test");
            context.Request.Headers.Authorization = "Bearer " + bearer;
            if (data is not null)
                context.Request.Body = new MemoryStream(
                    Encoding.UTF8.GetBytes(data.ToJsonString())
                );
            context.Response.Body = new MemoryStream();
            await OperatorServer.Dispatch(context, store, listener);
            context.Response.Body.Position = 0;
            return (
                context.Response.StatusCode,
                (await JsonNode.ParseAsync(context.Response.Body))!
            );
        }
        const string slug = "atlas",
            boot = "general-a/boot",
            other = "general-b/boot";
        await store.CreateAsync(slug, "hosted", slug + ".test", default);
        var registry = new ReplicaRegistry(db.OpenApp());
        Task Register(string name, int port) =>
            registry.RegisterAsync(
                name,
                null,
                SchemaMigrator.BinaryLevel,
                SchemaMigrator.BinaryLevel,
                default,
                meshAddress: $"127.0.0.1:{port}"
            );
        await Register(boot, 3401);
        var id = await db.TenantIdAsync(slug);
        var epoch = await db.TakeLeaseAsync(id, boot);
        var grant = new JsonObject
        {
            ["tenantId"] = id,
            ["owner"] = boot,
            ["epoch"] = epoch,
        };
        async Task<JsonNode> Sample() =>
            (await Call("GET", "/placement")).Json["tenants"]!
                .AsArray()
                .Single(t => (string?)t!["slug"] == slug)!;
        Assert.Equal(
            400,
            (
                await Call("POST", "/tenants/atlas/release", new JsonObject { ["owner"] = boot })
            ).Status
        );
        Assert.Equal(409, (await Call("POST", "/tenants/atlas/move", grant)).Status);
        Assert.Null((await Sample())["drainingSince"]);
        Assert.Null((await Sample())["requestedAction"]);
        var stale = grant.DeepClone().AsObject();
        stale["tenantId"] = id + 1;
        Assert.Equal(409, (await Call("POST", "/tenants/atlas/release", stale)).Status);
        await Register(other, 3402);
        Assert.Equal(202, (await Call("POST", "/tenants/atlas/move", grant)).Status);
        Assert.Equal(202, (await Call("POST", "/tenants/atlas/move", grant)).Status);
        Assert.Equal(409, (await Call("POST", "/tenants/atlas/release", grant)).Status);
        var seen = await Sample();
        Assert.Equal(id, (int)seen["tenantId"]!);
        Assert.Equal("move", (string?)seen["requestedAction"]);
        Assert.Null(seen["drainingSince"]);
        Assert.Equal(boot, (string?)seen["owner"]);
        // No consuming replica is running here. Suspend takes precedence synchronously
        // in the state transaction; its own cancellation cannot resurrect the move.
        using var stop = new CancellationTokenSource();
        var suspend = store.SuspendAsync(slug, stop.Token);
        try
        {
            using var until = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            while (
                await db.ScalarAsync("SELECT state FROM tenants WHERE tenant_id=$1", id) is "active"
            )
                await Task.Delay(20, until.Token);
            Assert.Null((await Sample())["requestedAction"]);
        }
        finally
        {
            stop.Cancel();
            try
            {
                await suspend;
            }
            catch (OperationCanceledException) { }
        }
        await store.ResumeAsync(slug, default);
        var next = await db.TakeLeaseAsync(id, boot);
        Assert.True(next > epoch);
        Assert.Equal(409, (await Call("POST", "/tenants/atlas/release", grant)).Status);
        grant["epoch"] = next;
        Assert.Equal(202, (await Call("POST", "/tenants/atlas/release", grant)).Status);
        Assert.Equal("release", (string?)(await Sample())["requestedAction"]);
        // The replica API targets a boot, not its stable logical name or its successor.
        Assert.Equal(
            404,
            (
                await Call("POST", "/replicas/drain", new JsonObject { ["boot"] = "general-a" })
            ).Status
        );
        Assert.Equal(
            202,
            (await Call("POST", "/replicas/drain", new JsonObject { ["boot"] = boot })).Status
        );
        var replicas = (await Call("GET", "/placement")).Json["replicas"]!.AsArray();
        var drained = replicas.Single(r => (string?)r!["id"] == boot)!;
        Assert.True((bool)drained["draining"]!);
        Assert.Equal(1, (int)drained["heldGrants"]!);
        Assert.False((bool)replicas.Single(r => (string?)r!["id"] == other)!["draining"]!);
        await db.ExecuteOwnerAsync(
            "UPDATE tenant_leases SET expires_at=now()-interval '1 second' WHERE owner_replica='general-a/boot'"
        );
        Assert.Equal(
            0,
            (int)
                (await Call("GET", "/placement")).Json["replicas"]!
                    .AsArray()
                    .Single(r => (string?)r!["id"] == boot)!["heldGrants"]!
        );
    }
}
