using System.Text;

namespace Foxwarm.Tools;

internal static partial class FileToolCore
{
    private const int FullLimit = 1024 * 1024;
    private sealed class Collector
    {
        internal long Count;
        private MemoryStream? full = new();
        private readonly MemoryStream head = new();
        private byte[] tail = [];
        internal void Append(ReadOnlySpan<byte> bytes)
        {
            if (bytes.Length == 0) return;
            Count += bytes.Length;
            if (Count > FullLimit) { full?.Dispose(); full = null; } else full?.Write(bytes);
            if (head.Length < 5000) head.Write(bytes[..Math.Min(bytes.Length, 5000 - (int)head.Length)]);
            var keep = Math.Min(5000, bytes.Length); var old = Math.Min(tail.Length, 5000 - keep);
            var next = new byte[old + keep]; tail.AsSpan(tail.Length - old).CopyTo(next); bytes[^keep..].CopyTo(next.AsSpan(old)); tail = next;
        }
        internal byte[]? Full => full?.ToArray();
        internal byte[] Head => head.ToArray();
        internal byte[] Tail => tail;
    }
    private sealed class Scanner(long start, long? end, bool stopAfterEnd)
    {
        internal readonly Collector Selected = new();
        internal long Line = 1, Completed, SelectedCount;
        internal long? SelectedStart, SelectedEnd;
        internal bool CurrentContent, HasContent, PendingCr, Eof;
        internal string Ending = "empty", FileEnding = "empty";
        private bool Included => Line >= start && (!end.HasValue || Line <= end);
        private void Content(ReadOnlySpan<byte> bytes)
        {
            if (bytes.Length == 0) return;
            CurrentContent = true; FileEnding = "none"; if (Included) Selected.Append(bytes);
        }
        private bool Finish(string ending, ReadOnlySpan<byte> terminator)
        {
            if (Included)
            {
                Selected.Append(terminator); SelectedStart ??= Line; SelectedEnd = Line; SelectedCount++;
                HasContent |= CurrentContent; Ending = ending;
            }
            Completed++; var done = Line++; CurrentContent = false; FileEnding = ending;
            return stopAfterEnd && end == done;
        }
        internal (bool Stop, int Consumed) Consume(ReadOnlySpan<byte> bytes)
        {
            var index = 0;
            if (PendingCr)
            {
                PendingCr = false;
                if (bytes.Length > 0 && bytes[0] == 10) { if (Finish("crlf", [13, 10])) return (true, 1); index = 1; }
                else if (Finish("bare-cr", [13])) return (true, 0);
            }
            var contentStart = index;
            while (index < bytes.Length)
            {
                if (bytes[index] is not (10 or 13)) { index++; continue; }
                Content(bytes[contentStart..index]);
                if (bytes[index] == 10) { index++; if (Finish("lf", [10])) return (true, index); }
                else if (index + 1 < bytes.Length)
                {
                    if (bytes[index + 1] == 10) { index += 2; if (Finish("crlf", [13, 10])) return (true, index); }
                    else { index++; if (Finish("bare-cr", [13])) return (true, index); }
                }
                else { PendingCr = true; index++; }
                contentStart = index;
            }
            Content(bytes[contentStart..]); return (false, bytes.Length);
        }
        internal void FinishEof()
        {
            if (PendingCr) { PendingCr = false; Finish("bare-cr", [13]); }
            else if (CurrentContent) Finish("none", []);
            Eof = true;
        }
    }
    private static string Separator(string ending) => ending is "lf" or "crlf" or "bare-cr" ? "" : "\n";
    private static string LineCount(long count) => $"File has {count} {(count == 1 ? "line" : "lines")}.";
    private static string Requested(long start, long? end) => $"{start}-{(end.HasValue ? end.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : "end")}";
    private static string SelectedLabel(Scanner scan, long start, long? end)
    {
        var selected = scan.SelectedStart == scan.SelectedEnd ? $"Selected line {scan.SelectedStart}" : $"Selected lines {scan.SelectedStart}-{scan.SelectedEnd}";
        return selected + (scan.Eof ? $" of {scan.Completed}" : "") + (end.HasValue && scan.SelectedEnd < end ? $" (requested lines {start}-{end})" : "") + ".";
    }
}
