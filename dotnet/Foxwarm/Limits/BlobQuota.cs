using Foxwarm.Storage;

namespace Foxwarm.Limits;

/// <summary>A storage context that can report the bytes its blob stores hold.</summary>
internal interface IBlobUsage
{
    Task<long> StoredBlobBytesAsync(CancellationToken token);
}

/// <summary>
/// A tenant's blob limit (plan P2 §7.2: images and artifacts, 10 GiB, soft at 80%). New content
/// is admitted at its write: past 80% of the limit the operator log warns once, and content
/// that would take the tenant over the limit is refused. Usage is measured once from the
/// stores, then counted per new blob (blobs aren't deleted in P2). Until the measurement is
/// in, writes are admitted.
/// </summary>
internal sealed class BlobQuota(long limit, Func<CancellationToken, Task<long>>? measure)
{
    internal const double SoftShare = 0.8;

    private readonly object gate = new();
    private Task<long>? measured;
    private long added;
    private bool warned;

    internal long Limit { get; } = limit;

    /// <summary>Whether the soft limit's warning was logged.</summary>
    internal bool Warned
    {
        get
        {
            lock (gate)
                return warned;
        }
    }

    /// <summary>The usage known so far: the measurement plus content added since.</summary>
    internal async Task<long> UsedAsync(CancellationToken token)
    {
        Task<long>? measurement;
        lock (gate)
            measurement = measured ??= MeasureAsync();
        var baseline = await measurement.WaitAsync(token).ConfigureAwait(false);
        lock (gate)
            return baseline + added;
    }

    private async Task<long> MeasureAsync()
    {
        if (measure is null)
            return 0;
        try
        {
            return await measure(CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            MainLog.Diagnostic(
                "Blob usage measurement failed; blob writes are admitted: "
                    + MainLog.SafeFailure(error),
                failure: true
            );
            return 0;
        }
    }

    internal async Task AdmitAsync(long bytes, CancellationToken token)
    {
        var used = await UsedAsync(token).ConfigureAwait(false);
        WarnOnce(used);
        if (used + bytes > Limit)
            throw new TenantLimitException(
                "blobBytes",
                $"Stored images and artifacts have reached this installation's {TenantLimits.Size(Limit)} limit."
            );
    }

    internal void Added(long bytes)
    {
        long total;
        lock (gate)
        {
            added += bytes;
            total = (measured is { IsCompletedSuccessfully: true } done ? done.Result : 0) + added;
        }
        WarnOnce(total);
    }

    // The soft limit: one operator-log warning when usage passes 80%.
    private void WarnOnce(long total)
    {
        bool warn;
        lock (gate)
        {
            warn = !warned && total >= Limit * SoftShare;
            warned |= warn;
        }
        if (warn)
            MainLog.Diagnostic(
                $"Stored images and artifacts use {total} bytes, over {SoftShare:P0} of the {Limit}-byte limit."
            );
    }

    /// <summary>The store with this quota applied to its new content.</summary>
    internal IBlobStore Apply(IBlobStore store) => new Store(store, this);

    private sealed class Store(IBlobStore inner, BlobQuota quota) : IBlobStore
    {
        public bool Exists(string key) => inner.Exists(key);

        public async Task<bool> CreateAsync(
            string key,
            ReadOnlyMemory<byte> content,
            bool keepExisting,
            CancellationToken token
        )
        {
            // Content already stored under its key costs nothing.
            if (keepExisting && inner.Exists(key))
                return await inner.CreateAsync(key, content, keepExisting, token).ConfigureAwait(false);
            await quota.AdmitAsync(content.Length, token).ConfigureAwait(false);
            var created = await inner
                .CreateAsync(key, content, keepExisting, token)
                .ConfigureAwait(false);
            if (created)
                quota.Added(content.Length);
            return created;
        }

        public Task<byte[]> ReadAllAsync(string key, CancellationToken token) =>
            inner.ReadAllAsync(key, token);

        public Stream OpenRead(string key) => inner.OpenRead(key);

        public Task<byte[]> ReadRangeAsync(string key, long offset, int count, CancellationToken token) =>
            inner.ReadRangeAsync(key, offset, count, token);

        public IReadOnlyList<string> List(string prefix) => inner.List(prefix);

        public string? LocalPath(string key) => inner.LocalPath(key);
    }
}
