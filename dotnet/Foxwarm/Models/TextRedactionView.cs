using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// Which ranges of one stored message were replaced when it was last sent, computed on demand
// from the redactor's in-memory detection cache and memoized literal results. It never calls
// the detector and persists nothing; a slot that is no longer cached (restart, eviction or
// different settings) is reported as unavailable rather than guessed.
//
// The slot texts are rebuilt the way a request builds them (stage-S secret masking, concrete
// history preparation, then the redaction projection), so the cache key matches. The result
// carries only this message's own text and ranges, never placeholders or other originals.
internal static class TextRedactionView
{
    internal sealed record Candidate(ConcreteHostModel Leaf, TextRedactionOptions Options);

    // The redacting concrete targets a request on this route can use, in route order.
    internal static IReadOnlyList<Candidate> Candidates(HostModels catalog, string? routeKey)
    {
        if (catalog.All.Count == 0)
            return [];
        var route = catalog.Resolve(
            routeKey is not null && catalog.Contains(routeKey) ? routeKey : catalog.DefaultKey
        );
        var keys = route.IsVirtual ? route.Targets : [route.Key];
        var result = new List<Candidate>();
        foreach (var key in keys)
        {
            if (!catalog.Contains(key))
                continue;
            var leaf = catalog.Resolve(key);
            if (leaf.IsVirtual)
                continue;
            try
            {
                if (
                    TextRedactionOptions.FromResolved(
                        leaf.Configuration["textRedaction"] as JsonObject
                    ) is
                    { } options
                )
                    result.Add(new(leaf, options));
            }
            catch (InvalidDataException)
            {
                // Catalog validation reports invalid settings.
            }
        }
        return result;
    }

    internal static JsonObject Describe(
        JsonObject message,
        IReadOnlyList<Candidate> candidates,
        Foxwarm.Secrets.InstanceSecrets? secrets
    )
    {
        if (candidates.Count == 0)
            return new JsonObject { ["enabled"] = false };
        TextRedactor? redactor = null;
        try
        {
            if (secrets is not null)
                redactor = TextRedactor.For(secrets.TextRedactionPlaceholderKey());
        }
        catch (Exception)
        {
            // Without the key nothing can have been sent redacted; report it as unavailable.
        }
        JsonObject? best = null;
        var bestFound = -1;
        foreach (var candidate in candidates)
        {
            var slots = Slots(message, candidate.Leaf, secrets);
            var found = 0;
            var rows = new JsonArray();
            foreach (var (slot, text) in slots)
            {
                var row = new JsonObject
                {
                    ["kind"] = slot.Kind,
                    ["part"] = slot.Part,
                    ["text"] = text,
                };
                if (slot.Path is not null)
                    row["path"] = slot.Path;
                if (slot.Name is not null)
                    row["name"] = slot.Name;
                if (slot.CallId is not null)
                    row["callId"] = slot.CallId;
                var cached = redactor?.Peek(candidate.Options, TextRedactor.Digest(text));
                // A slot that never finished its literal pass was not sent in this form.
                if (cached is { Masked: { } masked })
                {
                    found++;
                    row["available"] = true;
                    row["ranges"] = Ranges(cached.Value.Spans, masked);
                }
                else
                    row["available"] = false;
                rows.Add(row);
            }
            if (found <= bestFound)
                continue;
            bestFound = found;
            best = new JsonObject
            {
                ["enabled"] = true,
                ["state"] =
                    rows.Count == 0 ? "empty"
                    : found == rows.Count ? "available"
                    : found == 0 ? "unavailable"
                    : "partial",
                ["slots"] = rows,
            };
        }
        return best!;
    }

    // The slot texts of this message as a request to `leaf` would build them.
    private static List<(TextSlot Slot, string Text)> Slots(
        JsonObject message,
        ConcreteHostModel leaf,
        Foxwarm.Secrets.InstanceSecrets? secrets
    )
    {
        var copy = (JsonObject)message.DeepClone();
        if (secrets is not null)
            copy = Foxwarm.Secrets.SecretMessageRedaction.Message(
                secrets.Redactor,
                copy,
                new Foxwarm.Secrets.SecretMessageRedaction.Findings()
            );
        var prepared = ConcreteRequestHistory.Prepare([copy], leaf.Key, leaf.HistoryCompatibility);
        var slots = new List<(TextSlot, string)>();
        TextRedactionProjection
            .RedactSlotsAsync(
                prepared,
                (slot, text) =>
                {
                    if (text.Length > 0)
                        slots.Add((slot, text));
                    return Task.FromResult(text);
                }
            )
            .GetAwaiter()
            .GetResult();
        return slots;
    }

    // Detected spans are offsets in the slot text; literal spans are offsets in the detected
    // form, where earlier detected ranges already hold placeholders, so they are shifted back.
    private static JsonArray Ranges(TextRedactor.Found[] detected, TextRedactor.Found[] literal)
    {
        var ranges = new List<(int Start, int Length, string Label, string Source)>();
        foreach (var span in detected)
            ranges.Add((span.Start, span.Length, span.Labels.FirstOrDefault() ?? "", "detected"));
        var ordered = detected.OrderBy(span => span.Start).ToArray();
        foreach (var span in literal)
        {
            var shift = 0;
            foreach (var earlier in ordered)
            {
                if (span.Start < earlier.Start + shift + earlier.Placeholder.Length)
                    break;
                shift += earlier.Placeholder.Length - earlier.Length;
            }
            ranges.Add(
                (span.Start - shift, span.Length, span.Labels.FirstOrDefault() ?? "", "literal")
            );
        }
        return new JsonArray(
            ranges
                .OrderBy(range => range.Start)
                .Select(range =>
                    (JsonNode?)
                        new JsonObject
                        {
                            ["start"] = range.Start,
                            ["length"] = range.Length,
                            ["label"] = range.Label,
                            ["source"] = range.Source,
                        }
                )
                .ToArray()
        );
    }
}
