using System.Text.Json.Nodes;
using Amazon.S3;
using Amazon.S3.Model;
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
    internal async Task RunDeletionLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
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
                            await AdvanceDeletionAsync(job, ct);
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

    private async Task AdvanceDeletionAsync(Job job, CancellationToken ct)
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
            // The empty proof must come from a listing started after the persisted settle
            // deadline. Two workers can neither shorten the window nor apply a stale epoch.
            if (!await SweepPageAsync(deletionS3, job.Identity, ct))
                return;
            await database.ClusterAsync(
                (tx, token) =>
                    tx.ExecuteAsync(
                        """
                        UPDATE operator_deletions SET settle_after=coalesce(settle_after,clock_timestamp()+make_interval(secs=>$3)),
                            objects_pending=NOT $4 WHERE tenant_id=$1 AND deletion_epoch=$2 AND objects_pending
                        """,
                        token,
                        job.Id,
                        job.Epoch,
                        (Lease.LeaseTimings.Default.Ttl + S3Blobs.PutTimeout).TotalSeconds,
                        job.PastSettle
                    ),
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
                await Scalar(
                    tx,
                    "SELECT foxwarm_operator_delete_chunk($1,$2,'tenant_keys',256)",
                    token,
                    job.Id,
                    job.Epoch
                );
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

    private static async Task<bool> SweepPageAsync(
        S3BlobSettings s3,
        string identity,
        CancellationToken ct
    )
    {
        var (user, secret) = s3.ReadCredentials();
        using var client = S3Blobs.Client(s3, user, secret);
        var prefix = S3Blobs.TenantRoot(identity);
        var mode = (
            await client.GetBucketVersioningAsync(
                new GetBucketVersioningRequest { BucketName = s3.Bucket },
                ct
            )
        )
            .VersioningConfig
            ?.Status;
        List<KeyVersion> keys;
        if (mode == VersionStatus.Enabled || mode == VersionStatus.Suspended)
        {
            var page = await client.ListVersionsAsync(
                new ListVersionsRequest
                {
                    BucketName = s3.Bucket,
                    Prefix = prefix,
                    MaxKeys = 256,
                },
                ct
            );
            keys = (page.Versions ?? [])
                .Select(v => new KeyVersion { Key = v.Key, VersionId = v.VersionId })
                .ToList();
        }
        else if (mode is null || mode == VersionStatus.Off)
        {
            var page = await client.ListObjectsV2Async(
                new ListObjectsV2Request
                {
                    BucketName = s3.Bucket,
                    Prefix = prefix,
                    MaxKeys = 256,
                },
                ct
            );
            keys = (page.S3Objects ?? []).Select(v => new KeyVersion { Key = v.Key }).ToList();
        }
        else
            throw new InvalidDataException($"Unknown bucket versioning status: {mode}.");
        if (keys.Count == 0)
            return true;
        DeleteObjectsResponse deletion;
        try
        {
            deletion = await client.DeleteObjectsAsync(
                new DeleteObjectsRequest { BucketName = s3.Bucket, Objects = keys },
                ct
            );
        }
        catch (DeleteObjectsException error)
        {
            deletion = error.Response;
        }
        if (deletion.DeleteErrors?.FirstOrDefault() is { } failure)
            throw new IOException(
                $"S3 delete failed: {failure.Code}: {failure.Message} Check object retention, legal holds and the operator's deletion permissions."
            );
        return false;
    }
}
