namespace Foxwarm.Channels.WebUi;

// One generation owns its tenant's staging directory. Framework multipart temp files live
// until response disposal; the slots bound their aggregate even for chunked requests.
internal sealed class HostedUploadStaging : IDisposable
{
    private sealed class Entry(long charge)
    {
        internal long Charge => charge;
        internal DateTimeOffset? Expires;
        internal Action<string>? Forget;
        internal int Readers;
        internal bool Removed;
    }
    private readonly object gate = new();
    private readonly Dictionary<string, Entry> files = new(StringComparer.Ordinal);
    private readonly Timer timer;
    private readonly long limit;
    private long used;
    private int spools;
    private bool disposed;
    internal string Root { get; }

    internal HostedUploadStaging(string dataRoot, long uploadLimit)
    {
        Root = Path.Combine(dataRoot, "foxwarm-uploads");
        ResetDirectory(); // Lose grants and incomplete writes together on a new generation.
        limit = uploadLimit > long.MaxValue / 2 ? long.MaxValue : 2 * uploadLimit;
        timer = new Timer(_ => Sweep(DateTimeOffset.UtcNow), null, Timeout.Infinite, Timeout.Infinite);
    }

    private sealed class Spool(HostedUploadStaging owner) : IDisposable
    {
        public void Dispose()
        {
            lock (owner.gate)
                owner.spools--;
        }
    }

    internal bool ReserveMultipart(HttpResponse response)
    {
        lock (gate)
        {
            if (disposed || spools >= 2) return false;
            spools++;
            // ASP.NET disposes callbacks in reverse order, so form parsing must follow this.
            response.RegisterForDispose(new Spool(this));
            return true;
        }
    }

    internal bool Reserve(string path, long length)
    {
        lock (gate)
        {
            var charge = Math.Max(length, Math.Min(limit / 2, 4096));
            if (disposed || charge > limit - used) return false;
            files.Add(path, new(charge));
            used += charge;
            return true;
        }
    }

    internal void Published(string path, Action<string>? forget)
    {
        lock (gate)
        {
            if (!files.TryGetValue(path, out var entry)) return; // Revoked during publication.
            entry.Expires = DateTimeOffset.UtcNow.AddDays(1);
            entry.Forget = forget;
            if (!scheduled)
            {
                scheduled = true;
                timer.Change(TimeSpan.FromHours(24), Timeout.InfiniteTimeSpan);
            }
        }
    }

    private bool scheduled;

    internal void Sweep(DateTimeOffset now)
    {
        lock (gate)
        {
            if (disposed) return;
            var next = TimeSpan.FromDays(1);
            scheduled = false;
            foreach (var (path, entry) in files.ToArray())
            {
                if (entry.Expires is not { } expires) continue;
                if (expires <= now)
                {
                    try { Delete(path); continue; }
                    catch (IOException) { next = TimeSpan.FromMinutes(1); }
                    catch (UnauthorizedAccessException) { next = TimeSpan.FromMinutes(1); }
                }
                else if (expires - now < next) next = expires - now;
                scheduled = true;
            }
            if (scheduled) timer.Change(next, Timeout.InfiniteTimeSpan);
        }
    }

    // Unix keeps an unlinked file's blocks until the last handle closes. Pin the charge
    // before opening it, so consumption or revocation cannot release a still-open file.
    internal IDisposable? PinRead(string path)
    {
        lock (gate)
        {
            if (!files.TryGetValue(Path.GetFullPath(path), out var entry)) return null;
            entry.Readers++;
            return new Reader(this, entry);
        }
    }

    private sealed class Reader(HostedUploadStaging owner, Entry entry) : IDisposable
    {
        public void Dispose()
        {
            lock (owner.gate)
                if (--entry.Readers == 0 && entry.Removed) owner.used -= entry.Charge;
        }
    }

    internal void CancelWrite(string path, bool created, Action cleanup)
    {
        try
        {
            cleanup();
        }
        finally
        {
            if (!created) Forget(path); // CreateNew failed; never delete someone else’s file.
            else Published(path, null); // Schedules expiry only if cleanup left an entry.
        }
    }

    private void Forget(string path)
    {
        lock (gate)
        {
            if (!files.Remove(Path.GetFullPath(path), out var entry)) return;
            entry.Removed = true;
            if (entry.Readers == 0) used -= entry.Charge;
            entry.Forget?.Invoke(path);
        }
    }

    internal void Delete(string path)
    {
        lock (gate)
        {
            File.Delete(path);
            Forget(path);
        }
    }

    private void ResetDirectory()
    {
        if (Directory.Exists(Root)) Directory.Delete(Root, recursive: true);
    }

    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
            timer.Dispose();
            ResetDirectory();
            files.Clear();
        }
    }
}
