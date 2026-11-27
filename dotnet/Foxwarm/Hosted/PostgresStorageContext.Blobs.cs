using Foxwarm.Hosted.Blobs;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Storage;

namespace Foxwarm.Hosted;

internal sealed partial class PostgresStorageContext : Foxwarm.Limits.IBlobUsage
{
    /// <summary>The tenant's stored image and artifact bytes, for its blob limit.</summary>
    public async Task<long> StoredBlobBytesAsync(CancellationToken token)
    {
        long bytes = 0;
        foreach (var store in new[] { ImageBlobs, ArtifactBlobs })
            bytes += store switch
            {
                PgBlobStore pg => await pg.StoredBytesAsync(token).ConfigureAwait(false),
                S3BlobStore s3 => await s3.StoredBytesAsync(token).ConfigureAwait(false),
                _ => 0,
            };
        return bytes;
    }

    internal const string ImageBlobsName = "images";
    internal const string ArtifactBlobsName = "artifacts";

    // The context builds the PostgreSQL blob stores; OpenBlobsAsync replaces them with S3 ones
    // when the deployment selects S3, before the runtime uses them.
    partial void CreateImageBlobs(ref IBlobStore? store) =>
        store = new PgBlobStore(Database, ImageBlobsName);

    partial void CreateArtifactBlobs(ref IBlobStore? store) =>
        store = new PgBlobStore(Database, ArtifactBlobsName);

    /// <summary>
    /// Puts the tenant's blobs on the deployment's backend (<c>blobs.backend</c>). For S3 it
    /// probes once whether the endpoint supports conditional writes.
    /// </summary>
    internal async Task OpenBlobsAsync(BlobSettings settings, string tenant, CancellationToken token)
    {
        if (settings.Backend == BlobBackend.Postgres)
            return;
        var (client, conditional) = await S3Blobs
            .OpenAsync(settings.S3!, tenant, token)
            .ConfigureAwait(false);
        s3Client = client;
        imageBlobs = new S3BlobStore(client, settings.S3!.Bucket, tenant, ImageBlobsName, conditional);
        artifactBlobs = new S3BlobStore(client, settings.S3!.Bucket, tenant, ArtifactBlobsName, conditional);
        agentFileBlobs = new S3BlobStore(
            client,
            settings.S3!.Bucket,
            tenant,
            PgAgentFileStore.BlobStoreName,
            conditional
        );
        agentFiles = null;
        CreateAgentFiles(ref agentFiles);
        // The authority and the Agent store were built over the PostgreSQL stores; build them
        // again over these.
        authority = null;
        CreateAuthority(ref authority);
    }
}
