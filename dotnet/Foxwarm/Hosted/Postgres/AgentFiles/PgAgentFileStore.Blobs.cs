using Foxwarm.Hosted.Blobs;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Postgres;

internal sealed partial class PgAgentFileStore
{
    private sealed record BlobReservation(string ContentKey, string ObjectKey, string State, bool Fresh);

    private sealed class Claim
    {
        internal Guid Id;
        internal bool Held;
    }

    private async Task<T> WithClaimAsync<T>(Func<Claim, Task<T>> operation)
    {
        var claim = new Claim();
        try
        {
            return await operation(claim);
        }
        catch when (claim.Held)
        {
            try
            {
                await database.WriteAsync(async (tx, ct) =>
                {
                    await LockUsageAsync(tx, ct);
                    return await tx.ExecuteAsync("UPDATE agent_blob_reservations SET claim=NULL,claim_epoch=NULL WHERE claim=$1", ct, claim.Id);
                });
            }
            catch (Exception error)
            {
                Console.Error.WriteLine($"[hosted] Could not release an Agent blob admission; the next epoch ignores its claim: {error.Message}");
            }
            throw;
        }
    }

    // Commit the charge before any network PUT. A missing acknowledgement from this SQL
    // transaction authorizes no network write; a subsequent admission finds the same charge.
    private async Task<Dictionary<string, BlobReservation>> ReserveAsync(
        Claim claim, string agent, (byte[] Hash, ReadOnlyMemory<byte> Bytes)[] files,
        Func<PgTx, UsageRow, AgentStoreLimits, CancellationToken, Task> admit, CancellationToken token)
    {
        if (files.Length == 0) return [];
        claim.Id = Guid.NewGuid();
        var contents = files.DistinctBy(file => BlobKey(agent, file.Hash))
            .ToDictionary(file => BlobKey(agent, file.Hash), file => file.Bytes, StringComparer.Ordinal);
        var s3 = blobs as S3BlobStore;
        var reservations = await database.WriteAsync(async (tx, ct) =>
        {
            var usage = await LockUsageAsync(tx, ct);
            var limit = limits();
            await admit(tx, usage, limit, ct);
            await RequireInventoryAsync(tx, s3, ct);
            var result = new Dictionary<string, BlobReservation>(StringComparer.Ordinal);
            foreach (var (key, bytes) in contents)
            {
                string objectKey;
                string state;
                using (var cmd = tx.Command("SELECT object_key,state FROM agent_blob_reservations WHERE content_key=$1", key))
                await using (var reader = await cmd.ExecuteReaderAsync(ct))
                {
                    if (await reader.ReadAsync(ct))
                    {
                        objectKey = reader.GetString(0);
                        state = reader.GetString(1);
                        if (state == "deleting") throw new IOException("This Agent file content is being collected. Retry the write.");
                        result.Add(key, new(key, objectKey, state, false));
                        continue;
                    }
                }
                objectKey = s3 is null ? key : key + "." + Guid.NewGuid().ToString("N");
                await tx.ExecuteAsync("INSERT INTO agent_blob_reservations(content_key,object_key,byte_length,state) VALUES ($1,$2,$3,'reserved')", ct, key, objectKey, (long)bytes.Length);
                result.Add(key, new(key, objectKey, "reserved", true));
            }
            await tx.ExecuteAsync("UPDATE agent_blob_reservations SET claim=$1, claim_epoch=$2 WHERE content_key=ANY($3)", ct,
                claim.Id, database.Epoch, contents.Keys.ToArray());
            if (result.Values.Any(r => r.Fresh))
            {
                if (s3 is null)
                    await tx.ExecuteAsync("""
                        SELECT foxwarm_collect_agent_pg(overage) FROM
                            (SELECT sum(byte_length)-2*$1::numeric AS overage FROM agent_blob_reservations) usage
                        WHERE overage>0
                        """, ct, limit.TotalBytes);
                var bound = 2m * limit.TotalBytes;
                if (await ScalarAsync(tx, "SELECT sum(byte_length)>2*$1::numeric FROM agent_blob_reservations", ct, limit.TotalBytes) is true)
                {
                    var detail = s3 is null ? "" : " Check that the operator is running and can collect unreferenced object versions.";
                    Console.Error.WriteLine($"[hosted] Agent file admission for tenant {database.TenantId} would exceed the retained content limit of {bound} bytes.{detail}");
                    throw AgentFileErrors.RetainedTooLarge(bound);
                }
            }
            claim.Held = true;
            return result;
        }, new PgWriteOptions(Retryable: true), token);
        if (s3 is not null)
            foreach (var r in reservations.Values)
                await EnsureRemoteAsync(s3, claim, r, contents[r.ContentKey], token);
        return reservations;
    }

    private static async Task RequireInventoryAsync(PgTx tx, S3BlobStore? s3, CancellationToken ct)
    {
        var inventory = await ScalarAsync(tx, "SELECT blob_inventory FROM agent_file_usage", ct) as string;
        var destination = s3?.InventoryDestination ?? "postgres";
        if (inventory == destination) return;
        if (s3 is not null || inventory is not null)
        {
            const string error = "Agent file storage is waiting for its inventory. Run the hosted operator with the same blob backend and destination as the replica.";
            Console.Error.WriteLine("[hosted] " + error);
            throw new IOException(error);
        }
        await tx.ExecuteAsync("INSERT INTO agent_blob_reservations(content_key,object_key,byte_length,state) SELECT key,key,byte_length,'stored' FROM blob_objects WHERE store='agent-files'", ct);
        await tx.ExecuteAsync("UPDATE agent_file_usage SET blob_inventory='postgres'", ct);
    }

    private async Task EnsureRemoteAsync(S3BlobStore s3, Claim claim, BlobReservation reservation, ReadOnlyMemory<byte> bytes, CancellationToken ct)
    {
        if (reservation.State == "stored") return;
        if (reservation.State == "reserved")
        {
            await database.WriteAsync(async (tx, cancel) =>
            {
                await LockUsageAsync(tx, cancel);
                var dispatched = await tx.ExecuteAsync("""
                    UPDATE agent_blob_reservations SET state='pending',conditional_put=$3
                    WHERE object_key=$1 AND state='reserved' AND claim=$2
                    """, cancel, reservation.ObjectKey, claim.Id, s3.ConditionalWrites);
                if (dispatched == 0)
                    throw new IOException("Agent file storage changed during admission. Retry the write.");
                return true;
            }, token: ct);
        }
        else
        {
            if (await s3.ExistsAsync(reservation.ObjectKey, ct)) return;
            // With an unknown previous dispatch, conditional writes can still produce at most
            // one object version while the key exists. Never collect this key: a prior PUT
            // could otherwise arrive after deletion. An unconditional retry isn't safe.
            if (!s3.ConditionalWrites) throw new IOException("The previous Agent file upload has not been confirmed by storage. Retry after it becomes visible.");
            await database.WriteAsync(async (tx, cancel) =>
            {
                await LockUsageAsync(tx, cancel);
                var pinned = await tx.ExecuteAsync("""
                    UPDATE agent_blob_reservations SET state='pinned'
                    WHERE object_key=$1 AND state IN ('pending','pinned') AND conditional_put AND claim=$2
                    """, cancel, reservation.ObjectKey, claim.Id);
                if (pinned == 0)
                    throw new IOException("Agent file storage changed during admission. Retry the write.");
                return true;
            }, token: ct);
        }
        await s3.PutAgentFileOnceAsync(reservation.ObjectKey, bytes, ct);
    }

    private async Task<string> PublishBlobAsync(PgTx tx, Claim claim, BlobReservation reservation, ReadOnlyMemory<byte> content, byte[] hash, CancellationToken ct)
    {
        // LockUsageAsync already serialized this publication against collection. A collector
        // that won the race retired this admission; it cannot delete a subsequent incarnation.
        var published = await tx.ExecuteAsync("""
            UPDATE agent_blob_reservations SET state=CASE WHEN state='pinned' THEN state ELSE 'stored' END,
                claim=NULL,claim_epoch=NULL
            WHERE object_key=$1 AND state<>'deleting' AND (claim=$2 OR claim IS NULL)
            """, ct, reservation.ObjectKey, claim.Id);
        if (published == 0)
            throw new IOException("Agent file storage changed during admission. Retry the write.");
        if (blobs is not S3BlobStore)
            await PgBlobStore.CreateInAsync(tx, BlobStoreName, reservation.ObjectKey, content, hash, true, ct);
        return reservation.ObjectKey;
    }
}
