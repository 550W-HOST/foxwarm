using Amazon.S3;
using Amazon.S3.Model;
using Foxwarm.Hosted.Blobs;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Hosted.Operator;

// The operator's S3 identity can inventory all versions and delete individual versions.
// Its SQL access is confined to blob accounting and reference keys by grants, RLS and
// the current lease fence; it cannot read an Agent file's contents or publish one.
internal sealed class AgentBlobMaintenance(PgDatabase database, S3BlobSettings settings)
{
    internal async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var after = 0;
                while (true)
                {
                    var tenants = await database.ClusterAsync(async (tx, token) =>
                    {
                        using var cmd = tx.Command("""
                            SELECT t.tenant_id,l.epoch,coalesce(t.object_identity,t.name)
                            FROM tenant_leases l JOIN tenants t USING(tenant_id)
                            WHERE t.tenant_id>$1 AND l.state='active' AND l.expires_at>now()
                            ORDER BY t.tenant_id LIMIT 32
                            """, after);
                        await using var rows = await cmd.ExecuteReaderAsync(token);
                        var page = new List<(int Id,long Epoch,string Identity)>();
                        while (await rows.ReadAsync(token)) page.Add((rows.GetInt32(0), rows.GetInt64(1), rows.GetString(2)));
                        return page;
                    }, ct);
                    if (tenants.Count == 0) break;
                    foreach (var t in tenants)
                    {
                        after = t.Id;
                        try { await AdvanceAsync(new TenantDb(database, t.Id, t.Epoch), t.Identity, ct); }
                        catch (TenantFencedException) { } // Idle release or ownership change.
                        catch (Exception error) when (!ct.IsCancellationRequested)
                        {
                            Console.Error.WriteLine($"[operator] Agent blob maintenance for tenant {t.Id} remains pending: {error.Message}");
                        }
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                Console.Error.WriteLine($"[operator] Cannot advance Agent blob maintenance: {error.Message}");
            }
            try { await Task.Delay(TimeSpan.FromSeconds(5), ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
        }
    }

    internal async Task AdvanceAsync(TenantDb tenant, string identity, CancellationToken ct)
    {
        var destination = S3BlobStore.Destination(settings.Endpoint.AbsoluteUri, settings.Bucket);
        var prefix = S3Blobs.TenantRoot(identity) + PgAgentFileStore.BlobStoreName + "/";
        await tenant.WriteAsync(async (tx, token) =>
        {
            using var check = tx.Command("SELECT foxwarm_agent_inventory_lock()");
            var inventory = await check.ExecuteScalarAsync(token) as string;
            if (inventory == destination) return true;
            if (inventory is not null) throw new InvalidDataException("The operator's Agent blob destination differs from the recorded inventory.");
            var (id, secret) = settings.ReadCredentials();
            using var client = S3Blobs.Client(settings, id, secret);
            var versioned = await VersionedAsync(client, token);
            await foreach (var page in PagesAsync(client, prefix, versioned, token))
            {
                foreach (var group in page.GroupBy(v => v.Key, StringComparer.Ordinal))
                {
                    var key = group.Key[prefix.Length..];
                    // All historical versions count, including those hidden by a delete marker.
                    var size = group.Sum(v => v.Size);
                    var present = group.Any(v => v.Current);
                    await tx.ExecuteAsync("SELECT foxwarm_agent_inventory_add($1,$2,$3)", token, key, size, present);
                }
            }
            await tx.ExecuteAsync("SELECT foxwarm_agent_inventory_finish($1)", token, destination);
            return true;
        }, token: ct);
    }

    private async Task<bool> VersionedAsync(IAmazonS3 client, CancellationToken ct)
    {
        var mode = (await client.GetBucketVersioningAsync(new GetBucketVersioningRequest { BucketName = settings.Bucket }, ct)).VersioningConfig?.Status;
        if (mode == VersionStatus.Enabled || mode == VersionStatus.Suspended) return true;
        if (mode is null || mode == VersionStatus.Off) return false;
        throw new InvalidDataException($"Unknown bucket versioning status: {mode}.");
    }

    private sealed record Item(string Key, string? VersionId, long Size, bool Current);

    private async IAsyncEnumerable<List<Item>> PagesAsync(IAmazonS3 client, string prefix, bool versioned,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        string? marker = null, version = null;
        do
        {
            if (versioned)
            {
                var page = await client.ListVersionsAsync(new ListVersionsRequest
                {
                    BucketName = settings.Bucket, Prefix = prefix, MaxKeys = 256, KeyMarker = marker, VersionIdMarker = version,
                }, ct);
                yield return (page.Versions ?? []).Select(v => new Item(v.Key, v.VersionId, v.Size ?? 0, v.IsLatest == true && v.IsDeleteMarker != true)).ToList();
                marker = page.IsTruncated == true ? page.NextKeyMarker ?? throw new IOException("Missing S3 version continuation.") : null;
                version = page.NextVersionIdMarker;
            }
            else
            {
                var page = await client.ListObjectsV2Async(new ListObjectsV2Request
                {
                    BucketName = settings.Bucket, Prefix = prefix, MaxKeys = 256, ContinuationToken = marker,
                }, ct);
                yield return (page.S3Objects ?? []).Select(v => new Item(v.Key, null, v.Size ?? 0, true)).ToList();
                marker = page.IsTruncated == true ? page.NextContinuationToken ?? throw new IOException("Missing S3 continuation.") : null;
            }
        } while (marker is not null);
    }
}
