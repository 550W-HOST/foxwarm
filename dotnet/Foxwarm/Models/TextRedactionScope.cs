using System.Collections.Concurrent;
using Found = Foxwarm.Models.TextRedactor.Found;

namespace Foxwarm.Models;

// Redaction state of one provider attempt. Every placeholder this attempt introduces, by
// detection or by literal masking of known originals, is registered here, and restoration
// of this attempt's output uses only these pairs. A placeholder that merely appears in input
// (for example copied from another Session) is never restored.
internal sealed class TextRedactionScope(
    TextRedactor redactor,
    HttpClient http,
    TextRedactionOptions settings,
    CancellationToken token
)
{
    internal const string OmittedText = "[Text omitted: too long for text redaction]";

    private readonly TextRedactionOptions options = settings with
    {
        KnownLabels = redactor.KnownLabels,
    };

    private readonly Dictionary<string, string> registered = new(StringComparer.Ordinal);

    // The second projection visits the same occurrences in the same order. Keep a queue
    // per intermediate text, not a text-to-result map: a cached final form can equal the
    // detected form of a different slot without authorizing it to rewrite that cached slot.
    private sealed record Slot(string Digest, Found[] Spans, Found[]? Masked);

    private readonly Dictionary<string, Queue<Slot>> pending = new(StringComparer.Ordinal);
    private TextRedactor.KnownOriginals? originals;

    // Compaction replaces a slot the detection service rejects as too large instead of
    // failing, so a long message cannot prevent the Session from being compacted.
    internal bool OmitOversized { get; init; }

    // Counts and timings of this attempt, when the request owner records them.
    internal TextRedactionStats? Stats { get; init; }

    internal IReadOnlyDictionary<string, string> Registered => registered;

    // Detection results fetched ahead of the ordered pass, by slot text. Registration and
    // caching still happen in slot order in `DetectAsync`.
    private readonly ConcurrentDictionary<string, Found[]> prefetched = new(StringComparer.Ordinal);

    // Detects the uncached texts ahead of the ordered pass: combined into calls of up to
    // `batchBytes` and sent concurrently up to the endpoint's limit. A failure fails the request
    // as it would in the ordered pass. Texts of a call rejected as too large are left for that
    // pass, which detects them one by one and applies the same rule.
    internal async Task PrefetchAsync(IEnumerable<string> texts)
    {
        var pending = texts
            .Where(text => text.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .Where(text => redactor.Cached(options, text, TextRedactor.Digest(text)) is null)
            .ToArray();
        var calls = Batches(pending, options.BatchBytes);
        // Ahead detection only helps when it combines texts or runs calls side by side.
        var combined = calls.Any(call => call.Count > 1);
        if (!combined && (options.MaxConcurrency <= 1 || calls.Count < 2))
            return;
        await Parallel
            .ForEachAsync(
                calls,
                new ParallelOptions
                {
                    MaxDegreeOfParallelism = options.MaxConcurrency,
                    CancellationToken = token,
                },
                async (call, cancel) =>
                {
                    try
                    {
                        Stats?.Call();
                        if (call.Count == 1)
                        {
                            prefetched[call[0]] = await redactor
                                .DetectAsync(http, options, call[0], cancel)
                                .ConfigureAwait(false);
                            return;
                        }
                        var found = await redactor
                            .DetectBatchAsync(http, options, call, cancel)
                            .ConfigureAwait(false);
                        for (var index = 0; index < call.Count; index++)
                            prefetched[call[index]] = found[index];
                    }
                    catch (TextRedactionException error) when (error.TooLarge) { }
                }
            )
            .ConfigureAwait(false);
    }

    // Groups texts in order into calls whose combined UTF-8 size, separators included, stays
    // within `limit`. A text at or above the limit, or any text when the limit is 0, is a call
    // of its own.
    internal static List<List<string>> Batches(IReadOnlyList<string> texts, int limit)
    {
        var calls = new List<List<string>>();
        var separator = System.Text.Encoding.UTF8.GetByteCount(TextRedactor.BatchSeparator);
        List<string>? current = null;
        var size = 0;
        foreach (var text in texts)
        {
            var bytes = System.Text.Encoding.UTF8.GetByteCount(text);
            if (current is not null && size + separator + bytes <= limit)
            {
                current.Add(text);
                size += separator + bytes;
                continue;
            }
            current = [text];
            size = bytes;
            calls.Add(current);
        }
        return calls;
    }

    // Detection only. Unchanged slot text reuses its cached spans without a detection call.
    internal async Task<string> DetectAsync(string text)
    {
        token.ThrowIfCancellationRequested();
        if (text.Length == 0)
            return text;
        var digest = TextRedactor.Digest(text);
        var cached = redactor.Cached(options, text, digest);
        Stats?.Slot(cached is not null);
        if (cached is null)
        {
            Found[] detected;
            try
            {
                if (prefetched.TryRemove(text, out var early))
                    detected = early;
                else
                {
                    Stats?.Call();
                    detected = await redactor
                        .DetectAsync(http, options, text, token)
                        .ConfigureAwait(false);
                }
            }
            catch (TextRedactionException error) when (error.TooLarge && OmitOversized)
            {
                Stats?.Omit();
                return OmittedText;
            }
            // Cache validates collisions before accepting a result. Only its winner grants
            // this attempt restoration authority; a losing classification was never sent.
            cached = redactor.Cache(options, digest, detected);
        }
        var spans = cached.Value.Spans;
        var masked = cached.Value.Masked;
        Register(spans);
        if (masked is not null)
            Register(masked);
        Stats?.Count(spans, literal: false);
        // New registrations may need a newer matcher for the literal pass.
        originals = null;
        var form = TextRedactor.Apply(text, spans);
        if (masked is not null)
            form = TextRedactor.Apply(form, masked);
        if (!pending.TryGetValue(form, out var slots))
            pending[form] = slots = new();
        slots.Enqueue(new(digest, spans, masked));
        return form;
    }

    // Memoize and use the winning literal pass. Cached final occurrences are never scanned
    // again, even when another slot happens to produce the same intermediate text.
    internal string MaskKnown(string text)
    {
        if (pending.TryGetValue(text, out var slots) && slots.TryDequeue(out var slot))
        {
            if (slots.Count == 0)
                pending.Remove(text);
            if (slot.Masked is { } already)
            {
                Stats?.Count(already, literal: true);
                return text;
            }
            var found = redactor.Memoize(options, slot.Digest, slot.Spans, Scan(text));
            Register(found);
            Stats?.Count(found, literal: true);
            return TextRedactor.Apply(text, found);
        }
        var scanned = Scan(text);
        Register(scanned);
        Stats?.Count(scanned, literal: true);
        return TextRedactor.Apply(text, scanned);
    }

    private Found[] Scan(string text)
    {
        originals ??= redactor.KnownSnapshot();
        return redactor.FindKnown(originals, text, options).ToArray();
    }

    internal async Task<string> RedactAsync(string text) =>
        MaskKnown(await DetectAsync(text).ConfigureAwait(false));

    internal string Restore(string text) => redactor.Restore(text, registered);

    internal async Task<string[]> DetectRunAsync(string[] texts)
    {
        var form = await DetectAsync(string.Concat(texts)).ConfigureAwait(false);
        return form == OmittedText
            ? texts.Select((_, index) => index == 0 ? OmittedText : "").ToArray()
            : redactor.RedactRun(texts, form, registered);
    }

    internal string[] MaskKnownRun(string[] texts) =>
        redactor.RedactRun(texts, MaskKnown(string.Concat(texts)), registered);

    internal async Task<string[]> RedactRunAsync(string[] texts) =>
        MaskKnownRun(await DetectRunAsync(texts).ConfigureAwait(false));

    internal string[] RestoreRun(string[] texts) => redactor.RestoreRun(texts, registered);

    internal string RestoreProgress(string text) => redactor.RestoreProgress(text, registered);

    private void Register(IEnumerable<TextRedactor.Found> spans)
    {
        foreach (var span in spans)
        {
            // Restoration must never return a different value than the one replaced.
            if (
                registered.TryGetValue(span.Placeholder, out var existing)
                    && !string.Equals(existing, span.Original, StringComparison.Ordinal)
                || !redactor.TryRegister(span.Placeholder, span.Original, span.Labels)
            )
                throw new TextRedactionException(
                    "Text redaction placeholder collision; no model request was sent.",
                    false
                );
            registered[span.Placeholder] = span.Original;
        }
    }
}
