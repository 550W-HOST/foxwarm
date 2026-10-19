using System.Text.RegularExpressions;

namespace Foxwarm.Tools;

internal sealed record PatchOperation(string Action, string Path, string[] Lines);

/// <summary>Source patch parsing and matching, without filesystem effects or caller policy.</summary>
internal static class WorkspacePatch
{
    private const string FormatHint =
        "Use *** Begin Patch / *** End Patch with file action headers; prefix update lines with space/-/+ and add lines with +; use @@ between update sections.";
    private static readonly char[] Whitespace =
        "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff".ToCharArray();

    private static string Trim(string value) => value.Trim(Whitespace);

    private const int MaxContextErrorLength = 1600;
    private const int MaxContextErrorPathLength = 120;
    private const string FailedHunkOmission = "\n... (middle of failed hunk omitted) ...\n";
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
            text = Trim(text[begin..(end + "*** End Patch".Length)]);
        }
        else
        {
            text = Trim(text);
            if (text.Length == 0 || !IsHeader(text.Split('\n')[0]))
                throw new InvalidDataException(
                    text.Length == 0
                        ? "Invalid apply_patch input: missing *** Begin Patch / *** End Patch envelope.\n"
                            + FormatHint
                        : "Invalid apply_patch input: missing *** Begin Patch / *** End Patch envelope, or bare patch must start with *** Update File: / *** Add File: / *** Delete File:.\n"
                            + FormatHint
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
            while (cursor < lines.Length - 1 && Trim(lines[cursor]).Length == 0)
                cursor++;
            if (cursor >= lines.Length - 1)
                break;
            var headerLine = lines[cursor++];
            var header = Regex.Match(headerLine, @"^\*\*\* (Update|Add|Delete) File: (.+)$");
            if (!header.Success)
                throw new InvalidDataException(
                    $"Invalid apply_patch input: expected file action header (*** Update File: / *** Add File: / *** Delete File:), got: {headerLine}\n{FormatHint}"
                );
            var action = header.Groups[1].Value.ToLowerInvariant();
            var path = Trim(header.Groups[2].Value);
            var section = new List<string>();
            while (cursor < lines.Length - 1 && !IsHeader(lines[cursor]))
                section.Add(lines[cursor++]);
            if (action == "delete" && section.Any(line => Trim(line).Length != 0))
                throw new InvalidDataException(
                    $"Invalid apply_patch input for {path}: delete section should not contain body lines."
                );
            if (action == "add" && section.Any(line => !line.StartsWith('+')))
                throw new InvalidDataException(
                    $"Invalid apply_patch input for {path}: add file lines must start with '+'."
                );
            if (action == "update" && section.Count == 0)
                throw new InvalidDataException(
                    $"Invalid apply_patch input for {path}: update section must include patch lines."
                );
            if (
                action == "update"
                && !section.Any(line => line.StartsWith('+') || line.StartsWith('-'))
            )
                throw new InvalidDataException(
                    $"Invalid apply_patch input for {path}: update section must include at least one changed line."
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
        var lines = section.Append("*** End Patch").ToArray();
        var patches = new List<Chunk>();
        var cursor = 0;
        var index = 0;
        bool Done(string line) =>
            line.StartsWith("*** End Patch", StringComparison.Ordinal)
            || line.StartsWith("*** End of File", StringComparison.Ordinal);
        while (index < lines.Length && !Done(lines[index]))
        {
            var hunkStart = index;
            var anchor = lines[index].StartsWith("@@ ", StringComparison.Ordinal)
                ? lines[index++][3..]
                : "";
            var bare = anchor.Length == 0 && lines[index] == "@@";
            if (bare)
                index++;
            if (anchor.Length == 0 && !bare && cursor != 0)
                throw new InvalidDataException(
                    $"Invalid apply_patch input for {path}: expected '@@' before line: {lines[index]}"
                );
            if (Trim(anchor).Length > 0)
            {
                // A repeated anchor already behind the cursor is not permission to skip another hunk.
                for (var mode = 0; mode < 3; mode++)
                {
                    string Normalize(string line) =>
                        mode == 0 ? line
                        : mode == 1 ? Trim(line)
                        : NormalizeMatchLine(line);
                    var expected = Normalize(anchor);
                    if (input.Take(cursor).Any(line => Normalize(line) == expected))
                        continue;
                    var found = Array.FindIndex(input, cursor, line => Normalize(line) == expected);
                    if (found < 0)
                        continue;
                    cursor = found + 1;
                    break;
                }
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
                index < lines.Length
                && !Done(lines[index])
                && !lines[index].StartsWith("@@", StringComparison.Ordinal)
            )
            {
                var raw = lines[index];
                if (raw == "***")
                    break;
                if (raw.StartsWith("***", StringComparison.Ordinal))
                    throw new InvalidDataException(
                        $"Invalid apply_patch input for {path}: invalid line: {raw}\n{FormatHint}"
                    );
                index++;
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
                        $"Invalid apply_patch input for {path}: invalid line: {raw}\n{FormatHint}"
                    );
            }
            Flush();
            var eof = index < lines.Length && lines[index] == "*** End of File";
            if (eof)
                index++;
            else if (index == sectionStart)
                throw new InvalidDataException(
                    $"Invalid apply_patch input for {path}: empty update section near line {index + 1}."
                );
            var matched = FindContext(
                input,
                context,
                eof ? Math.Max(0, input.Length - context.Count) : cursor
            );
            if (matched < 0 && eof)
                matched = FindContext(input, context, cursor);
            if (matched < 0)
                throw new InvalidDataException(
                    FormatContextMismatch(lines[hunkStart..index], cursor, eof, path)
                );
            patches.AddRange(local.Select(chunk => chunk with { Index = chunk.Index + matched }));
            cursor = matched + context.Count;
        }
        var output = new List<string>();
        var sourceIndex = 0;
        foreach (var chunk in patches)
        {
            if (chunk.Index > input.Length)
                throw new InvalidDataException(
                    $"apply_patch failed for {path}: chunk starts past end of file ({chunk.Index} > {input.Length})."
                );
            if (sourceIndex > chunk.Index)
                throw new InvalidDataException(
                    $"apply_patch failed for {path}: overlapping chunk at {chunk.Index} (cursor {sourceIndex})."
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
                    : mode == 1 ? source[i + j].TrimEnd(Whitespace)
                    : Trim(source[i + j]);
                var right =
                    mode == 0 ? context[j]
                    : mode == 1 ? context[j].TrimEnd(Whitespace)
                    : Trim(context[j]);
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
        Trim(value)
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

    private static string FormatContextErrorPath(string path)
    {
        var shortened =
            path.Length <= MaxContextErrorPathLength ? path : path[..60] + "…" + path[^59..];
        return JsonStringQuoting.Quote(shortened);
    }

    private static string FormatBoundedFailedHunk(string[] patchLines, int maxLength)
    {
        var hunk = string.Join('\n', patchLines);
        if (hunk.Length <= maxLength)
            return hunk;
        var contentLength = Math.Max(0, maxLength - FailedHunkOmission.Length);
        if (contentLength == 0)
            return FailedHunkOmission[..Math.Min(maxLength, FailedHunkOmission.Length)];
        var headLength = (contentLength + 1) / 2;
        var tailLength = contentLength - headLength;
        return hunk[..headLength]
            + FailedHunkOmission
            + (tailLength > 0 ? hunk[^tailLength..] : "");
    }

    private static string FormatContextMismatch(
        string[] patchLines,
        int start,
        bool eof,
        string path
    )
    {
        var prefix =
            $"Could not match {(eof ? "EOF" : "patch")} context while patching {FormatContextErrorPath(path)} starting at line {start + 1}.\nFailed hunk:\n";
        var formatted =
            prefix
            + FormatBoundedFailedHunk(
                patchLines,
                Math.Max(0, MaxContextErrorLength - prefix.Length)
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
