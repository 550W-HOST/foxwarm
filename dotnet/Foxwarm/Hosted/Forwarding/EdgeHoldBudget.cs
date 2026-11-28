namespace Foxwarm.Hosted.Forwarding;

// Held only until local dispatch or remote response headers. Hostnames and aliases
// share the canonical tenant's counter; unknown names never allocate a dictionary key.
internal sealed class EdgeHoldBudget(int perTenant, int total = 2048, int unresolved = 128)
{
    private readonly object gate = new();
    private readonly Dictionary<string, int> tenants = new(StringComparer.Ordinal);
    private int used, resolving;

    internal IDisposable? TryEnter(string? slug)
    {
        lock (gate)
        {
            if (used == total) return null;
            if (slug is null)
            {
                if (resolving == unresolved) return null;
                resolving++;
            }
            else
            {
                var count = tenants.GetValueOrDefault(slug);
                if (count == perTenant) return null;
                tenants[slug] = count + 1;
            }
            used++;
            return new Hold(this, slug);
        }
    }

    private sealed class Hold(EdgeHoldBudget owner, string? slug) : IDisposable
    {
        public void Dispose()
        {
            lock (owner.gate)
            {
                owner.used--;
                if (slug is null) owner.resolving--;
                else if (--owner.tenants[slug] == 0) owner.tenants.Remove(slug);
            }
        }
    }
}
