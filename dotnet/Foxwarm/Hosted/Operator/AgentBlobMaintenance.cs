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
                        var page = new List<(int Id, long Epoch, string Identity)>();
                        while (await rows.ReadAsync(token))
                            page.Add((rows.GetInt32(0), rows.GetInt64(1), rows.GetString(2)));
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
        var alreadyInventoried = await tenant.WriteAsync(async (tx, token) =>
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
            if (!versioned && await VersionedAsync(client, token))
                throw new IOException("Bucket versioning changed during Agent blob inventory; a new pass is required.");
            await tx.ExecuteAsync("SELECT foxwarm_agent_inventory_finish($1)", token, destination);
            return false;
        }, token: ct);
        if (alreadyInventoried)
            await CollectOneAsync(tenant, destination, prefix, ct);
    }

    private async Task CollectOneAsync(TenantDb tenant, string destination, string prefix, CancellationToken ct)
    {
        var candidate = await tenant.WriteAsync(async (tx, token) =>
        {
            using var cmd = tx.Command("SELECT key,status FROM foxwarm_agent_gc_next($1)", destination);
            await using var rows = await cmd.ExecuteReaderAsync(token);
            return await rows.ReadAsync(token) ? (rows.GetString(0), rows.GetString(1)) : default;
        }, token: ct);
        var (key, state) = candidate;
        if (key is null) return;
        var (id, secret) = settings.ReadCredentials();
        using var client = S3Blobs.Client(settings, id, secret);
        var name = prefix + key;
        var versioned = await VersionedAsync(client, ct);
        await foreach (var page in PagesAsync(client, name, versioned, ct))
        {
            var exact = page.Where(v => v.Key == name).ToArray();
            if (state == "pending")
            {
                if (exact.Any(v => v.Current))
                {
                    await tenant.WriteAsync((tx, token) => tx.ExecuteAsync("SELECT foxwarm_agent_gc_observed($1,$2)", token, destination, key), token: ct);
                    return;
                }
            }
            else if (exact.Length > 0)
            {
                var response = await client.DeleteObjectsAsync(new DeleteObjectsRequest
                {
                    BucketName = settings.Bucket,
                    Objects = exact.Select(v => new KeyVersion { Key = name, VersionId = versioned
                        ? v.VersionId ?? throw new IOException("No version ID for the Agent blob being collected.") : null }).ToList(),
                }, ct);
                if (response.DeleteErrors?.FirstOrDefault() is { } error) throw new IOException($"Agent blob delete failed: {error.Code}: {error.Message}");
                // Partial or ambiguous removal leaves the entire charge. Re-list from the
                // beginning: deletion may have changed the service's continuation markers.
                await foreach (var remaining in PagesAsync(client, name, versioned, ct))
                    if (remaining.Any(v => v.Key == name)) return;
                break;
            }
            // S3 orders by key. All exact matches precede longer keys with this prefix.
            if (page.Any(v => v.Key != name)) break;
        }
        // Enabling versioning can turn an unversioned DELETE into a marker, hiding
        // the payload from ListObjectsV2. A never-versioned bucket cannot return to
        // that state after versioning is enabled. Recheck after the empty listing.
        if (state == "deleting" && (versioned || !await VersionedAsync(client, ct)))
            await tenant.WriteAsync((tx, token) => tx.ExecuteAsync("SELECT foxwarm_agent_gc_finish($1,$2)", token, destination, key), token: ct);
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
                yield return (page.Versions ?? []).Select(v => new Item(
                    v.Key,
                    v.VersionId,
                    v.IsDeleteMarker == true ? 0 : v.Size ?? throw new IOException("Missing S3 object version size."),
                    v.IsLatest == true && v.IsDeleteMarker != true
                )).ToList();
                marker = page.IsTruncated == true ? page.NextKeyMarker ?? throw new IOException("Missing S3 version continuation.") : null;
                version = page.NextVersionIdMarker;
            }
            else
            {
                var page = await client.ListObjectsV2Async(new ListObjectsV2Request
                {
                    BucketName = settings.Bucket, Prefix = prefix, MaxKeys = 256, ContinuationToken = marker,
                }, ct);
                yield return (page.S3Objects ?? []).Select(v => new Item(
                    v.Key, null, v.Size ?? throw new IOException("Missing S3 object size."), true
                )).ToList();
                marker = page.IsTruncated == true ? page.NextContinuationToken ?? throw new IOException("Missing S3 continuation.") : null;
            }
        } while (marker is not null);
    }
}
