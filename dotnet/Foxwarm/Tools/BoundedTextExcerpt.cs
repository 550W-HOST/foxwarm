using System.Text;

namespace Foxwarm.Tools;

internal static class BoundedTextExcerpt
{
    private static (string Text, int Suspicious, int Escaped) Analyze(byte[] bytes, bool leading, bool trailing)
    {
        var escape = new bool[bytes.Length]; var suspicious = 0; var index = 0;
        void Mark(int start, int length, bool bad, bool convert)
        {
            if (bad) suspicious += length;
            if (convert) for (var offset = start; offset < start + length; offset++) escape[offset] = true;
        }
        static bool Continuation(byte value) => value is >= 0x80 and <= 0xbf;
        while (leading && index < Math.Min(3, bytes.Length) && Continuation(bytes[index])) { Mark(index, 1, false, true); index++; }
        while (index < bytes.Length)
        {
            var value = bytes[index];
            if (value <= 0x7f)
            {
                if (value < 0x20 && value is not (9 or 10 or 13) || value == 0x7f) Mark(index, 1, true, false);
                index++; continue;
            }
            var width = value is >= 0xc2 and <= 0xdf ? 2 : value is >= 0xe0 and <= 0xef ? 3 : value is >= 0xf0 and <= 0xf4 ? 4 : 0;
            if (width == 0) { Mark(index++, 1, true, true); continue; }
            if (index + width > bytes.Length) { Mark(index, bytes.Length - index, !trailing, true); break; }
            var point = value & (width == 2 ? 0x1f : width == 3 ? 0x0f : 0x07); var valid = true;
            for (var offset = 1; offset < width; offset++)
            {
                if (!Continuation(bytes[index + offset])) { valid = false; break; }
                point = (point << 6) | (bytes[index + offset] & 0x3f);
            }
            var minimum = width == 2 ? 0x80 : width == 3 ? 0x800 : 0x10000;
            if (!valid || point < minimum || point > 0x10ffff || point is >= 0xd800 and <= 0xdfff) { Mark(index++, 1, true, true); continue; }
            if (point is >= 0x80 and <= 0x9f) Mark(index, width, true, false);
            index += width;
        }
        var text = new StringBuilder(); var segment = 0; var escaped = 0;
        for (index = 0; index < bytes.Length; index++)
        {
            if (!escape[index]) continue;
            if (index > segment) text.Append(Encoding.UTF8.GetString(bytes, segment, index - segment));
            text.Append($"\\x{bytes[index]:x2}"); escaped++; segment = index + 1;
        }
        if (segment < bytes.Length) text.Append(Encoding.UTF8.GetString(bytes, segment, bytes.Length - segment));
        return (text.ToString(), suspicious, escaped);
    }
    internal static string Format(byte[] head, byte[] tail, long selectedBytes, long fileBytes, string displayPath, string label, IReadOnlyList<string>? metadata = null, string separator = "\n")
    {
        var first = Analyze(head, false, true); var last = Analyze(tail, true, false);
        var binary = first.Suspicious + last.Suspicious > (head.Length + tail.Length) * 0.1;
        var escaped = first.Escaped + last.Escaped;
        var body = binary
            ? $"[foxwarm: {label} appears binary; showing hexadecimal previews from a {selectedBytes}-byte {(label == "selected file range" ? "selected range" : "file")}]\nHead ({Math.Min(head.Length, 64)} bytes): {Convert.ToHexStringLower(head.AsSpan(0, Math.Min(head.Length, 64)))}\nTail ({Math.Min(tail.Length, 64)} bytes): {Convert.ToHexStringLower(tail.AsSpan(0, Math.Min(tail.Length, 64)))}\n[foxwarm: raw binary content omitted; source file remains unchanged]"
            : first.Text + $"\n[foxwarm: {label} middle omitted; showing bounded head and tail samples from {selectedBytes}-byte selected content{(escaped > 0 ? $"; escaped {escaped} byte(s)" : "")}]\n" + last.Text;
        var lines = new List<string> { "File content was shortened for inline display." };
        if (metadata is not null) lines.AddRange(metadata);
        lines.Add($"File size: {fileBytes} bytes."); lines.Add($"Complete content remains in source file: {displayPath}.");
        if (!binary && escaped > 0) lines.Add("Foxwarm \\xNN placeholders above are display conversions, not literal file content.");
        return body + (binary ? "\n" : separator) + "---\n" + string.Join('\n', lines);
    }
}
