using System.Text.RegularExpressions;

namespace Foxwarm.Tools;

internal sealed record PatchOperation(string Action, string Path, string[] Lines);

/// <summary>The supported UTF-8 subset of shared/src/applyPatch.ts, without any filesystem effect.</summary>
internal static class WorkspacePatch
{
    private const int MaxContextErrorLength = 1600;
    private const int MaxContextErrorLineLength = 240;
    private const int MaxDiagnosticSnippetLength = 160;
    private static readonly string[] Headers =
    [
        "*** Update File: ",
        "*** Add File: ",
        "*** Delete File: ",
    ];

    private static bool IsHeader(string line) => Headers.Any(line.StartsWith);

    internal static PatchOperation[] Parse(string input)
    {
        var text = input.Replace("\r\n", "\n");
        var begin = text.IndexOf("*** Begin Patch", StringComparison.Ordinal);
        var end = text.LastIndexOf("*** End Patch", StringComparison.Ordinal);
        if (begin >= 0 || end >= 0)
        {
            if (begin < 0 || end < begin)
                throw new InvalidDataException(
                    "Invalid apply_patch input: malformed patch envelope."
                );
            text = text[begin..(end + "*** End Patch".Length)].Trim();
        }
        else
        {
            text = text.Trim();
            if (text.Length == 0 || !IsHeader(text.Split('\n')[0]))
                throw new InvalidDataException(
                    "Invalid apply_patch input: missing *** Begin Patch / *** End Patch envelope."
                );
            text = "*** Begin Patch\n" + text + "\n*** End Patch";
        }
        var lines = text.Split('\n');
        if (lines[0] != "*** Begin Patch" || lines[^1] != "*** End Patch")
            throw new InvalidDataException("Invalid apply_patch input: malformed patch envelope.");
        var result = new List<PatchOperation>();
        var cursor = 1;
        while (cursor < lines.Length - 1)
        {
            while (cursor < lines.Length - 1 && string.IsNullOrWhiteSpace(lines[cursor]))
                cursor++;
            if (cursor >= lines.Length - 1)
                break;
            var header = Regex.Match(lines[cursor++], @"^\*\*\* (Update|Add|Delete) File: (.+)$");
            if (!header.Success)
                throw new InvalidDataException(
                    "Invalid apply_patch input: expected file action header."
                );
            var action = header.Groups[1].Value.ToLowerInvariant();
            var path = header.Groups[2].Value.Trim();
            var section = new List<string>();
            while (cursor < lines.Length - 1 && !IsHeader(lines[cursor]))
                section.Add(lines[cursor++]);
            if (action == "delete" && section.Any(line => !string.IsNullOrWhiteSpace(line)))
                throw new InvalidDataException(
                    $"Invalid apply_patch input for {path}: delete section should not contain body lines."
                );
            if (action == "add" && section.Any(line => !line.StartsWith('+')))
                throw new InvalidDataException(
                    $"Invalid apply_patch input for {path}: add file lines must start with '+'."
                );
            if (
                action == "update"
                && (
                    section.Count == 0
                    || !section.Any(line => line.StartsWith('+') || line.StartsWith('-'))
                )
            )
                throw new InvalidDataException(
                    $"Invalid apply_patch input for {path}: update section must include changed lines."
                );
            result.Add(
                new PatchOperation(
                    action,
                    path,
                    action == "add"
                        ? section.Select(line => line[1..]).ToArray()
                        : section.ToArray()
                )
            );
        }
        if (result.Count == 0)
            throw new InvalidDataException(
                "Invalid apply_patch input: patch contains no file operations."
            );
        return result.ToArray();
    }

    private sealed record Chunk(int Index, string[] Removed, string[] Added);

    internal static string Update(string source, string[] section, string path)
    {
        var crlf = source.Contains("\r\n", StringComparison.Ordinal);
        var input = source.Replace("\r\n", "\n").Split('\n');
        var patches = new List<Chunk>();
        var cursor = 0;
        var index = 0;
        while (index < section.Length && section[index] != "*** End of File")
        {
            string? anchor = null;
            if (section[index].StartsWith("@@ ", StringComparison.Ordinal))
                anchor = section[index++][3..];
            else if (section[index] == "@@")
                index++;
            else if (cursor != 0)
                throw new InvalidDataException(
                    $"Invalid apply_patch input for {path}: expected '@@' before line: {section[index]}"
                );
            if (!string.IsNullOrWhiteSpace(anchor))
            {
                var exact = Array.FindIndex(input, cursor, line => line == anchor);
                if (exact < 0)
                    exact = Array.FindIndex(input, cursor, line => line.Trim() == anchor.Trim());
                if (exact < 0)
                    exact = Array.FindIndex(
                        input,
                        cursor,
                        line => NormalizeMatchLine(line) == NormalizeMatchLine(anchor)
                    );
                if (exact >= 0)
                    cursor = exact + 1;
            }
            var context = new List<string>();
            var local = new List<Chunk>();
            var removed = new List<string>();
            var added = new List<string>();
            void Flush()
            {
                if (removed.Count == 0 && added.Count == 0)
                    return;
                local.Add(
                    new Chunk(context.Count - removed.Count, removed.ToArray(), added.ToArray())
                );
                removed.Clear();
                added.Clear();
            }
            var sectionStart = index;
            var previousWasChange = false;
            while (
                index < section.Length
                && section[index] != "*** End of File"
                && !section[index].StartsWith("@@", StringComparison.Ordinal)
            )
            {
                var raw = section[index++];
                if (raw.Length == 0)
                    raw = " ";
                if (raw[0] == ' ')
                {
                    if (previousWasChange)
                        Flush();
                    context.Add(raw[1..]);
                    previousWasChange = false;
                }
                else if (raw[0] == '-')
                {
                    removed.Add(raw[1..]);
                    context.Add(raw[1..]);
                    previousWasChange = true;
                }
                else if (raw[0] == '+')
                {
                    added.Add(raw[1..]);
                    previousWasChange = true;
                }
                else
                    throw new InvalidDataException(
                        $"Invalid apply_patch input for {path}: invalid line: {raw}"
                    );
            }
            Flush();
            if (index == sectionStart)
                throw new InvalidDataException(
                    $"Invalid apply_patch input for {path}: empty update section."
                );
            var eof = index < section.Length && section[index] == "*** End of File";
            var matched = FindContext(
                input,
                context,
                eof ? Math.Max(cursor, input.Length - context.Count) : cursor
            );
            if (matched < 0 && eof)
                matched = FindContext(input, context, cursor);
            if (matched < 0)
                throw new InvalidDataException(
                    FormatContextMismatch(input, context, cursor, eof, path)
                );
            patches.AddRange(local.Select(chunk => chunk with { Index = chunk.Index + matched }));
            cursor = matched + context.Count;
            if (eof)
            {
                index++;
                break;
            }
        }
        if (index != section.Length)
            throw new InvalidDataException(
                $"Invalid apply_patch input for {path}: unexpected update section tail."
            );
        var output = new List<string>();
        var sourceIndex = 0;
        foreach (var chunk in patches)
        {
            if (chunk.Index > input.Length || chunk.Index < sourceIndex)
                throw new InvalidDataException(
                    $"apply_patch failed for {path}: overlapping or out-of-range chunk."
                );
            output.AddRange(input[sourceIndex..chunk.Index]);
            output.AddRange(chunk.Added);
            sourceIndex = chunk.Index + chunk.Removed.Length;
        }
        output.AddRange(input[sourceIndex..]);
        var result = string.Join('\n', output);
        return crlf ? result.Replace("\n", "\r\n") : result;
    }

    private static int FindContext(string[] source, List<string> context, int start)
    {
        if (context.Count == 0)
            return start;
        for (var mode = 0; mode < 3; mode++)
        for (var i = start; i + context.Count <= source.Length; i++)
        {
            var match = true;
            for (var j = 0; j < context.Count; j++)
            {
                var left =
                    mode == 0 ? source[i + j]
                    : mode == 1 ? source[i + j].TrimEnd()
                    : source[i + j].Trim();
                var right =
                    mode == 0 ? context[j]
                    : mode == 1 ? context[j].TrimEnd()
                    : context[j].Trim();
                if (left == right)
                    continue;
                match = false;
                break;
            }
            if (match)
                return i;
        }
        for (var i = start; i + context.Count <= source.Length; i++)
        {
            if (
                context
                    .Select(
                        (line, index) =>
                            NormalizeMatchLine(line) == NormalizeMatchLine(source[i + index])
                    )
                    .All(match => match)
            )
                return i;
        }
        return -1;
    }

    private static string NormalizeMatchLine(string value) =>
        value
            .Trim()
            .Replace('\u2010', '-')
            .Replace('\u2011', '-')
            .Replace('\u2012', '-')
            .Replace('\u2013', '-')
            .Replace('\u2014', '-')
            .Replace('\u2015', '-')
            .Replace('\u2212', '-')
            .Replace('\u2018', '\'')
            .Replace('\u2019', '\'')
            .Replace('\u201A', '\'')
            .Replace('\u201B', '\'')
            .Replace('\u201C', '"')
            .Replace('\u201D', '"')
            .Replace('\u201E', '"')
            .Replace('\u201F', '"')
            .Replace('\u00A0', ' ')
            .Replace('\u2002', ' ')
            .Replace('\u2003', ' ')
            .Replace('\u2004', ' ')
            .Replace('\u2005', ' ')
            .Replace('\u2006', ' ')
            .Replace('\u2007', ' ')
            .Replace('\u2008', ' ')
            .Replace('\u2009', ' ')
            .Replace('\u200A', ' ')
            .Replace('\u202F', ' ')
            .Replace('\u205F', ' ')
            .Replace('\u3000', ' ');

    private static string FormatContextMismatch(
        string[] lines,
        List<string> context,
        int start,
        bool eof,
        string path
    )
    {
        static string Snippet(string value)
        {
            var trimmed = value.Trim();
            if (trimmed.Length <= MaxDiagnosticSnippetLength)
                return System.Text.Json.JsonSerializer.Serialize(trimmed);
            return System.Text.Json.JsonSerializer.Serialize(
                trimmed[..(MaxDiagnosticSnippetLength - 1)] + "…"
            );
        }
        var details = new List<string>
        {
            $"Could not match {(eof ? "EOF" : "patch")} context while patching {Snippet(path)} starting at line {start + 1}.",
            $"Expected context: {context.Count} lines, {context.Sum(line => line.Length) + Math.Max(0, context.Count - 1)} characters; file: {lines.Length} lines.",
        };
        var candidate = -1;
        var first = context.FindIndex(line => NormalizeMatchLine(line).Length > 0);
        if (first >= 0)
        {
            var expected = NormalizeMatchLine(context[first]);
            for (var i = start + first; i < lines.Length; i++)
                if (NormalizeMatchLine(lines[i]) == expected)
                {
                    if (candidate >= 0)
                    {
                        candidate = -1;
                        break;
                    }
                    candidate = i - first;
                }
        }
        if (candidate >= 0)
        {
            var mismatch = 0;
            while (
                mismatch < context.Count
                && candidate + mismatch < lines.Length
                && NormalizeMatchLine(context[mismatch])
                    == NormalizeMatchLine(lines[candidate + mismatch])
            )
                mismatch++;
            details.Add(
                $"Candidate starts at file line {candidate + 1}; first mismatch at file line {candidate + mismatch + 1} (context line {mismatch + 1})."
            );
            details.Add($"Expected: {Snippet(context[mismatch])}");
            details.Add(
                $"Actual: {(candidate + mismatch < lines.Length ? Snippet(lines[candidate + mismatch]) : "<end of file>")}"
            );
        }
        else
        {
            details.Add("No unique candidate location; limited preview:");
            foreach (var line in context.Take(3))
                details.Add($"Expected: {Snippet(line)}");
            foreach (var line in lines.Skip(Math.Max(0, start)).Take(3))
                details.Add($"Actual: {Snippet(line)}");
        }
        var formatted = string.Join(
            '\n',
            details.Select(line =>
                line.Length > MaxContextErrorLineLength
                    ? line[..(MaxContextErrorLineLength - 1)] + "…"
                    : line
            )
        );
        return formatted[..Math.Min(MaxContextErrorLength, formatted.Length)];
    }

    internal static string Summary(PatchOperation operation) =>
        operation.Action switch
        {
            "add" => $"Added {operation.Path} (+{operation.Lines.Length})",
            "delete" => $"Deleted {operation.Path}",
            _ =>
                $"Updated {operation.Path} (+{operation.Lines.Count(line => line.StartsWith('+'))} -{operation.Lines.Count(line => line.StartsWith('-'))} lines)",
        };
}
