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
    TextRedactionOptions options,
    CancellationToken token
)
{
    internal const string OmittedText = "[Text omitted: too long for text redaction]";

    private readonly Dictionary<string, string> registered = new(StringComparer.Ordinal);

    // Literal masking is memoized per cached slot. `pending` maps detected text awaiting the
    // literal pass to the cache digests of its slots; `finished` maps text whose result is
    // already known in this attempt to that result and the literal ranges it adds (none when
    // `DetectAsync` already returned the final form).
    private readonly Dictionary<string, List<string>> pending = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (string Result, Found[] Literal)> finished = new(
        StringComparer.Ordinal
    );
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

    // Detects the uncached texts concurrently, up to the endpoint's limit, before the ordered
    // pass consumes them. A failure fails the request as it would in the ordered pass; a text
    // rejected as too large is left for that pass, which applies the same rule.
    internal async Task PrefetchAsync(IEnumerable<string> texts)
    {
        if (options.MaxConcurrency <= 1)
            return;
        var pending = texts
            .Where(text => text.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .Where(text => redactor.Cached(options, TextRedactor.Digest(text)) is null)
            .ToArray();
        if (pending.Length < 2)
            return;
        await Parallel
            .ForEachAsync(
                pending,
                new ParallelOptions
                {
                    MaxDegreeOfParallelism = options.MaxConcurrency,
                    CancellationToken = token,
                },
                async (text, cancel) =>
                {
                    try
                    {
                        Stats?.Call();
                        prefetched[text] = await redactor
                            .DetectAsync(http, options, text, cancel)
                            .ConfigureAwait(false);
                    }
                    catch (TextRedactionException error) when (error.TooLarge) { }
                }
            )
            .ConfigureAwait(false);
    }

    // Detection only. Unchanged slot text reuses its cached spans without a detection call.
    internal async Task<string> DetectAsync(string text)
    {
        token.ThrowIfCancellationRequested();
        if (text.Length == 0)
            return text;
        var digest = TextRedactor.Digest(text);
        var cached = redactor.Cached(options, digest);
        Stats?.Slot(cached is not null);
        if (cached is { Masked: { } masked })
        {
            // Already through both passes: send it exactly as before.
            Register(cached.Value.Spans);
            Register(masked);
            Stats?.Count(cached.Value.Spans, literal: false);
            Stats?.Count(masked, literal: true);
            var result = TextRedactor.Apply(TextRedactor.Apply(text, cached.Value.Spans), masked);
            finished.TryAdd(result, (result, []));
            return result;
        }
        Found[] spans;
        if (cached is null)
        {
            try
            {
                if (prefetched.TryRemove(text, out var early))
                    spans = early;
                else
                {
                    Stats?.Call();
                    spans = await redactor
                        .DetectAsync(http, options, text, token)
                        .ConfigureAwait(false);
                }
            }
            catch (TextRedactionException error) when (error.TooLarge && OmitOversized)
            {
                Stats?.Omit();
                return OmittedText;
            }
            // Register before caching: a colliding result is never cached.
            Register(spans);
            redactor.Cache(options, digest, spans);
        }
        else
        {
            spans = cached.Value.Spans;
            Register(spans);
        }
        Stats?.Count(spans, literal: false);
        // New registrations may need a newer matcher for the literal pass.
        originals = null;
        var detected = TextRedactor.Apply(text, spans);
        if (!pending.TryGetValue(detected, out var digests))
            pending[detected] = digests = [];
        digests.Add(digest);
        return detected;
    }

    // Replaces exact occurrences of originals that earlier detections replaced, whatever the
    // detector reports for this text. A slot detected in this attempt is scanned once, and
    // its result is kept with the slot's cached detection; a slot that already has one is
    // returned unchanged even if more originals are known now.
    internal string MaskKnown(string text)
    {
        if (pending.Remove(text, out var digests))
        {
            var found = Scan(text);
            var result = TextRedactor.Apply(text, found);
            foreach (var digest in digests)
                redactor.Memoize(options, digest, found);
            finished[text] = (result, found);
            Stats?.Count(found, literal: true);
            return result;
        }
        if (finished.TryGetValue(text, out var known))
        {
            Stats?.Count(known.Literal, literal: true);
            return known.Result;
        }
        var scanned = Scan(text);
        Stats?.Count(scanned, literal: true);
        return TextRedactor.Apply(text, scanned);
    }

    private Found[] Scan(string text)
    {
        originals ??= redactor.KnownSnapshot();
        var found = redactor.FindKnown(originals, text, options.ExcludeLabels).ToArray();
        Register(found);
        return found;
    }

    internal async Task<string> RedactAsync(string text) =>
        MaskKnown(await DetectAsync(text).ConfigureAwait(false));

    internal string Restore(string text) => redactor.Restore(text, registered);

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
