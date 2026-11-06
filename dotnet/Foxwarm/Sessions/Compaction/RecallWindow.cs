using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

// Session-local search continuations retain ranked locators, not Archive message bodies.
// Losing an owner or evicting a window expires its cursors; Archive remains the authority.
internal sealed class RecallWindowStore
{
    internal const int SourceLimit = 128;
    private const int WindowLimit = 4;
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);
    private readonly object gate = new();
    private readonly Dictionary<string, RecallWindow> windows = new(StringComparer.Ordinal);

    internal sealed record RecallWindow(
        string Id,
        string Fingerprint,
        DateTimeOffset CreatedAt,
        IReadOnlyList<JsonObject> Candidates,
        int TotalRanked
    );

    internal RecallWindow Add(
        string fingerprint,
        IReadOnlyList<JsonObject> candidates,
        JsonArray sources,
        int totalRanked
    )
    {
        var fields = new[]
        {
            "id",
            "source_family",
            "session_id",
            "kind",
            "seq",
            "start_seq",
            "end_seq",
            "raw_start_seq",
            "raw_end_seq",
            "block_id",
            "chunk_text",
            "matched_facts",
            "_distance",
            "lexical_score",
            "lexical_rank",
            "fusion_score",
        };
        var locators = candidates
            .Take(SourceLimit)
            .Select(
                (hit, index) =>
                {
                    if (SessionWait.Text(sources[index]?["kind"]) == "unavailable")
                        return new JsonObject
                        {
                            ["session_id"] = hit["session_id"]?.DeepClone(),
                            ["compatibility"] = sources[index]!.DeepClone(),
                        };
                    var locator = new JsonObject();
                    foreach (var field in fields)
                        if (hit.TryGetPropertyValue(field, out var value))
                            locator[field] = value?.DeepClone();
                    return locator;
                }
            )
            .ToArray();
        var window = new RecallWindow(
            Guid.NewGuid().ToString("N"),
            fingerprint,
            DateTimeOffset.UtcNow,
            locators,
            totalRanked
        );
        lock (gate)
        {
            foreach (
                var expired in windows
                    .Values.Where(value => window.CreatedAt - value.CreatedAt >= Lifetime)
                    .ToArray()
            )
                windows.Remove(expired.Id);
            while (windows.Count >= WindowLimit)
                windows.Remove(windows.Values.MinBy(value => value.CreatedAt)!.Id);
            windows.Add(window.Id, window);
        }
        return window;
    }

    internal (RecallWindow Window, int Offset) Read(string cursor, string fingerprint)
    {
        var parts = cursor.Split('.');
        if (parts.Length != 2 || !int.TryParse(parts[1], out var offset) || offset < 0)
            throw new InvalidDataException("cursor is invalid or expired; start a new search.");
        lock (gate)
        {
            if (
                !windows.TryGetValue(parts[0], out var window)
                || DateTimeOffset.UtcNow - window.CreatedAt >= Lifetime
            )
            {
                windows.Remove(parts[0]);
                throw new InvalidDataException("cursor is invalid or expired; start a new search.");
            }
            if (window.Fingerprint != fingerprint || offset >= window.Candidates.Count)
                throw new InvalidDataException(
                    "cursor does not match this recall query and filter set."
                );
            return (window, offset);
        }
    }

    internal static string Cursor(RecallWindow window, int offset) => window.Id + "." + offset;
}
