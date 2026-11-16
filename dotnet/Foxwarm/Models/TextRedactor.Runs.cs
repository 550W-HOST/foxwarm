using System.Text;
using System.Text.RegularExpressions;

namespace Foxwarm.Models;

internal sealed partial class TextRedactor
{
    // Native text blocks form one semantic run. A substitution belongs to the block in
    // which it begins; later blocks lose only the consumed characters, not their metadata.
    private readonly record struct RunEdit(int Start, int Length, string Replacement);

    internal string[] RestoreRun(string[] texts, IReadOnlyDictionary<string, string> registered)
    {
        var joined = string.Concat(texts);
        var edits = placeholder
            .Matches(joined)
            .Cast<Match>()
            .Where(match => registered.ContainsKey(match.Value))
            .Select(match => new RunEdit(match.Index, match.Length, registered[match.Value]))
            .ToArray();
        return EditRun(texts, edits);
    }

    // Detection and literal masking only insert registered placeholders. Recover those
    // substitutions' original offsets from the accepted form, including cached winners,
    // so a native block boundary cannot split the value being protected.
    internal string[] RedactRun(
        string[] texts,
        string form,
        IReadOnlyDictionary<string, string> registered
    )
    {
        var joined = string.Concat(texts);
        if (joined == form)
            return texts;
        var edits = new List<RunEdit>();
        var source = 0;
        var target = 0;
        foreach (Match match in placeholder.Matches(form))
        {
            var unchanged = match.Index - target;
            if (
                !joined
                    .AsSpan(source)
                    .StartsWith(form.AsSpan(target, unchanged), StringComparison.Ordinal)
            )
                throw new InvalidOperationException(
                    "Text redaction run does not match its accepted form."
                );
            source += unchanged;
            if (joined.AsSpan(source).StartsWith(match.Value, StringComparison.Ordinal))
                source += match.Length; // A literal input token stays opaque.
            else if (
                registered.TryGetValue(match.Value, out var original)
                && joined.AsSpan(source).StartsWith(original, StringComparison.Ordinal)
            )
            {
                edits.Add(new(source, original.Length, match.Value));
                source += original.Length;
            }
            else
                throw new InvalidOperationException(
                    "Text redaction run has an unregistered substitution."
                );
            target = match.Index + match.Length;
        }
        if (!joined.AsSpan(source).SequenceEqual(form.AsSpan(target)))
            throw new InvalidOperationException(
                "Text redaction run does not match its accepted form."
            );
        return EditRun(texts, edits);
    }

    private static string[] EditRun(string[] texts, IReadOnlyList<RunEdit> edits)
    {
        if (edits.Count == 0)
            return texts;
        var joined = string.Concat(texts);
        var result = new string[texts.Length];
        var offset = 0;
        var first = 0;
        for (var index = 0; index < texts.Length; index++)
        {
            var end = offset + texts[index].Length;
            var cursor = offset;
            var output = new StringBuilder();
            while (first < edits.Count && edits[first].Start + edits[first].Length <= offset)
                first++;
            for (var next = first; next < edits.Count && edits[next].Start < end; next++)
            {
                var edit = edits[next];
                if (edit.Start >= offset)
                {
                    output.Append(joined, cursor, edit.Start - cursor);
                    output.Append(edit.Replacement);
                }
                cursor = Math.Min(end, edit.Start + edit.Length);
            }
            output.Append(joined, cursor, end - cursor);
            result[index] = output.ToString();
            offset = end;
        }
        return result;
    }
}
