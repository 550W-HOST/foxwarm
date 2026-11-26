using System.Diagnostics;
using System.Net;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Foxwarm.Storage;

namespace Foxwarm.Hosted.Blobs;

/// <summary>
/// The S3 blob backend: one tenant's blobs of one store under <c>t/&lt;tenant&gt;/&lt;store&gt;/</c>
/// in the deployment's bucket. Creates are create-once: a conditional <c>PUT</c>
/// (<c>If-None-Match: *</c>, 412 meaning the key exists) when the endpoint supports it, as
/// probed once at startup, otherwise <c>HEAD</c> then <c>PUT</c>. S3 writes aren't covered by
/// the database fence; see <c>units/hosted-blobs.md</c> for why a write from a fenced owner is
/// harmless. The interface's synchronous members wait for their request.
/// </summary>
internal sealed class S3BlobStore : IBlobStore
{
    private const int ConflictAttempts = 5;

    private readonly IAmazonS3 client;
    private readonly string bucket;
    private readonly string root;
    private readonly int pageSize;

    /// <param name="conditionalWrites">The result of <see cref="S3Blobs.ProbeConditionalWritesAsync"/>.</param>
    /// <param name="pageSize">Keys per <c>ListObjectsV2</c> page.</param>
    internal S3BlobStore(
        IAmazonS3 client,
        string bucket,
        string tenant,
        string store,
        bool conditionalWrites,
        int pageSize = 1000
    )
    {
        this.client = client;
        this.bucket = bucket;
        root = S3Blobs.TenantRoot(tenant) + store + "/";
        ConditionalWrites = conditionalWrites;
        this.pageSize = pageSize;
    }

    /// <summary>Whether creates use <c>If-None-Match: *</c>; otherwise <c>HEAD</c> then <c>PUT</c>.</summary>
    internal bool ConditionalWrites { get; }

    public bool Exists(string key) => Wait(() => ExistsAsync(root + key, CancellationToken.None));

    public async Task<bool> CreateAsync(
        string key,
        ReadOnlyMemory<byte> content,
        bool keepExisting,
        CancellationToken token
    )
    {
        var name = root + key;
        try
        {
            if (!ConditionalWrites)
            {
                // Safe without the condition: keys are immutable, and the owning store's lane
                // serializes the creates of one key in the single owner.
                if (await ExistsAsync(name, token).ConfigureAwait(false))
                    return Existing(key, keepExisting);
                await PutAsync(name, content, conditional: false, token).ConfigureAwait(false);
                return true;
            }
            for (var attempt = 1; ; attempt++)
            {
                switch (await PutConditionallyAsync(name, content, token).ConfigureAwait(false))
                {
                    case PutOutcome.Created:
                        return true;
                    case PutOutcome.Exists:
                        // A retried PUT whose first attempt stored the object finds it existing;
                        // the same bytes under the key are this write.
                        if (!keepExisting && await HoldsAsync(name, content, token).ConfigureAwait(false))
                            return true;
                        return Existing(key, keepExisting);
                    case PutOutcome.Conflict when attempt < ConflictAttempts:
                        // A concurrent conditional write of the key is in flight.
                        await Task.Delay(50 * attempt, token).ConfigureAwait(false);
                        continue;
                    default:
                        throw new IOException(
                            $"The blob {key} couldn't be created: concurrent writes kept conflicting."
                        );
                }
            }
        }
        catch (Exception error) when (S3Blobs.Failure(error, key) is { } failure)
        {
            throw failure;
        }
    }

    public async Task<byte[]> ReadAllAsync(string key, CancellationToken token)
    {
        try
        {
            using var response = await client
                .GetObjectAsync(new GetObjectRequest { BucketName = bucket, Key = root + key }, token)
                .ConfigureAwait(false);
            if (response.ContentLength > Array.MaxLength)
                throw new IOException($"The blob {key} is too large to read at once.");
            var bytes = new byte[response.ContentLength];
            await response.ResponseStream.ReadExactlyAsync(bytes, token).ConfigureAwait(false);
            return bytes;
        }
        catch (Exception error) when (S3Blobs.Failure(error, key) is { } failure)
        {
            throw failure;
        }
    }

    public Stream OpenRead(string key) =>
        Wait(async () =>
        {
            try
            {
                var response = await client
                    .GetObjectAsync(new GetObjectRequest { BucketName = bucket, Key = root + key })
                    .ConfigureAwait(false);
                return (Stream)new ResponseStream(response, key);
            }
            catch (Exception error) when (S3Blobs.Failure(error, key) is { } failure)
            {
                throw failure;
            }
        });

    public IReadOnlyList<string> List(string prefix) =>
        Wait(async () =>
        {
            var start = prefix.Length == 0 ? root : root + prefix + "/";
            var names = new List<string>();
            var request = new ListObjectsV2Request
            {
                BucketName = bucket,
                Prefix = start,
                Delimiter = "/",
                MaxKeys = pageSize,
            };
            try
            {
                while (true)
                {
                    var page = await client.ListObjectsV2Async(request).ConfigureAwait(false);
                    foreach (var item in page.S3Objects ?? [])
                        if (item.Key.Length > start.Length)
                            names.Add(item.Key[start.Length..]);
                    if (page.IsTruncated != true || string.IsNullOrEmpty(page.NextContinuationToken))
                        return (IReadOnlyList<string>)names;
                    request.ContinuationToken = page.NextContinuationToken;
                }
            }
            catch (Exception error) when (S3Blobs.Failure(error, prefix) is { } failure)
            {
                throw failure;
            }
        });

    public string? LocalPath(string key) => null;

    private static bool Existing(string key, bool keepExisting) =>
        keepExisting ? false : throw new IOException($"The blob {key} already exists.");

    private async Task<bool> ExistsAsync(string name, CancellationToken token)
    {
        try
        {
            await client
                .GetObjectMetadataAsync(
                    new GetObjectMetadataRequest { BucketName = bucket, Key = name },
                    token
                )
                .ConfigureAwait(false);
            return true;
        }
        catch (AmazonS3Exception error) when (error.StatusCode == HttpStatusCode.NotFound)
        {
            return false;
        }
    }

    private Task<PutOutcome> PutAsync(
        string name,
        ReadOnlyMemory<byte> content,
        bool conditional,
        CancellationToken token
    ) => S3Blobs.PutAsync(client, bucket, name, content, conditional, token);

    /// <summary>
    /// A conditional <c>PUT</c> of a create. An endpoint may refuse it for an existing key before
    /// it has read the whole body and close the connection, so the client, still sending, sees a reset
    /// instead of the 412 (VersityGW does, also after <c>100 Continue</c>). A transport failure
    /// therefore decides by the key: keys are created once and never removed, so an existing key
    /// is the 412's outcome. A missing key leaves the failure as it is.
    /// </summary>
    private async Task<PutOutcome> PutConditionallyAsync(
        string name,
        ReadOnlyMemory<byte> content,
        CancellationToken token
    )
    {
        ExceptionDispatchInfo interrupted;
        try
        {
            return await PutAsync(name, content, conditional: true, token).ConfigureAwait(false);
        }
        catch (Exception error)
            when (error is IOException or HttpRequestException && !token.IsCancellationRequested)
        {
            interrupted = ExceptionDispatchInfo.Capture(error);
        }
        if (await ExistsAsync(name, token).ConfigureAwait(false))
            return PutOutcome.Exists;
        interrupted.Throw();
        throw new UnreachableException();
    }

    private async Task<bool> HoldsAsync(string name, ReadOnlyMemory<byte> content, CancellationToken token)
    {
        using var response = await client
            .GetObjectAsync(new GetObjectRequest { BucketName = bucket, Key = name }, token)
            .ConfigureAwait(false);
        if (response.ContentLength != content.Length)
            return false;
        var stored = new byte[content.Length];
        await response.ResponseStream.ReadExactlyAsync(stored, token).ConfigureAwait(false);
        return stored.AsSpan().SequenceEqual(content.Span);
    }

    // The interface's synchronous members; the SDK has asynchronous requests only.
    private static T Wait<T>(Func<Task<T>> request) => Task.Run(request).GetAwaiter().GetResult();

    private sealed class ResponseStream(GetObjectResponse response, string key)
        : ForwardReadStream(response.ContentLength)
    {
        protected override int ReadSource(Span<byte> buffer)
        {
            try
            {
                return response.ResponseStream.Read(buffer);
            }
            catch (Exception error) when (S3Blobs.Failure(error, key) is { } failure)
            {
                throw failure;
            }
        }

        protected override async ValueTask<int> ReadSourceAsync(
            Memory<byte> buffer,
            CancellationToken token
        )
        {
            try
            {
                return await response.ResponseStream.ReadAsync(buffer, token).ConfigureAwait(false);
            }
            catch (Exception error) when (S3Blobs.Failure(error, key) is { } failure)
            {
                throw failure;
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
                response.Dispose();
            base.Dispose(disposing);
        }
    }
}

internal enum PutOutcome
{
    Created,
    Exists,
    Conflict,
    Unsupported,
}

/// <summary>The S3 client, key layout and conditional-write probe of the S3 blob backend.</summary>
internal static class S3Blobs
{
    internal const string ProbeKey = ".probe/conditional-write";

    /// <summary>The key prefix of one tenant's blobs in the bucket.</summary>
    internal static string TenantRoot(string tenant) =>
        tenant is { Length: > 0 } and not ("." or "..") && !tenant.Contains('/')
            ? "t/" + tenant + "/"
            : throw new ArgumentException("Invalid tenant name for blob keys.", nameof(tenant));

    internal static AmazonS3Client Client(S3BlobSettings settings, string accessKeyId, string secretAccessKey) =>
        new(
            new BasicAWSCredentials(accessKeyId, secretAccessKey),
            new AmazonS3Config
            {
                ServiceURL = settings.Endpoint.ToString(),
                AuthenticationRegion = settings.Region,
                ForcePathStyle = settings.PathStyle,
            }
        );

    /// <summary>
    /// The client of the deployment's S3 settings and whether its endpoint supports conditional
    /// writes. Reads the credential files and probes the endpoint once. A refused request means
    /// the settings are wrong and fails as <see cref="HostedStartupException"/>; an unreachable
    /// endpoint fails as it is, so the replica may retry.
    /// </summary>
    internal static async Task<(AmazonS3Client Client, bool ConditionalWrites)> OpenAsync(
        S3BlobSettings settings,
        string tenant,
        CancellationToken token
    )
    {
        string accessKeyId;
        string secretAccessKey;
        try
        {
            (accessKeyId, secretAccessKey) = settings.ReadCredentials();
        }
        catch (HostedBootstrapException error)
        {
            throw new HostedStartupException(error.Message);
        }
        var client = Client(settings, accessKeyId, secretAccessKey);
        try
        {
            return (client, await ProbeConditionalWritesAsync(client, settings.Bucket, tenant, token).ConfigureAwait(false));
        }
        catch (AmazonS3Exception error) when ((int)error.StatusCode is >= 400 and < 500)
        {
            client.Dispose();
            throw new HostedStartupException(
                $"The S3 blob backend refused access to bucket {settings.Bucket}: {error.ErrorCode ?? error.StatusCode.ToString()}: {error.Message}"
            );
        }
        catch
        {
            client.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Whether the endpoint honors <c>If-None-Match: *</c> on <c>PUT</c>. Writes the tenant's
    /// probe object, then writes it again conditionally: an endpoint that supports conditional
    /// writes refuses the second with 412; one that ignores the header accepts it, and one
    /// that rejects the header fails it as not implemented.
    /// </summary>
    internal static async Task<bool> ProbeConditionalWritesAsync(
        IAmazonS3 client,
        string bucket,
        string tenant,
        CancellationToken token
    )
    {
        var name = TenantRoot(tenant) + ProbeKey;
        byte[] content = [(byte)'1'];
        for (var attempt = 0; attempt < 3; attempt++)
            switch (await PutAsync(client, bucket, name, content, conditional: true, token).ConfigureAwait(false))
            {
                case PutOutcome.Exists:
                    return true;
                case PutOutcome.Unsupported:
                    return false;
                // Created: the first write; the next attempt decides. A conflict repeats.
                case PutOutcome.Created when attempt > 0:
                    return false;
            }
        return false;
    }

    internal static async Task<PutOutcome> PutAsync(
        IAmazonS3 client,
        string bucket,
        string name,
        ReadOnlyMemory<byte> content,
        bool conditional,
        CancellationToken token
    )
    {
        var bytes = MemoryMarshal.TryGetArray(content, out var segment)
            ? segment
            : new ArraySegment<byte>(content.ToArray());
        var request = new PutObjectRequest
        {
            BucketName = bucket,
            Key = name,
            InputStream = new MemoryStream(bytes.Array!, bytes.Offset, bytes.Count, writable: false),
            ContentType = "application/octet-stream",
        };
        if (conditional)
            request.IfNoneMatch = "*";
        try
        {
            await client.PutObjectAsync(request, token).ConfigureAwait(false);
            return PutOutcome.Created;
        }
        catch (AmazonS3Exception error) when (conditional && error.StatusCode == HttpStatusCode.PreconditionFailed)
        {
            return PutOutcome.Exists;
        }
        catch (AmazonS3Exception error) when (conditional && error.StatusCode == HttpStatusCode.Conflict)
        {
            return PutOutcome.Conflict;
        }
        catch (AmazonS3Exception error)
            when (conditional
                && (error.StatusCode == HttpStatusCode.NotImplemented || error.ErrorCode == "NotImplemented"))
        {
            return PutOutcome.Unsupported;
        }
    }

    /// <summary>
    /// The blob-store failure for an S3 or transport error: a missing key fails like a missing
    /// file, anything else as an <see cref="IOException"/>. Null leaves the exception as it is.
    /// </summary>
    internal static Exception? Failure(Exception error, string key) =>
        error switch
        {
            IOException or OperationCanceledException { CancellationToken.IsCancellationRequested: true } => null,
            AmazonS3Exception { StatusCode: HttpStatusCode.NotFound } => new FileNotFoundException(
                $"The blob {key} doesn't exist.",
                error
            ),
            AmazonServiceException or AmazonClientException or HttpRequestException or TaskCanceledException =>
                new IOException($"The blob storage request for {key} failed: {error.Message}", error),
            _ => null,
        };
}
