namespace Foxwarm.Storage;

/// <summary>
/// Immutable content under string keys, one store per use (image blobs, artifact revisions
/// and resources). A key is written once: it is never replaced in place. Key syntax and
/// content validation belong to the owning class; the store maps keys to storage.
/// </summary>
internal interface IBlobStore
{
    bool Exists(string key);

    /// <summary>Whether the key exists, without blocking a thread on remote storage.</summary>
    Task<bool> ExistsAsync(string key, CancellationToken token) => Task.FromResult(Exists(key));

    /// <summary>
    /// Writes the content completely before the key becomes visible. Returns false when the
    /// key already existed, including when a concurrent writer published it first, and
    /// <paramref name="keepExisting"/> is set; the stored content is then left unchanged and
    /// made durable. Without it, an existing key fails with an <see cref="IOException"/>.
    /// </summary>
    Task<bool> CreateAsync(
        string key,
        ReadOnlyMemory<byte> content,
        bool keepExisting,
        CancellationToken token
    );

    /// <summary>
    /// As <see cref="CreateAsync(string, ReadOnlyMemory{byte}, bool, CancellationToken)"/>, and
    /// calls <paramref name="uncertain"/> when the outcome can't be known: the content may have
    /// been stored by this write although the result says otherwise (a lost response, a
    /// cancellation after the write was sent). Stores whose outcome is always known never call it.
    /// </summary>
    Task<bool> CreateAsync(
        string key,
        ReadOnlyMemory<byte> content,
        bool keepExisting,
        Action uncertain,
        CancellationToken token
    ) => CreateAsync(key, content, keepExisting, token);

    /// <summary>The stored bytes. A missing or unreadable key fails like a file read.</summary>
    Task<byte[]> ReadAllAsync(string key, CancellationToken token);

    /// <summary>Streams the stored bytes; the caller disposes the stream.</summary>
    Stream OpenRead(string key);

    /// <summary>
    /// Up to <paramref name="count"/> stored bytes from <paramref name="offset"/>, fetching only
    /// those; past the end, none. A missing key fails like a file read.
    /// </summary>
    Task<byte[]> ReadRangeAsync(string key, long offset, int count, CancellationToken token);

    /// <summary>Keys of the content directly under <paramref name="prefix"/>, without it.</summary>
    IReadOnlyList<string> List(string prefix);

    /// <summary>
    /// The file that holds the content when the store is local, for zero-copy sends; null
    /// otherwise.
    /// </summary>
    string? LocalPath(string key);
}
