using System.Text.Json.Nodes;
using Foxwarm.Hosted.Blobs;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Hosted.Operator;

internal sealed partial class OperatorStore
{
    internal Task<JsonObject> DeleteAsync(string slug, CancellationToken ct) =>
        database.ClusterAsync(
            async (tx, token) =>
            {
                var tenant = await LockAsync(tx, slug, token);
                if (tenant.State is "importing" or "importing-agents")
                    throw new OperatorProblem(409, ImportInProgress);
                if (tenant.State is not ("suspended" or "deleting"))
                    throw new OperatorProblem(409, "Suspend the tenant before deleting it.");
                await RequireLifecycleReplicasAsync(tx, token);
                if (tenant.State == "suspended")
                {
                    await tx.ExecuteAsync(
                        """
                        UPDATE tenant_leases SET deletion_epoch=epoch+1,epoch=epoch+1,state='released',owner_replica=NULL,
                            draining_since=coalesce(draining_since,clock_timestamp()),expires_at=clock_timestamp() WHERE tenant_id=$1
                        """,
                        token,
                        tenant.Id
                    );
                    await tx.ExecuteAsync(
                        "INSERT INTO operator_deletions(tenant_id,deletion_epoch,objects_pending) VALUES ($1,$2,$3)",
                        token,
                        tenant.Id,
                        tenant.Epoch + 1,
                        deletionS3 is not null
                    );
                    await tx.ExecuteAsync(
                        "UPDATE tenants SET state='deleting' WHERE tenant_id=$1",
                        token,
                        tenant.Id
                    );
                }
                return new JsonObject { ["slug"] = slug, ["state"] = "deleting" };
            },
            ct
        );

    private sealed record Job(
        int Id,
        long Epoch,
        string Identity,
        bool SqlDone,
        bool? Objects,
        bool PastSettle
    );

    // One page or SQL chunk per tenant per round. IDs paginate the queue, so a retained
    // object or large tenant cannot stop work for another. Restart needs only the DB rows.
    internal Task RunDeletionLoopAsync(CancellationToken ct) =>
        Task.WhenAll(RecoverSuspensionsAsync(ct), RecoverDeletionsAsync(ct));

    private async Task RecoverDeletionsAsync(CancellationToken ct)
    {
        var cursor = new ObjectSweep();
        while (!ct.IsCancellationRequested)
        {
            try
            {
                cursor.BeginRound();
                var after = 0;
                while (true)
                {
                    var jobs = await database.ClusterAsync(
                        async (tx, token) =>
                        {
                            var page = new List<Job>();
                            await using var cmd = tx.Command(
                                """
                                SELECT t.tenant_id,l.deletion_epoch,coalesce(t.object_identity,t.name),coalesce(d.sql_done,false),d.objects_pending,
                                    coalesce(d.settle_after<=clock_timestamp(),false)
                                FROM tenants t JOIN tenant_leases l USING(tenant_id)
                                LEFT JOIN operator_deletions d ON d.tenant_id=t.tenant_id AND d.deletion_epoch=l.epoch
                                WHERE t.state='deleting' AND t.tenant_id>$1
                                    AND (d.settle_after IS NULL OR NOT d.objects_pending OR d.settle_after<=clock_timestamp())
                                ORDER BY t.tenant_id LIMIT 32
                                """,
                                after
                            );
                            await using var r = await cmd.ExecuteReaderAsync(token);
                            while (await r.ReadAsync(token))
                                page.Add(
                                    new(
                                        r.GetInt32(0),
                                        r.GetInt64(1),
                                        r.GetString(2),
                                        r.GetBoolean(3),
                                        r.IsDBNull(4) ? null : r.GetBoolean(4),
                                        r.GetBoolean(5)
                                    )
                                );
                            return page;
                        },
                        ct
                    );
                    if (jobs.Count == 0)
                        break;
                    foreach (var job in jobs)
                    {
                        after = job.Id;
                        try
                        {
                            await AdvanceDeletionAsync(job, cursor, ct);
                        }
                        catch (Exception error) when (!ct.IsCancellationRequested)
                        {
                            Console.Error.WriteLine(
                                $"[operator] Deletion of tenant {job.Id} remains pending: {error.Message}"
                            );
                        }
                    }
                    if (jobs.Count < 32)
                        break;
                }
                await RecheckReceiptsAsync(cursor, ct);
                cursor.EndRound();
                await Task.Delay(TimeSpan.FromSeconds(1), ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                Console.Error.WriteLine(
                    $"[operator] Cannot advance tenant deletion: {error.Message}"
                );
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    return;
                }
            }
        }
    }

    private async Task AdvanceDeletionAsync(Job job, ObjectSweep cursor, CancellationToken ct)
    {
        if (!job.SqlDone || job.Objects is null)
        {
            await database.ClusterAsync(
                async (tx, token) =>
                {
                    if (
                        await Scalar(
                            tx,
                            "SELECT 1 FROM tenant_leases WHERE tenant_id=$1 AND epoch=$2 AND deletion_epoch=$2 FOR UPDATE",
                            token,
                            job.Id,
                            job.Epoch
                        )
                        is not int
                    )
                        return false;
                    if (job.Objects is null)
                        await tx.ExecuteAsync(
                            "INSERT INTO operator_deletions(tenant_id,deletion_epoch,objects_pending) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
                            token,
                            job.Id,
                            job.Epoch,
                            deletionS3 is not null
                        );
                    if (job.SqlDone)
                        return true;
                    var tables = new List<string>();
                    await using (
                        var cmd = tx.Command(
                            "SELECT d::text FROM foxwarm_deletion_tables() d WHERE d<>'tenant_keys'"
                        )
                    )
                    await using (var rows = await cmd.ExecuteReaderAsync(token))
                        while (await rows.ReadAsync(token))
                            tables.Add(rows.GetString(0));
                    tables.AddRange([
                        "provider_grants",
                        "operator_documents",
                        "tenant_hostnames",
                        "tenant_wakeups",
                    ]);
                    foreach (var table in tables)
                        if (
                            await Scalar(
                                tx,
                                "SELECT foxwarm_operator_delete_chunk($1,$2,$3,256)",
                                token,
                                job.Id,
                                job.Epoch,
                                table
                            )
                                is int count
                            && count > 0
                        )
                            return true;
                    await tx.ExecuteAsync(
                        "UPDATE operator_deletions SET sql_done=true WHERE tenant_id=$1 AND deletion_epoch=$2",
                        token,
                        job.Id,
                        job.Epoch
                    );
                    return true;
                },
                ct
            );
            return;
        }
        if (job.Objects == true)
        {
            if (deletionS3 is null)
                throw new InvalidDataException("The tenant's S3 storage is unavailable.");
            if (!await cursor.SweepAsync(deletionS3, job.Id, false, job.Identity, ct))
                return;
            await database.ClusterAsync(
                async (tx, token) =>
                {
                    var changed = await tx.ExecuteAsync(
                        """
                        UPDATE operator_deletions SET settle_after=coalesce(settle_after,clock_timestamp()+make_interval(secs=>$3)),
                            objects_pending=NOT $4 WHERE tenant_id=$1 AND deletion_epoch=$2 AND objects_pending
                        """,
                        token,
                        job.Id,
                        job.Epoch,
                        (Lease.LeaseTimings.Default.Ttl + S3Blobs.PutTimeout).TotalSeconds,
                        job.PastSettle
                    );
                    if (changed > 0 && job.PastSettle)
                        await tx.ExecuteAsync(
                            """
                            INSERT INTO operator_object_receipts(tenant_id,slug,object_identity,endpoint,bucket,recheck_after)
                            SELECT tenant_id,name,$2,$4,$5,clock_timestamp()+make_interval(secs=>$3) FROM tenants WHERE tenant_id=$1
                            """,
                            token,
                            job.Id,
                            job.Identity,
                            LateWriteRecheck.TotalSeconds,
                            deletionS3.Endpoint.AbsoluteUri,
                            deletionS3.Bucket
                        );
                    return changed;
                },
                ct
            );
            return;
        }
        await database.ClusterAsync(
            async (tx, token) =>
            {
                // Same lock order as lifecycle requests. Concurrent finalizers join or see
                // the tombstone already gone; no result applies to a subsequent use of its slug.
                if (
                    await Scalar(
                        tx,
                        "SELECT 1 FROM tenants WHERE tenant_id=$1 AND state='deleting' FOR UPDATE",
                        token,
                        job.Id
                    )
                    is not int
                )
                    return false;
                return await Scalar(
                    tx,
                    "SELECT foxwarm_operator_finish_delete($1,$2)",
                    token,
                    job.Id,
                    job.Epoch
                )
                    is true;
            },
            ct
        );
    }
}
