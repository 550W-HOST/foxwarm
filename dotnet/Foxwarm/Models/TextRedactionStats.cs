using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// Why a detection pass failed, as recorded in usage statistics. Kinds are stable identifiers.
internal static class TextRedactionFailureKind
{
    internal const string Busy = "busy";
    internal const string Timeout = "timeout";
    internal const string Connection = "connection";
    internal const string TooLarge = "too-large";
    internal const string InvalidResponse = "invalid-response";
    internal const string Config = "config";
    internal const string ServiceError = "service-error";
    internal const string Other = "other";

    internal static string ForStatus(int status) =>
        status switch
        {
            429 or 503 => Busy,
            408 => Timeout,
            413 => TooLarge,
            401 or 403 or 404 or 405 => Config,
            >= 500 and <= 599 => ServiceError,
            _ => Other,
        };
}

// Counts and timings of one attempt's redaction pass. It never holds originals or
// placeholders. Detection calls run concurrently when prefetching, so counters that the
// prefetch touches are updated atomically; everything else runs on the ordered pass.
internal sealed class TextRedactionStats
{
    private readonly object gate = new();
    private readonly SortedDictionary<string, (int Detected, int Literal)> labels = new(
        StringComparer.Ordinal
    );
    private int detectorCalls;

    // Non-empty text slots the request sent through redaction.
    internal int Slots { get; private set; }

    // Slots whose text was not cached and went to the detection service.
    internal int DetectedSlots { get; private set; }

    // Slots served from the detection cache, including those with a memoized literal result.
    internal int CachedSlots { get; private set; }

    internal int DetectorCalls => Volatile.Read(ref detectorCalls);

    // Wall time of the whole redaction pass, including waiting for the endpoint queue.
    internal double DetectionMs { get; set; }

    // A slot the detection service rejected as too large was replaced by an omission notice.
    internal bool Omitted { get; private set; }

    // Both passes finished; the request copy is ready to send.
    internal bool Completed { get; set; }

    internal int Detected
    {
        get
        {
            lock (gate)
                return labels.Values.Sum(value => value.Detected);
        }
    }

    internal int Literal
    {
        get
        {
            lock (gate)
                return labels.Values.Sum(value => value.Literal);
        }
    }

    internal IReadOnlyList<(string Label, int Detected, int Literal)> Labels
    {
        get
        {
            lock (gate)
                return labels
                    .Select(pair => (pair.Key, pair.Value.Detected, pair.Value.Literal))
                    .ToArray();
        }
    }

    internal void Slot(bool cached)
    {
        Slots++;
        if (cached)
            CachedSlots++;
        else
            DetectedSlots++;
    }

    internal void Call() => Interlocked.Increment(ref detectorCalls);

    internal void Omit() => Omitted = true;

    // A range with several labels counts once, under its first label.
    internal void Count(IEnumerable<TextRedactor.Found> spans, bool literal)
    {
        lock (gate)
            foreach (var span in spans)
            {
                var label = span.Labels.FirstOrDefault() ?? "";
                var (detected, known) = labels.GetValueOrDefault(label);
                labels[label] = literal ? (detected, known + 1) : (detected + 1, known);
            }
    }

    // The summary kept with a successful assistant message for the usage details.
    internal JsonObject ToMeta()
    {
        var byLabel = new JsonObject();
        foreach (var (label, detected, literal) in Labels)
            byLabel[label] = new JsonObject { ["detected"] = detected, ["literal"] = literal };
        var result = new JsonObject
        {
            ["replaced"] = Detected + Literal,
            ["labels"] = byLabel,
            ["slots"] = Slots,
            ["cachedSlots"] = CachedSlots,
            ["detectorCalls"] = DetectorCalls,
            ["detectionMs"] = Math.Round(DetectionMs, 1),
        };
        if (Omitted)
            result["omitted"] = true;
        return result;
    }

    internal static JsonObject LabelCounts(
        IEnumerable<(string Label, int Detected, int Literal)> labels,
        bool literal
    )
    {
        var result = new JsonObject();
        foreach (var (label, detected, known) in labels)
            if ((literal ? known : detected) is var count and > 0)
                result[label] = count;
        return result;
    }
}
