using System.Runtime.InteropServices;
using System.Security.Cryptography;

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

    // Compaction replaces a slot the detection service rejects as too large instead of
    // failing, so a long message cannot prevent the Session from being compacted.
    internal bool OmitOversized { get; init; }

    internal IReadOnlyDictionary<string, string> Registered => registered;

    // Detection only. Unchanged slot text reuses its cached spans without a detection call.
    internal async Task<string> DetectAsync(string text)
    {
        token.ThrowIfCancellationRequested();
        if (text.Length == 0)
            return text;
        var digest = Convert.ToHexStringLower(
            SHA256.HashData(MemoryMarshal.AsBytes(text.AsSpan()))
        );
        var spans = redactor.Cached(options, digest);
        if (spans is null)
        {
            try
            {
                spans = await redactor
                    .DetectAsync(http, options, text, token)
                    .ConfigureAwait(false);
            }
            catch (TextRedactionException error) when (error.TooLarge && OmitOversized)
            {
                return OmittedText;
            }
            // Register before caching: a colliding result is never cached.
            Register(spans);
            redactor.Cache(options, digest, spans);
        }
        else
            Register(spans);
        return TextRedactor.Apply(text, spans);
    }

    // Replaces exact occurrences of originals that earlier detections replaced, whatever the
    // detector reports for this text.
    internal string MaskKnown(string text)
    {
        var found = redactor.FindKnown(text, options.ExcludeLabels);
        if (found.Count == 0)
            return text;
        Register(found);
        return TextRedactor.Apply(text, found);
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
