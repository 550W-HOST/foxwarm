using System.Text.Json.Nodes;
using Amazon.S3;
using Amazon.S3.Model;
using Foxwarm.Hosted.Blobs;

namespace Foxwarm.Hosted.Operator;

internal sealed partial class OperatorStore
{
    internal static readonly TimeSpan LateWriteRecheck = TimeSpan.FromHours(24);

    internal Task<JsonNode> ReadReceiptsAsync(CancellationToken ct) =>
        database.ClusterAsync(
            async (tx, token) =>
                JsonNode.Parse(
                    (string)
                        (
                            await Scalar(
                                tx,
                                """
                                SELECT coalesce(jsonb_agg(jsonb_build_object('tenantId',tenant_id,'slug',slug,'observedEmptyAt',observed_empty_at,
                                    'status','lateWriteCheckPending','recheckAfter',recheck_after,'foundLateObjects',found_late_objects) ORDER BY recheck_after,tenant_id),'[]')::text FROM operator_object_receipts
                                """,
                                token
                            )
                        )!
                )!,
            ct
        );

    private async Task RecheckReceiptsAsync(ObjectSweep cursor, CancellationToken ct)
    {
        var after = 0;
        while (true)
        {
            var page = await database.ClusterAsync(
                async (tx, token) =>
                {
                    var rows =
                        new List<(int Id, string Identity, string Endpoint, string Bucket)>();
                    await using var query = tx.Command(
                        "SELECT tenant_id,object_identity,endpoint,bucket FROM operator_object_receipts WHERE tenant_id>$1 AND recheck_after<=clock_timestamp() ORDER BY tenant_id LIMIT 32",
                        after
                    );
                    await using var reader = await query.ExecuteReaderAsync(token);
                    while (await reader.ReadAsync(token))
                        rows.Add(
                            (
                                reader.GetInt32(0),
                                reader.GetString(1),
                                reader.GetString(2),
                                reader.GetString(3)
                            )
                        );
                    return rows;
                },
                ct
            );
            foreach (var row in page)
            {
                after = row.Id;
                try
                {
                    if (
                        deletionS3 is null
                        || deletionS3.Bucket != row.Bucket
                        || deletionS3.Endpoint.AbsoluteUri != row.Endpoint
                    )
                    {
                        var removed = await database.ClusterAsync(
                            (tx, token) =>
                                tx.ExecuteAsync(
                                    "DELETE FROM operator_object_receipts WHERE tenant_id=$1",
                                    token,
                                    row.Id
                                ),
                            ct
                        );
                        if (removed == 1)
                            Console.Error.WriteLine(
                                $"[operator] Warning: namespace {row.Identity} (tenant {row.Id}) at endpoint {row.Endpoint}, bucket {row.Bucket}, was not checked because the storage destination changed. The receipt was discarded."
                            );
                        continue;
                    }
                    if (
                        await cursor.SweepAsync(
                            deletionS3,
                            row.Id,
                            true,
                            row.Identity,
                            ct,
                            () =>
                                database.ClusterAsync(
                                    (tx, token) =>
                                        tx.ExecuteAsync(
                                            "UPDATE operator_object_receipts SET found_late_objects=true WHERE tenant_id=$1 AND NOT found_late_objects",
                                            token,
                                            row.Id
                                        ),
                                    ct
                                )
                        )
                    )
                    {
                        var found = await database.ClusterAsync(
                            (tx, token) =>
                                Scalar(
                                    tx,
                                    "DELETE FROM operator_object_receipts WHERE tenant_id=$1 RETURNING found_late_objects",
                                    token,
                                    row.Id
                                ),
                            ct
                        );
                        if (found is bool late)
                            Console.WriteLine(
                                $"[operator] Late-write check completed for namespace {row.Identity} (tenant {row.Id}): {(late ? "late objects were found and removed" : "no late objects were found")}; final listing empty."
                            );
                    }
                }
                catch (Exception error) when (!ct.IsCancellationRequested)
                {
                    Console.Error.WriteLine(
                        $"[operator] Late-write check for tenant {row.Id} remains pending: {error.Message}"
                    );
                }
            }
            if (page.Count < 32)
                return;
        }
    }

    // One page per namespace per round. Markers belong only to this worker; losing a
    // marker restarts a pass. Only an empty first (untruncated) page proves an empty pass.
    private sealed class ObjectSweep
    {
        private sealed record Marker(bool Versioned, string Key, string? Version);

        private readonly Dictionary<(int Id, bool Late), Marker> markers = [];

        // Another worker can finish a namespace while this worker holds its page marker.
        private HashSet<(int Id, bool Late)> unvisited = [];

        internal void BeginRound() => unvisited = [.. markers.Keys];

        internal void EndRound()
        {
            foreach (var key in unvisited)
                markers.Remove(key);
        }

        internal async Task<bool> SweepAsync(
            S3BlobSettings settings,
            int tenant,
            bool late,
            string identity,
            CancellationToken ct,
            Func<Task>? observedObjects = null
        )
        {
            var (user, secret) = settings.ReadCredentials();
            using var client = S3Blobs.Client(settings, user, secret);
            var mode = (
                await client.GetBucketVersioningAsync(
                    new GetBucketVersioningRequest { BucketName = settings.Bucket },
                    ct
                )
            )
                .VersioningConfig
                ?.Status;
            var versioned = mode == VersionStatus.Enabled || mode == VersionStatus.Suspended;
            if (!versioned && mode is not null && mode != VersionStatus.Off)
                throw new InvalidDataException($"Unknown bucket versioning status: {mode}.");
            var key = (tenant, late);
            unvisited.Remove(key);
            markers.TryGetValue(key, out var marker);
            if (marker?.Versioned != versioned)
                marker = null;
            var prefix = S3Blobs.TenantRoot(identity);
            List<KeyVersion> objects;
            Marker? next = null;
            if (versioned)
            {
                var page = await client.ListVersionsAsync(
                    new ListVersionsRequest
                    {
                        BucketName = settings.Bucket,
                        Prefix = prefix,
                        MaxKeys = 256,
                        KeyMarker = marker?.Key,
                        VersionIdMarker = marker?.Version,
                    },
                    ct
                );
                objects = (page.Versions ?? [])
                    .Select(v => new KeyVersion { Key = v.Key, VersionId = v.VersionId })
                    .ToList();
                if (page.IsTruncated == true)
                    next = new(
                        true,
                        page.NextKeyMarker
                            ?? throw new IOException(
                                "Truncated S3 version listing has no next key marker."
                            ),
                        page.NextVersionIdMarker
                    );
            }
            else
            {
                var page = await client.ListObjectsV2Async(
                    new ListObjectsV2Request
                    {
                        BucketName = settings.Bucket,
                        Prefix = prefix,
                        MaxKeys = 256,
                        ContinuationToken = marker?.Key,
                    },
                    ct
                );
                objects = (page.S3Objects ?? [])
                    .Select(v => new KeyVersion { Key = v.Key })
                    .ToList();
                if (page.IsTruncated == true)
                    next = new(
                        false,
                        page.NextContinuationToken
                            ?? throw new IOException(
                                "Truncated S3 listing has no continuation token."
                            ),
                        null
                    );
            }
            if (next is null)
                markers.Remove(key);
            else
                markers[key] = next;
            if (objects.Count == 0)
                return next is null && marker is null;
            if (observedObjects is not null)
                await observedObjects();
            DeleteObjectsResponse deletion;
            try
            {
                deletion = await client.DeleteObjectsAsync(
                    new DeleteObjectsRequest { BucketName = settings.Bucket, Objects = objects },
                    ct
                );
            }
            catch (DeleteObjectsException error)
            {
                deletion = error.Response;
            }
            // Version markers can name a version just removed by this batch. After any
            // successful deletes, restart from the beginning. Keep the service markers
            // when the whole page is retained, so later erasable versions get a turn.
            if (versioned && (deletion.DeleteErrors?.Count ?? 0) < objects.Count)
                markers.Remove(key);
            if (deletion.DeleteErrors?.FirstOrDefault() is { } failure)
                throw new IOException(
                    $"S3 delete failed: {failure.Code}: {failure.Message} Check object retention, legal holds and the operator's deletion permissions."
                );
            return false;
        }
    }
}
