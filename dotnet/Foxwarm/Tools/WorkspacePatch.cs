using System.Text.RegularExpressions;

namespace Foxwarm.Tools;

internal sealed record PatchOperation(string Action, string Path, string[] Lines);

/// <summary>The supported UTF-8 subset of shared/src/applyPatch.ts, without any filesystem effect.</summary>
internal static class WorkspacePatch
{
    private static readonly string[] Headers = ["*** Update File: ", "*** Add File: ", "*** Delete File: "];
    private static bool IsHeader(string line) => Headers.Any(line.StartsWith);

    internal static PatchOperation[] Parse(string input)
    {
        var text = input.Replace("\r\n", "\n");
        var begin = text.IndexOf("*** Begin Patch", StringComparison.Ordinal);
        var end = text.LastIndexOf("*** End Patch", StringComparison.Ordinal);
        if (begin >= 0 || end >= 0)
        {
            if (begin < 0 || end < begin) throw new InvalidDataException("Invalid apply_patch input: malformed patch envelope.");
            text = text[begin..(end + "*** End Patch".Length)].Trim();
        }
        else
        {
            text = text.Trim();
            if (text.Length == 0 || !IsHeader(text.Split('\n')[0]))
                throw new InvalidDataException("Invalid apply_patch input: missing *** Begin Patch / *** End Patch envelope.");
            text = "*** Begin Patch\n" + text + "\n*** End Patch";
        }
        var lines = text.Split('\n');
        if (lines[0] != "*** Begin Patch" || lines[^1] != "*** End Patch")
            throw new InvalidDataException("Invalid apply_patch input: malformed patch envelope.");
        var result = new List<PatchOperation>();
        var cursor = 1;
        while (cursor < lines.Length - 1)
        {
            while (cursor < lines.Length - 1 && string.IsNullOrWhiteSpace(lines[cursor])) cursor++;
            if (cursor >= lines.Length - 1) break;
            var header = Regex.Match(lines[cursor++], @"^\*\*\* (Update|Add|Delete) File: (.+)$");
            if (!header.Success) throw new InvalidDataException("Invalid apply_patch input: expected file action header.");
            var action = header.Groups[1].Value.ToLowerInvariant();
            var path = header.Groups[2].Value.Trim();
            var section = new List<string>();
            while (cursor < lines.Length - 1 && !IsHeader(lines[cursor])) section.Add(lines[cursor++]);
            if (action == "delete" && section.Any(line => !string.IsNullOrWhiteSpace(line)))
                throw new InvalidDataException($"Invalid apply_patch input for {path}: delete section should not contain body lines.");
            if (action == "add" && section.Any(line => !line.StartsWith('+')))
                throw new InvalidDataException($"Invalid apply_patch input for {path}: add file lines must start with '+'.");
            if (action == "update" && (section.Count == 0 || !section.Any(line => line.StartsWith('+') || line.StartsWith('-'))))
                throw new InvalidDataException($"Invalid apply_patch input for {path}: update section must include changed lines.");
            result.Add(new PatchOperation(action, path,
                action == "add" ? section.Select(line => line[1..]).ToArray() : section.ToArray()));
        }
        if (result.Count == 0) throw new InvalidDataException("Invalid apply_patch input: patch contains no file operations.");
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
            if (section[index].StartsWith("@@ ", StringComparison.Ordinal)) anchor = section[index++][3..];
            else if (section[index] == "@@") index++;
            else if (cursor != 0) throw new InvalidDataException($"Invalid apply_patch input for {path}: expected '@@' before line: {section[index]}");
            if (!string.IsNullOrWhiteSpace(anchor))
            {
                var exact = Array.FindIndex(input, cursor, line => line == anchor);
                if (exact < 0) exact = Array.FindIndex(input, cursor, line => line.Trim() == anchor.Trim());
                if (exact >= 0) cursor = exact + 1;
            }
            var context = new List<string>();
            var local = new List<Chunk>();
            var removed = new List<string>();
            var added = new List<string>();
            void Flush()
            {
                if (removed.Count == 0 && added.Count == 0) return;
                local.Add(new Chunk(context.Count - removed.Count, removed.ToArray(), added.ToArray()));
                removed.Clear(); added.Clear();
            }
            var sectionStart = index;
            var previousWasChange = false;
            while (index < section.Length && section[index] != "*** End of File" && !section[index].StartsWith("@@", StringComparison.Ordinal))
            {
                var raw = section[index++];
                if (raw.Length == 0) raw = " ";
                if (raw[0] == ' ')
                {
                    if (previousWasChange) Flush();
                    context.Add(raw[1..]); previousWasChange = false;
                }
                else if (raw[0] == '-') { removed.Add(raw[1..]); context.Add(raw[1..]); previousWasChange = true; }
                else if (raw[0] == '+') { added.Add(raw[1..]); previousWasChange = true; }
                else throw new InvalidDataException($"Invalid apply_patch input for {path}: invalid line: {raw}");
            }
            Flush();
            if (index == sectionStart) throw new InvalidDataException($"Invalid apply_patch input for {path}: empty update section.");
            var eof = index < section.Length && section[index] == "*** End of File";
            var matched = FindContext(input, context, eof ? Math.Max(cursor, input.Length - context.Count) : cursor);
            if (matched < 0 && eof) matched = FindContext(input, context, cursor);
            if (matched < 0) throw new InvalidDataException($"Could not match patch context while patching {path} starting at line {cursor + 1}:\n{string.Join('\n', context)}");
            patches.AddRange(local.Select(chunk => chunk with { Index = chunk.Index + matched }));
            cursor = matched + context.Count;
            if (eof) { index++; break; }
        }
        if (index != section.Length) throw new InvalidDataException($"Invalid apply_patch input for {path}: unexpected update section tail.");
        var output = new List<string>();
        var sourceIndex = 0;
        foreach (var chunk in patches)
        {
            if (chunk.Index > input.Length || chunk.Index < sourceIndex)
                throw new InvalidDataException($"apply_patch failed for {path}: overlapping or out-of-range chunk.");
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
        if (context.Count == 0) return start;
        for (var mode = 0; mode < 3; mode++)
            for (var i = start; i + context.Count <= source.Length; i++)
            {
                var match = true;
                for (var j = 0; j < context.Count; j++)
                {
                    var left = mode == 0 ? source[i + j] : mode == 1 ? source[i + j].TrimEnd() : source[i + j].Trim();
                    var right = mode == 0 ? context[j] : mode == 1 ? context[j].TrimEnd() : context[j].Trim();
                    if (left == right) continue;
                    match = false; break;
                }
                if (match) return i;
            }
        return -1;
    }

    internal static string Summary(PatchOperation operation) => operation.Action switch
    {
        "add" => $"Added {operation.Path} (+{operation.Lines.Length})",
        "delete" => $"Deleted {operation.Path}",
        _ => $"Updated {operation.Path} (+{operation.Lines.Count(line => line.StartsWith('+'))} -{operation.Lines.Count(line => line.StartsWith('-'))} lines)"
    };
}
