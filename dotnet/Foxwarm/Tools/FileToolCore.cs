using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Foxwarm.Tools;

internal static partial class FileToolCore
{
    private static long? Bound(double? value) =>
        value is null || !double.IsFinite(value.Value) || value == 0 ? null
        : value >= long.MaxValue ? long.MaxValue
        : value <= long.MinValue ? long.MinValue
        : (long)Math.Floor(value.Value);

    internal static async Task<string> Read(
        string path,
        string display,
        double? startLine,
        double? endLine,
        CancellationToken cancellationToken,
        Action<System.Text.Json.Nodes.JsonObject>? data = null
    )
    {
        if (Directory.Exists(path))
        {
            var entries = new DirectoryInfo(path)
                .EnumerateFileSystemInfos()
                .OrderBy(
                    entry => entry.Name,
                    StringComparer.Create(CultureInfo.GetCultureInfo("en-US"), false)
                )
                .ToArray();
            return FormatDirectory(
                display,
                startLine,
                endLine,
                entries
                    .Select(entry => new TargetFileStat(
                        entry.LinkTarget is not null ? "symlink"
                            : entry is DirectoryInfo ? "directory"
                            : "file",
                        entry.LinkTarget is null && entry is FileInfo file ? file.Length : 0,
                        new DateTimeOffset(entry.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                        entry.Name
                    ))
                    .ToArray()
            );
        }
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite,
            65536,
            FileOptions.Asynchronous
        );
        var sizeBytes = stream.Length;
        return await ReadContent(path, display, sizeBytes, startLine, endLine, ReadAt, data);

        async Task<byte[]> ReadAt(long offset, int count)
        {
            stream.Position = offset;
            var bytes = new byte[count];
            var total = 0;
            while (total < count)
            {
                var read = await stream.ReadAsync(bytes.AsMemory(total), cancellationToken);
                if (read == 0)
                    break;
                total += read;
            }
            return bytes[..total];
        }
    }

    internal static async Task<string> ReadContent(
        string path,
        string display,
        long sizeBytes,
        double? startLine,
        double? endLine,
        Func<long, int, Task<byte[]>> ReadAt,
        Action<System.Text.Json.Nodes.JsonObject>? data = null
    )
    {
        var start = Math.Max(1, Bound(startLine) ?? 1);
        var end = Bound(endLine) is long value ? Math.Max(0, value) : (long?)null;
        var ranged = Bound(startLine).HasValue || Bound(endLine).HasValue;
        void Publish(byte[]? content, long selectedBytes, Scanner? scan = null)
        {
            if (data is null)
                return;
            var value = new System.Text.Json.Nodes.JsonObject
            {
                ["truncated"] = content is null,
                ["filePath"] = path,
                ["sizeBytes"] = sizeBytes,
                ["selectedBytes"] = selectedBytes,
            };
            if (content is not null)
                value["content"] = Encoding.UTF8.GetString(content);
            if (scan?.SelectedStart is long from)
            {
                value["startLine"] = from;
                value["endLine"] = scan.SelectedEnd;
            }
            if (scan?.Eof == true)
                value["totalLines"] = scan.Completed;
            data(value);
        }
        if (sizeBytes > FullLimit && !ranged)
        {
            Publish(null, sizeBytes);
            return BoundedTextExcerpt.Format(
                await ReadAt(0, 5000),
                await ReadAt(Math.Max(0, sizeBytes - 5000), 5000),
                sizeBytes,
                sizeBytes,
                display,
                "file content"
            );
        }
        if (sizeBytes > FullLimit && end < start)
        {
            Publish([], 0);
            return $"(no content in requested line range {Requested(start, end)})\n---\nFile size: {sizeBytes} bytes.";
        }
        var scanner = new Scanner(start, end, sizeBytes > FullLimit);
        byte[]? full = null;
        if (sizeBytes <= FullLimit)
        {
            full = await ReadAt(0, (int)sizeBytes);
            scanner.Consume(full);
            scanner.FinishEof();
        }
        else
        {
            var offset = 0L;
            while (offset < sizeBytes)
            {
                var bytes = await ReadAt(offset, (int)Math.Min(65536, sizeBytes - offset));
                if (bytes.Length == 0)
                    break;
                offset += bytes.Length;
                var result = scanner.Consume(bytes);
                if (result.Stop)
                {
                    if (result.Consumed == bytes.Length && offset >= sizeBytes)
                        scanner.FinishEof();
                    break;
                }
                if (offset >= sizeBytes)
                    scanner.FinishEof();
            }
        }
        if (scanner.SelectedCount == 0 || end < start)
        {
            Publish([], 0, scanner);
            var empty =
                !ranged && scanner.Completed == 0
                    ? "(empty file)"
                    : $"(no content in requested line range {Requested(start, end)})";
            return empty
                + "\n---\n"
                + (scanner.Eof ? LineCount(scanner.Completed) + "\n" : "")
                + $"File size: {sizeBytes} bytes.";
        }
        var footer = new List<string>
        {
            ranged ? SelectedLabel(scanner, start, end) : LineCount(scanner.Completed),
        };
        if (!scanner.HasContent)
            footer.Add(
                ranged
                    ? "Selected lines contain only empty content."
                    : "File content contains only empty lines."
            );
        if (scanner.Eof && scanner.SelectedEnd == scanner.Completed && scanner.FileEnding == "none")
            footer.Add("File has no trailing newline.");
        var selected = ranged ? scanner.Selected.Full : full;
        Publish(selected, scanner.Selected.Count, scanner);
        if (selected is null)
            return BoundedTextExcerpt.Format(
                scanner.Selected.Head,
                scanner.Selected.Tail,
                scanner.Selected.Count,
                sizeBytes,
                display,
                "selected file range",
                footer,
                Separator(scanner.Ending)
            );
        footer.Insert(1, $"File size: {sizeBytes} bytes.");
        if (sizeBytes > FullLimit)
            footer.Add($"Complete content remains in source file: {display}.");
        return Encoding.UTF8.GetString(selected)
            + Separator(scanner.Ending)
            + "---\n"
            + string.Join('\n', footer);
    }

    internal static string FormatDirectory(
        string display,
        double? startLine,
        double? endLine,
        IReadOnlyList<TargetFileStat> entries
    )
    {
        var start = Math.Max(1, Bound(startLine) ?? 1);
        var end = Bound(endLine) is long value ? Math.Max(0, value) : (long?)null;
        var last =
            end ?? Math.Min(entries.Count, start > long.MaxValue - 49 ? long.MaxValue : start + 49);
        var page =
            start <= last
                ? entries
                    .Skip((int)Math.Min(start - 1, entries.Count))
                    .Take((int)Math.Min(entries.Count, last - start + 1))
                    .ToArray()
                : [];
        var lines = new List<string> { $"Directory listing for `{display}`", "" };
        if (page.Length == 0)
            lines.Add(entries.Count == 0 ? "(empty directory)" : "(no items in requested range)");
        for (var index = 0; index < page.Length; index++)
        {
            var entry = page[index];
            var link = entry.Kind == "symlink";
            var directory = !link && entry.Kind == "directory";
            var kind =
                link ? "symlink"
                : directory ? "dir"
                : "file";
            var size = kind == "file" ? $", {entry.Size} B" : "";
            lines.Add(
                $"{start + index}. `{entry.Name}{(directory ? "/" : "")}` ({kind}{size}) - {DateTimeOffset.FromUnixTimeMilliseconds((long)entry.ModifiedAtMs):yyyy-MM-ddTHH:mm:ss.fffZ}"
            );
        }
        var next = start + page.Length;
        lines.Add("");
        lines.Add(
            $"Showing items {(page.Length > 0 ? start : 0)}-{(page.Length > 0 ? next - 1 : 0)} of {entries.Count}."
                + (
                    next <= entries.Count
                        ? $" Next page: read({{ filePath: {JsonSerializer.Serialize(display)}, startLine: {next}, endLine: {Math.Min(entries.Count, next + 49)} }})"
                        : ""
                )
        );
        return string.Join('\n', lines);
    }
}
