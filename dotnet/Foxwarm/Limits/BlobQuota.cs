using System.Collections.Concurrent;
using Foxwarm.Storage;

namespace Foxwarm.Limits;

/// <summary>A storage context that can report the bytes its blob stores hold.</summary>
internal interface IBlobUsage
{
    Task<long> StoredBlobBytesAsync(CancellationToken token);
}

/// <summary>
/// A tenant's blob limit (plan P2 §7.2: images and artifacts, 10 GiB, soft at 80%). New content
/// is admitted at its write: its bytes are reserved before the write, against the stores'
/// measured usage plus the content added and reserved since, and charged once when the write
/// creates it; a duplicate, a failure or a cancellation returns the reservation. Past 80% of
/// the limit the operator log warns once; content that would take the tenant over the limit is
/// refused. Blobs aren't deleted in P2, so usage only grows.
/// </summary>
/// <remarks>
/// Writes a commit needs, or migrations of content that is already durable, run in an
/// <see cref="AllowOverLimit"/> scope: they are admitted over the limit and still counted.
/// While the stores' usage can't be measured, new content fails with a storage error and the
/// next write measures again; reads and existing content are unaffected.
/// </remarks>
internal sealed class BlobQuota(long limit, Func<CancellationToken, Task<long>>? measure)
{
    internal const double SoftShare = 0.8;

    private static readonly AsyncLocal<bool> overLimit = new();
    private static readonly AsyncLocal<Reservation?> prepaid = new();

    private readonly object gate = new();
    private readonly SemaphoreSlim measuring = new(1, 1);
    private long? baseline;
    private long added;
    private long reserved;
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

    /// <summary>Bytes reserved by writes in flight.</summary>
    internal long ReservedBytes
    {
        get
        {
            lock (gate)
                return reserved;
        }
    }

    /// <summary>
    /// Admits the writes of the current flow over the limit (a commit's required write, a
    /// migration of durable content); they are still counted.
    /// </summary>
    internal static IDisposable AllowOverLimit()
    {
        var previous = overLimit.Value;
        overLimit.Value = true;
        return new Scope(() => overLimit.Value = previous);
    }

    /// <summary>The usage known so far: the measurement plus content added since.</summary>
    internal async Task<long> UsedAsync(CancellationToken token)
    {
        var measured = await BaselineAsync(token).ConfigureAwait(false);
        lock (gate)
            return measured + added;
    }

    // Measures the stores once; a failed measurement isn't kept, so the next write retries.
    private async Task<long> BaselineAsync(CancellationToken token)
    {
        lock (gate)
            if (baseline is long known)
                return known;
        await measuring.WaitAsync(token).ConfigureAwait(false);
        try
        {
            lock (gate)
                if (baseline is long known)
                    return known;
            long value;
            try
            {
                value = measure is null ? 0 : await measure(token).ConfigureAwait(false);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                MainLog.Diagnostic(
                    "Blob usage measurement failed; new blobs are refused until it succeeds: "
                        + MainLog.SafeFailure(error),
                    failure: true
                );
                throw new IOException(
                    "Can't check this installation's storage use right now. Try again shortly.",
                    error
                );
            }
            lock (gate)
                baseline = value;
            return value;
        }
        finally
        {
            measuring.Release();
        }
    }

    /// <summary>
    /// Reserves bytes for content about to be written; refused over the limit unless the flow
    /// admits it over the limit. Disposing returns what wasn't charged.
    /// </summary>
    internal async Task<Reservation> ReserveAsync(long bytes, CancellationToken token)
    {
        var measured = await BaselineAsync(token).ConfigureAwait(false);
        long total;
        lock (gate)
        {
            if (!overLimit.Value && measured + added + reserved + bytes > Limit)
                throw Refused();
            reserved += bytes;
            total = measured + added + reserved;
        }
        WarnOnce(total);
        return new Reservation(this, bytes);
    }

    /// <summary>
    /// Makes the writes of the current flow draw on a reservation of several writes (an
    /// artifact's resource and revision, reserved together so they are admitted or refused
    /// together). Synchronous, so the scope belongs to the caller's flow.
    /// </summary>
    internal static IDisposable UsePrepaid(Reservation reservation)
    {
        var previous = prepaid.Value;
        prepaid.Value = reservation;
        return new Scope(() => prepaid.Value = previous);
    }

    private TenantLimitException Refused() =>
        new(
            "blobBytes",
            $"Images and artifacts have reached this installation's {TenantLimits.Size(Limit)} storage limit."
        );

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
                $"Images and artifacts use {TenantLimits.Size(total)} of this installation's {TenantLimits.Size(Limit)} storage limit."
            );
    }

    /// <summary>The store with this quota applied to its new content.</summary>
    internal IBlobStore Apply(IBlobStore store) => new Store(store, this);

    /// <summary>Reserved bytes of writes in flight; disposing returns what wasn't charged.</summary>
    internal sealed class Reservation(BlobQuota quota, long bytes) : IDisposable
    {
        private long remaining = bytes;

        // Moves this write's bytes from reserved to added.
        internal void Charge(long amount)
        {
            lock (quota.gate)
            {
                var taken = Math.Min(amount, remaining);
                remaining -= taken;
                quota.reserved -= taken;
                quota.added += amount;
            }
        }

        public void Dispose()
        {
            lock (quota.gate)
            {
                quota.reserved -= remaining;
                remaining = 0;
            }
        }
    }

    private sealed class Scope(Action end) : IDisposable
    {
        private int ended;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref ended, 1) == 0)
                end();
        }
    }

    /// <summary>The limited store; one per underlying store, shared by all its writers.</summary>
    internal sealed class Store(IBlobStore inner, BlobQuota quota) : IBlobStore
    {
        // Creates of one key in flight: later writers share the first one's outcome.
        private readonly ConcurrentDictionary<string, Task<bool>> creating = new(StringComparer.Ordinal);

        internal BlobQuota Quota => quota;

        public bool Exists(string key) => inner.Exists(key);

        public Task<bool> ExistsAsync(string key, CancellationToken token) => inner.ExistsAsync(key, token);

        public async Task<bool> CreateAsync(
            string key,
            ReadOnlyMemory<byte> content,
            bool keepExisting,
            CancellationToken token
        )
        {
            if (!keepExisting)
                return await CreateOnceAsync(key, content, keepExisting, token).ConfigureAwait(false);
            var mine = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var current = creating.GetOrAdd(key, mine.Task);
            if (current != mine.Task)
            {
                // The same content is being created: this writer didn't create it.
                await current.WaitAsync(token).ConfigureAwait(false);
                return false;
            }
            try
            {
                var created = await CreateOnceAsync(key, content, keepExisting, token).ConfigureAwait(false);
                mine.TrySetResult(created);
                return created;
            }
            catch (Exception error)
            {
                mine.TrySetException(error);
                throw;
            }
            finally
            {
                creating.TryRemove(KeyValuePair.Create(key, mine.Task));
            }
        }

        private async Task<bool> CreateOnceAsync(
            string key,
            ReadOnlyMemory<byte> content,
            bool keepExisting,
            CancellationToken token
        )
        {
            if (prepaid.Value is { } paid)
            {
                var created = await inner.CreateAsync(key, content, keepExisting, token).ConfigureAwait(false);
                if (created)
                    paid.Charge(content.Length);
                return created;
            }
            Reservation reservation;
            try
            {
                reservation = await quota.ReserveAsync(content.Length, token).ConfigureAwait(false);
            }
            catch (TenantLimitException) when (keepExisting)
            {
                // Content already stored under its key costs nothing, even at the limit.
                if (await inner.ExistsAsync(key, token).ConfigureAwait(false))
                    return false;
                throw;
            }
            using (reservation)
            {
                var created = await inner.CreateAsync(key, content, keepExisting, token).ConfigureAwait(false);
                if (created)
                    reservation.Charge(content.Length);
                return created;
            }
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
