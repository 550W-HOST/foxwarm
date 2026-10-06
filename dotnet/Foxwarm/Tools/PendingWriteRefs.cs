using System.Security.Cryptography;
using System.Text;

namespace Foxwarm.Tools;

internal sealed class PendingWriteRefs
{
    private sealed record Entry(
        string Id,
        string SessionId,
        string Agent,
        string Content,
        long Created,
        long Expires,
        int Bytes,
        object? Lifetime
    );

    private readonly object gate = new();
    private readonly Dictionary<string, Entry> entries = [];
    private readonly Func<long> clock;

    internal PendingWriteRefs(Func<long>? clock = null) =>
        this.clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    private void Prune(long now)
    {
        foreach (var entry in entries.Values.Where(entry => entry.Expires <= now).ToArray())
            entries.Remove(entry.Id);
        while (
            entries.Count > 32 || entries.Values.Sum(entry => (long)entry.Bytes) > 8 * 1024 * 1024
        )
            entries.Remove(entries.Values.OrderBy(entry => entry.Created).First().Id);
    }

    internal string? Register(
        string sessionId,
        string agent,
        string content,
        object? lifetime = null
    )
    {
        var bytes = Encoding.UTF8.GetByteCount(content);
        if (bytes > 2 * 1024 * 1024)
            return null;
        lock (gate)
        {
            var now = clock();
            Prune(now);
            var id = "write_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(6));
            entries[id] = new(
                id,
                sessionId,
                agent,
                content,
                now,
                now + 15 * 60 * 1000,
                bytes,
                lifetime
            );
            Prune(now);
            return id;
        }
    }

    internal string Peek(string id, string sessionId, string agent, object? lifetime = null)
    {
        lock (gate)
        {
            Prune(clock());
            if (!entries.TryGetValue(id, out var entry))
                throw new InvalidDataException(
                    $"Pending write contentRef not found or expired: {id}. Re-run write with content, or use a fresh contentRef from the previous write error."
                );
            if (
                lifetime is null
                    ? entry.SessionId != sessionId || entry.Agent != agent
                    : !ReferenceEquals(entry.Lifetime, lifetime)
            )
                throw new InvalidDataException(
                    $"Pending write contentRef {id} is not available in this session/agent."
                );
            return entry.Content;
        }
    }

    internal void Consume(string id)
    {
        lock (gate)
            entries.Remove(id);
    }
}
