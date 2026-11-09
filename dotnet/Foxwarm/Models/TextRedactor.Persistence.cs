namespace Foxwarm.Models;

// Restart persistence. Each finished slot result (detected and literal ranges) and each known
// original is written to the store in the background, and a later process reads them back,
// so history sent before a restart is sent byte-identically after it without detection and
// new slots are literal-masked with the same known set. A store hit is rebuilt from the slot
// text: originals are its substrings and placeholders are recomputed with the HMAC key. A
// record that does not fit the text is a miss and is removed.
internal sealed partial class TextRedactor
{
    private readonly TextRedactionStore? store;

    // Known originals of an earlier process, least recently used first, without writing them
    // again. Values beyond the memory bound are evicted as usual.
    private void LoadKnown()
    {
        if (store is null)
            return;
        foreach (var (original, labels) in store.ReadKnown())
        {
            if (labels.Length == 0 || labels.Any(string.IsNullOrEmpty))
                continue;
            string mapped;
            try
            {
                mapped = Placeholder(Utf8.GetBytes(original));
            }
            catch (System.Text.EncoderFallbackException)
            {
                continue;
            }
            lock (gate)
            {
                if (known.ContainsKey(mapped))
                    continue;
                var entry = new Known(mapped, original, labels);
                var node = knownOrder.AddLast(entry);
                known[mapped] = node;
                knownBytes += entry.Size;
                knownGeneration++;
                while (knownBytes > knownLimit && knownOrder.First is { } oldest && oldest != node)
                    Forget(oldest);
            }
        }
    }

    // A slot's finished result from the store, rebuilt for this text.
    private (Found[] Spans, Found[]? Masked)? Stored(
        TextRedactionOptions options,
        string text,
        string digest
    )
    {
        if (store?.ReadSlot(options, digest) is not { } ranges)
            return null;
        if (Rebuild(text, ranges) is { } rebuilt)
            return rebuilt;
        store.DeleteSlot(options, digest);
        return null;
    }

    // Caches a stored result as a finished entry without writing it again.
    private void Admit(TextRedactionOptions options, string digest, Found[] spans, Found[]? masked)
    {
        Cache(options, digest, spans);
        lock (gate)
        {
            if (
                !detections.TryGetValue(new(options, digest), out var node)
                || node.Value.Masked is not null
            )
                return;
            var entry = node.Value with { Masked = masked, Touched = store?.Today ?? 0 };
            cacheBytes += entry.Size - node.Value.Size;
            node.Value = entry;
            while (cacheBytes > cacheLimit && detectionOrder.First is { } oldest)
            {
                detectionOrder.RemoveFirst();
                detections.Remove(oldest.Value.Key);
                cacheBytes -= oldest.Value.Size;
            }
        }
    }

    // Detected ranges must lie in the slot text and literal ranges in its detected form, in
    // order, without overlap, on character boundaries and outside the detected placeholders.
    private (Found[] Spans, Found[] Masked)? Rebuild(string text, TextRedactionStore.Range[] ranges)
    {
        var detected = new List<Found>();
        var literal = new List<Found>();
        try
        {
            var cursor = 0;
            foreach (var range in ranges.Where(range => !range.Literal))
            {
                if (!Fits(text, range, cursor))
                    return null;
                detected.Add(Rebuilt(text, range));
                cursor = range.Start + range.Length;
            }
            var form = Apply(text, detected);
            var guarded = new List<(int Start, int End)>();
            var shift = 0;
            foreach (var span in detected)
            {
                guarded.Add((span.Start + shift, span.Start + shift + span.Placeholder.Length));
                shift += span.Placeholder.Length - span.Length;
            }
            cursor = 0;
            foreach (var range in ranges.Where(range => range.Literal))
            {
                if (
                    !Fits(form, range, cursor)
                    || guarded.Any(item =>
                        item.Start < range.Start + range.Length && range.Start < item.End
                    )
                )
                    return null;
                literal.Add(Rebuilt(form, range));
                cursor = range.Start + range.Length;
            }
        }
        catch (System.Text.EncoderFallbackException)
        {
            return null;
        }
        return (detected.ToArray(), literal.ToArray());
    }

    private static bool Fits(string text, TextRedactionStore.Range range, int cursor) =>
        range.Start >= cursor
        && range.Length > 0
        && (long)range.Start + range.Length <= text.Length
        && Boundary(text, range.Start)
        && Boundary(text, range.Start + range.Length)
        && range.Labels.Length > 0
        && range.Labels.All(label => label.Length > 0);

    // Not between the halves of a surrogate pair.
    private static bool Boundary(string text, int index) =>
        index == 0
        || index == text.Length
        || !(char.IsLowSurrogate(text[index]) && char.IsHighSurrogate(text[index - 1]));

    private Found Rebuilt(string text, TextRedactionStore.Range range)
    {
        var original = text.Substring(range.Start, range.Length);
        return new(
            range.Start,
            range.Length,
            Placeholder(Utf8.GetBytes(original)),
            original,
            range.Labels
        );
    }

    // Writes pending records and closes the store.
    public void Dispose() => store?.Dispose();
}
