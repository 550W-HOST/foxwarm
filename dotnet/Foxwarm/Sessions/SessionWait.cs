using System.Globalization;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

// Main-local translation of sessionManager's wait state/queue transition, not a separate inbox.
internal static class SessionWait
{
    internal static JsonObject? Current(JsonObject meta) => meta["wait"] as JsonObject;

    internal static string? Text(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    internal static string[] Strings(JsonNode? node) =>
        node is JsonArray array ? array.Select(Text).OfType<string>().ToArray() : [];

    internal static double? Number(JsonNode? node)
    {
        if (node is not JsonValue value)
            return null;
        if (value.TryGetValue<double>(out var number))
            return number;
        if (value.TryGetValue<long>(out var signed))
            return signed;
        if (value.TryGetValue<int>(out var integer))
            return integer;
        return null;
    }

    internal static QueueItem Event(
        string type,
        string body,
        JsonObject? attributes = null,
        JsonObject? fields = null
    )
    {
        var now = DateTimeOffset.Now;
        var time =
            now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
            + " "
            + now.ToString("zzz", CultureInfo.InvariantCulture)
                .Replace(":", "", StringComparison.Ordinal);
        var attrs = attributes is null
            ? ""
            : string.Concat(
                attributes.Select(pair =>
                    $" {pair.Key}=\"{Escape(pair.Value is JsonValue value && value.TryGetValue<string>(out var s) ? s : pair.Value?.ToJsonString() ?? "")}\""
                )
            );
        var wrapper =
            $"<foxwarm-system kind=\"event\" type=\"{type}\"{attrs} time=\"{time}\">\n{body}\n</foxwarm-system>";
        return new QueueItem(
            QueueItemType.Background,
            [new JsonObject { ["system"] = wrapper }],
            OpenFields: fields
        );
    }

    private static string Escape(string text) =>
        text.Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal);

    internal static IReadOnlyList<QueueItem> Apply(JsonObject meta, QueueItem item)
    {
        var wait = Current(meta);
        var fingerprint = Text(item.OpenFields?["waitLivenessFingerprint"]);
        if (fingerprint is not null)
        {
            if (wait is null || Text(item.OpenFields?["waitLivenessWaitId"]) != Text(wait["id"]))
                return [];
            var prior = Strings(meta["waitLivenessFingerprints"]);
            if (prior.Contains(fingerprint, StringComparer.Ordinal))
                return [];
            meta["waitLivenessFingerprints"] = new JsonArray(
                prior
                    .Append(fingerprint)
                    .TakeLast(16)
                    .Select(value => (JsonNode?)JsonValue.Create(value))
                    .ToArray()
            );
        }
        var timeoutId = Text(item.OpenFields?["waitTimeoutId"]);
        if (wait is null)
            return timeoutId is null ? [item.CloneItem()] : [];
        if (timeoutId is not null && timeoutId != Text(wait["id"]))
            return [];
        if (item.Type == QueueItemType.CompactCommit || !item.Trigger)
            return [item.CloneItem()];
        if (wait["waitAll"] is JsonObject all)
        {
            var targets = Strings(all["sessions"]);
            var satisfied = Strings(all["satisfiedSessions"]);
            var deferred = all["deferredQueue"]!.AsArray();
            var listed =
                timeoutId is null
                && item.Type == QueueItemType.Intersession
                && item.SourceSessionId is string source
                && targets.Contains(source, StringComparer.Ordinal);
            if (listed)
            {
                deferred.Add(PersistentSessionAuthorityStore.ToQueueJson(item));
                if (!satisfied.Contains(item.SourceSessionId!, StringComparer.Ordinal))
                    all["satisfiedSessions"] = new JsonArray(
                        satisfied
                            .Append(item.SourceSessionId!)
                            .Select(value => (JsonNode?)JsonValue.Create(value))
                            .ToArray()
                    );
                var pending = targets
                    .Except(Strings(all["satisfiedSessions"]), StringComparer.Ordinal)
                    .ToArray();
                if (pending.Length > 0)
                    return [];
                var flush = deferred
                    .Select(row => PersistentSessionAuthorityStore.FromQueueJson(row!.AsObject()))
                    .ToArray();
                meta.Remove("wait");
                return flush;
            }
            var remaining = targets.Except(satisfied, StringComparer.Ordinal).ToArray();
            var result = deferred
                .Select(row => PersistentSessionAuthorityStore.FromQueueJson(row!.AsObject()))
                .ToList();
            result.Add(item.CloneItem());
            if (remaining.Length > 0)
                result.Add(
                    Event(
                        "wait-all-pending",
                        $"waitAllSessions is still pending for: {string.Join(", ", remaining.Select(id => $"`{id}`"))}. This session was woken before every listed session sent a new message after the wait started.",
                        new JsonObject { ["pendingSessions"] = string.Join(",", remaining) }
                    )
                );
            meta.Remove("wait");
            return result;
        }
        meta.Remove("wait");
        return [item.CloneItem()];
    }

    internal static void Validate(JsonObject meta)
    {
        if (meta.ContainsKey("waitLivenessFingerprints"))
        {
            if (
                meta["waitLivenessFingerprints"] is not JsonArray prints
                || prints.Count > 16
                || prints.Any(value => string.IsNullOrEmpty(Text(value)))
            )
                throw new InvalidDataException("Invalid wait-liveness fingerprints.");
        }
        if (!meta.ContainsKey("wait"))
            return;
        var wait = Current(meta) ?? throw new InvalidDataException("Wait state must be an object.");
        if (
            string.IsNullOrWhiteSpace(Text(wait["id"]))
            || Number(wait["startedAt"]) is not double started
            || !double.IsFinite(started)
        )
            throw new InvalidDataException("Wait state requires an ID and finite start time.");
        if (wait.ContainsKey("reason") && Text(wait["reason"]) is null)
            throw new InvalidDataException("Invalid wait reason.");
        if (
            wait.ContainsKey("timeoutSeconds")
            && (
                Number(wait["timeoutSeconds"]) is not double seconds
                || !double.IsFinite(seconds)
                || seconds <= 0
            )
        )
            throw new InvalidDataException("Invalid wait timeout.");
        foreach (var key in new[] { "waitAnySessions", "waitExecIds" })
            if (wait.ContainsKey(key))
                ValidateIds(wait[key], key, 1);
        if (wait.ContainsKey("waitForInput") && wait["waitForInput"]?.GetValue<bool>() != true)
            throw new InvalidDataException("Invalid input wait.");
        if (wait.ContainsKey("declarationVersion") && Number(wait["declarationVersion"]) != 1)
            throw new InvalidDataException("Invalid wait declaration version.");
        if (wait["waitAll"] is JsonObject all)
        {
            // Stored/internal waits can have one source; new tool declarations are validated separately.
            ValidateIds(all["sessions"], "waitAll.sessions", 1);
            ValidateIds(all["satisfiedSessions"], "waitAll.satisfiedSessions", 0);
            if (
                Strings(all["satisfiedSessions"])
                    .Except(Strings(all["sessions"]), StringComparer.Ordinal)
                    .Any()
            )
                throw new InvalidDataException("Unknown satisfied wait source.");
            if (all["deferredQueue"] is not JsonArray deferred)
                throw new InvalidDataException("Invalid deferred wait queue.");
            foreach (var row in deferred)
                _ = PersistentSessionAuthorityStore.FromQueueJson(
                    row?.AsObject() ?? throw new InvalidDataException("Invalid deferred item.")
                );
        }
        else if (wait.ContainsKey("waitAll"))
            throw new InvalidDataException("Invalid wait-all state.");
        if (wait["waitAll"] is not null && wait["waitAnySessions"] is not null)
            throw new InvalidDataException("Wait-all and wait-any are mutually exclusive.");
    }

    private static void ValidateIds(JsonNode? node, string label, int minimum)
    {
        if (
            node is not JsonArray array
            || array.Count < minimum
            || array.Any(value => string.IsNullOrWhiteSpace(Text(value)))
            || Strings(array).Distinct(StringComparer.Ordinal).Count() != array.Count
        )
            throw new InvalidDataException($"Invalid {label}.");
    }
}
