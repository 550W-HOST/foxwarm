using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Hosted.Operator;

internal sealed partial class OperatorStore
{
    private const string ImportInProgress =
        "This tenant is still being imported. Finish or abandon the import first.";
    private static readonly TimeSpan DrainBound = TimeSpan.FromSeconds(8);

    private sealed record Lifecycle(int Id, string State, long Epoch, bool Held);

    // Lock in the same order as placement and import: tenant, then its lease. A serving
    // acquisition needs only the latter and rechecks the committed state after it takes it.
    private static async Task<Lifecycle> LockAsync(PgTx tx, string slug, CancellationToken ct)
    {
        var id =
            await Scalar(tx, "SELECT tenant_id FROM tenants WHERE name=$1 FOR UPDATE", ct, slug)
                as int?
            ?? throw Missing();
        await using var command = tx.Command(
            """
            SELECT t.state,l.epoch,l.state='active' AND l.expires_at>clock_timestamp()
            FROM tenant_leases l JOIN tenants t USING(tenant_id) WHERE l.tenant_id=$1 FOR UPDATE OF l
            """,
            id
        );
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw Missing();
        return new(id, row.GetString(0), row.GetInt64(1), row.GetBoolean(2));
    }

    internal async Task<JsonObject> SuspendAsync(string slug, CancellationToken ct)
    {
        var original = await database.ClusterAsync(
            async (tx, token) =>
            {
                var tenant = await LockAsync(tx, slug, token);
                if (tenant.State is "importing" or "importing-agents")
                    throw new OperatorProblem(409, ImportInProgress);
                if (tenant.State is not ("active" or "suspended"))
                    throw new OperatorProblem(409, "Only an active tenant can be suspended.");
                await RequireLifecycleReplicasAsync(tx, token);
                if (tenant.State == "active")
                {
                    await tx.ExecuteAsync(
                        "UPDATE tenant_leases SET draining_since=coalesce(draining_since,clock_timestamp()) WHERE tenant_id=$1",
                        token,
                        tenant.Id
                    );
                    await tx.ExecuteAsync(
                        "UPDATE tenants SET state='suspended' WHERE tenant_id=$1",
                        token,
                        tenant.Id
                    );
                }
                return tenant;
            },
            ct
        );
        if (original.Held)
        {
            while (
                await database.ClusterAsync(
                    async (tx, token) =>
                    {
                        await RevokeOverdueAsync(tx, original.Id, original.Epoch, token);
                        return await Scalar(
                                tx,
                                """
                                SELECT 1 FROM tenant_leases l JOIN tenants t USING(tenant_id)
                                WHERE l.tenant_id=$1 AND l.epoch=$2 AND t.state='suspended' AND l.state='active'
                                    AND l.expires_at>clock_timestamp()
                                """,
                                token,
                                original.Id,
                                original.Epoch
                            ) is int;
                    },
                    ct
                )
            )
                await Task.Delay(TimeSpan.FromMilliseconds(100), ct);
        }
        return new JsonObject { ["slug"] = slug, ["state"] = "suspended" };
    }

    // The request and recovery worker use the same epoch transition. No HTTP request or
    // in-process timer owns a suspension: its deadline is persisted on the lease.
    private static Task<int> RevokeOverdueAsync(
        PgTx tx,
        int? id,
        long? epoch,
        CancellationToken token
    ) =>
        tx.ExecuteAsync(
            """
            WITH overdue AS (
                SELECT l.tenant_id,l.epoch FROM tenant_leases l JOIN tenants t USING(tenant_id)
                WHERE t.state='suspended' AND l.state='active' AND l.draining_since+make_interval(secs=>$3)<=clock_timestamp()
                    AND ($1::integer IS NULL OR l.tenant_id=$1 AND l.epoch=$2::bigint)
                ORDER BY l.draining_since LIMIT 256 FOR UPDATE OF l SKIP LOCKED
            ) UPDATE tenant_leases l SET state='released', epoch=l.epoch+1, expires_at=clock_timestamp()
            FROM overdue o WHERE l.tenant_id=o.tenant_id AND l.epoch=o.epoch
            """,
            token,
            id,
            epoch,
            DrainBound.TotalSeconds
        );

    private async Task RecoverSuspensionsAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await database.ClusterAsync(
                        (tx, token) => RevokeOverdueAsync(tx, null, null, token),
                        ct
                    );
                }
                catch (Exception error) when (!ct.IsCancellationRequested)
                {
                    Console.Error.WriteLine(
                        $"[operator] Cannot enforce suspended leases: {error.Message}"
                    );
                }
                await Task.Delay(TimeSpan.FromSeconds(1), ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }

    internal Task<JsonObject> ResumeAsync(string slug, CancellationToken ct) =>
        database.ClusterAsync(
            async (tx, token) =>
            {
                var tenant = await LockAsync(tx, slug, token);
                if (tenant.State is not ("suspended" or "active"))
                    throw new OperatorProblem(409, "Only a suspended tenant can be resumed.");
                if (tenant.State == "suspended")
                {
                    // A resume racing suspension can't reactivate the previous owner's still-live epoch.
                    await tx.ExecuteAsync(
                        """
                        UPDATE tenant_leases SET epoch=CASE WHEN state='active' THEN epoch+1 ELSE epoch END,
                            state='released',expires_at=clock_timestamp(),draining_since=NULL WHERE tenant_id=$1
                        """,
                        token,
                        tenant.Id
                    );
                    await tx.ExecuteAsync(
                        "UPDATE tenants SET state='active' WHERE tenant_id=$1",
                        token,
                        tenant.Id
                    );
                }
                return new JsonObject { ["slug"] = slug, ["state"] = "active" };
            },
            ct
        );
}
