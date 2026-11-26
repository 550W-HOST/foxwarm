using Amazon.S3;
using Amazon.S3.Model;
using Foxwarm.Hosted.Blobs;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// A bucket of its own on the S3 fixture (or on an endpoint in front of it) with a client of
/// the product's configuration. Disposing deletes its objects and the bucket.
/// </summary>
internal sealed class S3TestBucket : IAsyncDisposable
{
    internal const string Tenant = "default";

    private S3TestBucket(AmazonS3Client client, string name, S3BlobSettings settings)
    {
        Client = client;
        Name = name;
        Settings = settings;
    }

    internal AmazonS3Client Client { get; }

    internal string Name { get; }

    internal S3BlobSettings Settings { get; }

    /// <param name="endpoint">The endpoint to address instead of the fixture's own.</param>
    internal static async Task<S3TestBucket> CreateAsync(Uri? endpoint = null)
    {
        var server = await S3Server.SharedAsync();
        var settings = new S3BlobSettings(
            endpoint ?? server.Endpoint,
            S3Server.Region,
            S3Server.NewBucketName(),
            PathStyle: true,
            "/unused/access-key-id",
            "/unused/secret-access-key"
        );
        var client = S3Blobs.Client(settings, server.AccessKey, server.SecretKey);
        await client.PutBucketAsync(new PutBucketRequest { BucketName = settings.Bucket });
        return new S3TestBucket(client, settings.Bucket, settings);
    }

    internal Task<bool> ProbeAsync(string tenant = Tenant) =>
        S3Blobs.ProbeConditionalWritesAsync(Client, Name, tenant, CancellationToken.None);

    internal S3BlobStore Store(string store, bool conditional, int pageSize = 1000, string tenant = Tenant) =>
        new(Client, Name, tenant, store, conditional, pageSize);

    /// <summary>Every key in the bucket.</summary>
    internal async Task<List<string>> KeysAsync()
    {
        var keys = new List<string>();
        var request = new ListObjectsV2Request { BucketName = Name };
        while (true)
        {
            var page = await Client.ListObjectsV2Async(request);
            keys.AddRange((page.S3Objects ?? []).Select(item => item.Key));
            if (page.IsTruncated != true)
                return keys;
            request.ContinuationToken = page.NextContinuationToken;
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            foreach (var key in await KeysAsync())
                await Client.DeleteObjectAsync(Name, key);
            await Client.DeleteBucketAsync(Name);
        }
        finally
        {
            Client.Dispose();
        }
    }
}
