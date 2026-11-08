using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Secrets;

internal sealed record SecretExposure(
    string Label,
    long Count,
    long FirstSeenAt,
    long LastSeenAt,
    string LastSource,
    string? LastSessionId
);

// Where known values were found and masked. Content is never recorded: only the label,
// the redaction point and the Session. Setup shows these as rotation hints.
internal sealed class SecretExposures : IDisposable
{
    private const int MaximumLabels = 512;
    private static readonly TimeSpan PersistDelay = TimeSpan.FromSeconds(5);

    private readonly string path;
    private readonly TimeProvider clock;
    private readonly object gate = new();
    private readonly object writeGate = new();
    private long changes;
    private long written;
    private readonly Dictionary<string, SecretExposure> entries = new(StringComparer.Ordinal);
    private ITimer? pending;
    private bool loaded;
    private bool disposed;

    internal SecretExposures(string path, TimeProvider? clock = null)
    {
        this.path = Path.GetFullPath(path);
        this.clock = clock ?? TimeProvider.System;
    }

    internal void Record(IEnumerable<string> labels, string source, string? sessionId)
    {
        var now = clock.GetUtcNow().ToUnixTimeMilliseconds();
        lock (gate)
        {
            if (disposed)
                return;
            Load();
            foreach (var label in labels)
            {
                entries[label] = entries.TryGetValue(label, out var prior)
                    ? prior with
                    {
                        Count = prior.Count + 1,
                        LastSeenAt = now,
                        LastSource = source,
                        LastSessionId = sessionId,
                    }
                    : new SecretExposure(label, 1, now, now, source, sessionId);
            }
            while (entries.Count > MaximumLabels)
                entries.Remove(entries.Values.MinBy(entry => entry.LastSeenAt)!.Label);
            changes++;
            pending ??= clock.CreateTimer(
                _ => Flush(),
                null,
                PersistDelay,
                Timeout.InfiniteTimeSpan
            );
        }
    }

    internal IReadOnlyList<SecretExposure> List()
    {
        lock (gate)
        {
            Load();
            return entries.Values.OrderByDescending(entry => entry.LastSeenAt).ToArray();
        }
    }

    internal void Clear(string label)
    {
        lock (gate)
        {
            Load();
            if (!entries.Remove(label))
                return;
            changes++;
            pending ??= clock.CreateTimer(
                _ => Flush(),
                null,
                TimeSpan.Zero,
                Timeout.InfiniteTimeSpan
            );
        }
    }

    internal void Flush()
    {
        JsonObject payload;
        long version;
        lock (gate)
        {
            version = changes;
            pending?.Dispose();
            pending = null;
            if (!loaded)
                return;
            var items = new JsonObject();
            foreach (var entry in entries.Values)
                items[entry.Label] = new JsonObject
                {
                    ["count"] = entry.Count,
                    ["firstSeenAt"] = entry.FirstSeenAt,
                    ["lastSeenAt"] = entry.LastSeenAt,
                    ["lastSource"] = entry.LastSource,
                    ["lastSessionId"] = entry.LastSessionId,
                };
            payload = new JsonObject { ["version"] = 1, ["labels"] = items };
        }
        // Writes are serialized and an older snapshot never replaces a newer one.
        lock (writeGate)
        {
            if (version <= written)
                return;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                new LinuxAtomicJsonFile(
                    Path.GetDirectoryName(path)!,
                    Path.GetFileName(path),
                    privateFile: true
                ).WritePayload(payload);
                written = version;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                MainLog.Diagnostic(
                    "Secret exposure record failed: " + MainLog.SafeFailure(error),
                    failure: true
                );
            }
        }
    }

    public void Dispose()
    {
        Flush();
        lock (gate)
            disposed = true;
    }

    private void Load()
    {
        if (loaded)
            return;
        loaded = true;
        if (!File.Exists(path))
            return;
        try
        {
            if (
                JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8))?["labels"]
                is not JsonObject labels
            )
                return;
            foreach (var (label, node) in labels)
                if (node is JsonObject item)
                    entries[label] = new SecretExposure(
                        label,
                        (long)(SessionWait.Number(item["count"]) ?? 0),
                        (long)(SessionWait.Number(item["firstSeenAt"]) ?? 0),
                        (long)(SessionWait.Number(item["lastSeenAt"]) ?? 0),
                        SessionWait.Text(item["lastSource"]) ?? "",
                        SessionWait.Text(item["lastSessionId"])
                    );
        }
        catch (Exception error) when (error is IOException or System.Text.Json.JsonException)
        {
            MainLog.Diagnostic(
                "Secret exposure record failed: " + MainLog.SafeFailure(error),
                failure: true
            );
        }
    }
}
