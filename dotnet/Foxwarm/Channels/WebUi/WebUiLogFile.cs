using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Tools;

namespace Foxwarm.Channels.WebUi;

internal sealed class LogFileResetException(string message) : IOException(message);

internal sealed record LogCursor(string FileId, long Offset);

internal sealed record LogSubscription(string Id, LogCursor? Cursor = null);

internal sealed record LogWindow(
    string? FileId,
    long Size,
    long StartOffset,
    long EndOffset,
    string Text,
    int LineCount,
    bool StartsMidLine,
    bool EndsMidLine,
    int PendingBytes,
    bool Missing
)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    internal JsonObject Json() => JsonSerializer.SerializeToNode(this, JsonOptions)!.AsObject();
}

// Source webuiLogs.ts: bounded byte windows, observed open-file lifetimes and a
// subscriber-owned, non-overlapping timer. No file index or whole-file reads.
internal sealed class WebUiLogFile(string filePath, int intervalMs = 250) : IDisposable
{
    internal const int WindowBytes = 100 * 1024;
    internal const int CatchupBytes = 2 * WindowBytes;
    internal const int SocketBufferBytes = 512 * 1024;
    private readonly SemaphoreSlim reads = new(1);
    private string identity = "";
    private long generation;
    private long observedSize;
    private readonly object gate = new();
    private readonly HashSet<Subscriber> subscribers = [];
    private Timer? timer;
    private bool running;
    private bool disposed;

    private string Identify(OpenFileMetadata metadata)
    {
        if (metadata.Identity != identity || metadata.Size < observedSize)
            generation++;
        identity = metadata.Identity;
        observedSize = metadata.Size;
        return identity + ":" + generation.ToString(CultureInfo.InvariantCulture);
    }

    private static bool Continuation(byte value) => (value & 0xc0) == 0x80;

    private static int Utf8End(byte[] buffer, int end)
    {
        if (end == 0)
            return end;
        var lead = end - 1;
        while (lead > 0 && Continuation(buffer[lead]) && end - lead < 4)
            lead--;
        var value = buffer[lead];
        var length =
            value is >= 0xf0 and <= 0xf4 ? 4
            : value is >= 0xe0 and <= 0xef ? 3
            : value is >= 0xc2 and <= 0xdf ? 2
            : 1;
        return lead + length > end ? lead : end;
    }

    internal async Task<LogWindow> Read(
        string direction = "latest",
        long? offset = null,
        string? fileId = null
    )
    {
        await reads.WaitAsync();
        try
        {
            return await ReadNow(direction, offset, fileId);
        }
        finally
        {
            reads.Release();
        }
    }

    private async Task<LogWindow> ReadNow(string direction, long? offset, string? fileId)
    {
        FileStream stream;
        try
        {
            stream = new FileStream(
                filePath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                4096,
                FileOptions.Asynchronous | FileOptions.RandomAccess
            );
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            if (identity.Length > 0)
            {
                generation++;
                identity = "";
                observedSize = 0;
            }
            if (!string.IsNullOrEmpty(fileId))
                throw new LogFileResetException(
                    "The log file is no longer available. Return to latest logs."
                );
            return new(null, 0, 0, 0, "", 0, false, false, 0, true);
        }
        await using (stream)
        {
            var metadata = OpenFileMetadata.Read(stream.SafeFileHandle);
            var current = Identify(metadata);
            if (!string.IsNullOrEmpty(fileId) && current != fileId)
                throw new LogFileResetException("The log file changed. Return to latest logs.");
            var position = offset ?? metadata.Size;
            if (position < 0 || position > metadata.Size || position > 9007199254740991L)
                throw new LogFileResetException(
                    "The log position is no longer available. Return to latest logs."
                );
            var start =
                direction == "after"
                    ? position
                    : Math.Max(0, (direction == "before" ? position : metadata.Size) - WindowBytes);
            var end =
                direction == "after" ? Math.Min(metadata.Size, position + WindowBytes)
                : direction == "before" ? position
                : metadata.Size;
            var readStart = Math.Max(0, start - 1);
            var buffer = new byte[checked((int)(end - readStart))];
            var count = 0;
            while (count < buffer.Length)
            {
                var next = await RandomAccess.ReadAsync(
                    stream.SafeFileHandle,
                    buffer.AsMemory(count),
                    readStart + count
                );
                if (next == 0)
                    break;
                count += next;
            }
            var from = (int)(start - readStart);
            while (from < count && Continuation(buffer[from]))
                from++;
            var to = Math.Max(from, Utf8End(buffer, count));
            var content = buffer.AsSpan(from, to - from);
            var lines = content.Count((byte)10) + (content.Length > 0 && content[^1] != 10 ? 1 : 0);
            var result = new LogWindow(
                current,
                metadata.Size,
                readStart + from,
                readStart + to,
                Encoding.UTF8.GetString(content),
                lines,
                readStart + from > 0 && (from == 0 || buffer[from - 1] != 10),
                content.Length > 0 && content[^1] != 10,
                end == metadata.Size ? Math.Max(0, count - to) : 0,
                false
            );
            var after = OpenFileMetadata.Read(stream.SafeFileHandle);
            if (after.Size < metadata.Size || Identify(after) != current)
                throw new LogFileResetException(
                    "The log file changed during reading. Return to latest logs."
                );
            return result;
        }
    }

    internal static string Clean(string text) =>
        Regex.Replace(
            Regex.Replace(
                Regex.Replace(text, "\u001b\\][^\u0007\u001b]*(?:\u0007|\u001b\\\\)", ""),
                "\u001b\\[[0-?]*[ -/]*[@-~]",
                ""
            ),
            "[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]",
            ""
        );

    private static List<(double Time, long Offset)> Timestamps(LogWindow window)
    {
        List<(double, long)> records = [];
        var offset = window.StartOffset;
        var index = 0;
        foreach (var line in window.Text.Split('\n'))
        {
            if (!(index++ == 0 && window.StartsMidLine))
            {
                var text = Clean(line);
                var pretty = Regex.Match(
                    text,
                    @"^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) ([+-]\d{4})\]"
                );
                double time = double.NaN;
                if (
                    pretty.Success
                    && DateTimeOffset.TryParseExact(
                        pretty.Groups[1].Value
                            + " "
                            + pretty.Groups[2].Value
                            + " "
                            + pretty.Groups[3].Value.Insert(3, ":"),
                        "yyyy-MM-dd HH:mm:ss.fff zzz",
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.None,
                        out var date
                    )
                )
                    time = date.ToUnixTimeMilliseconds();
                else if (!pretty.Success && text.StartsWith('{'))
                {
                    try
                    {
                        if (
                            JsonNode.Parse(text)?["time"] is JsonValue value
                            && value.TryGetValue<double>(out var number)
                        )
                            time = number;
                    }
                    catch (JsonException) { }
                }
                if (double.IsFinite(time))
                    records.Add((time, offset));
            }
            offset += Encoding.UTF8.GetByteCount(line) + 1;
        }
        return records;
    }

    internal async Task<JsonObject> Seek(double time, string fileId)
    {
        if (!double.IsFinite(time))
            throw new InvalidDataException("Choose a valid date and time.");
        var latest = await Read(fileId: fileId);
        (double Time, long Offset)? best = null;
        var earliest = double.PositiveInfinity;
        var latestTime = double.NegativeInfinity;
        void Consider(List<(double Time, long Offset)> records)
        {
            foreach (var record in records)
            {
                earliest = Math.Min(earliest, record.Time);
                latestTime = Math.Max(latestTime, record.Time);
                if (best is null || Math.Abs(record.Time - time) < Math.Abs(best.Value.Time - time))
                    best = record;
            }
        }
        Consider(Timestamps(latest));
        if (latest.StartOffset > 0)
            Consider(Timestamps(await Read("after", 0, fileId)));
        long low = 0,
            high = latest.Size;
        for (var probe = 0; probe < 20 && high - low > WindowBytes; probe++)
        {
            var middle = (low + high) / 2;
            var records = Timestamps(await Read("after", middle, fileId));
            Consider(records);
            if (records.Count == 0)
            {
                var nearby = Timestamps(await Read("before", middle, fileId));
                Consider(nearby);
                if (nearby.Count == 0)
                    break;
                if (nearby[^1].Time < time)
                    low = middle;
                else
                    high = middle;
            }
            else if (records[0].Time < time)
                low = middle;
            else
                high = middle;
        }
        if (best is null)
            throw new InvalidDataException(
                "No full dates were found near that time. Older entries without dates can still be browsed."
            );
        if (time < earliest || time > latestTime)
            throw new InvalidDataException(
                "That time is outside the dated logs we could find. Try another time or browse older logs."
            );
        Consider(
            Timestamps(
                await Read("after", Math.Max(0, best.Value.Offset - WindowBytes / 2), fileId)
            )
        );
        var window = await Read("after", best.Value.Offset, fileId);
        return new()
        {
            ["window"] = window.Json(),
            ["locatedTime"] = DateTimeOffset
                .FromUnixTimeMilliseconds((long)best.Value.Time)
                .ToUniversalTime()
                .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
            ["approximate"] = true,
        };
    }

    private sealed class Subscriber(
        LogSubscription request,
        Action<JsonObject> emit,
        Func<bool> canSend
    )
    {
        internal readonly LogSubscription Request = request;
        internal readonly Action<JsonObject> Emit = emit;
        internal readonly Func<bool> CanSend = canSend;
        internal LogCursor? Cursor = request.Cursor;
        internal bool Initial = true,
            Stopped,
            Gap;
        internal long? LastSize;
    }

    internal Action Subscribe(LogSubscription request, Action<JsonObject> emit, Func<bool> canSend)
    {
        var subscriber = new Subscriber(request, emit, canSend);
        lock (gate)
        {
            if (disposed)
                return () => { };
            subscribers.Add(subscriber);
            Schedule(0);
        }
        return () =>
        {
            lock (gate)
            {
                subscriber.Stopped = true;
                subscribers.Remove(subscriber);
                CancelIfIdle();
            }
        };
    }

    private void Schedule(int? delay = null)
    {
        if (disposed || timer is not null || running || subscribers.Count == 0)
            return;
        timer = new Timer(_ => _ = Tick(), null, delay ?? intervalMs, Timeout.Infinite);
    }

    private async Task Tick()
    {
        Subscriber[] current;
        lock (gate)
        {
            timer?.Dispose();
            timer = null;
            if (running || disposed)
                return;
            running = true;
            current = subscribers.ToArray();
        }
        try
        {
            foreach (var subscriber in current)
            {
                lock (gate)
                    if (subscriber.Stopped || disposed)
                        continue;
                if (!subscriber.CanSend())
                {
                    subscriber.Gap = true;
                    continue;
                }
                if (subscriber.Gap)
                {
                    Emit(
                        subscriber,
                        "logs-gap",
                        "Some logs were not displayed. Return to latest logs."
                    );
                    subscriber.Stopped = true;
                    continue;
                }
                try
                {
                    if (subscriber.Initial && subscriber.Cursor is null)
                    {
                        var window = await Read();
                        Emit(subscriber, "logs-snapshot", window: window);
                        if (window.FileId is not null)
                            subscriber.Cursor = new(window.FileId, window.EndOffset);
                        subscriber.LastSize = window.Size;
                        subscriber.Initial = false;
                        continue;
                    }
                    if (subscriber.Cursor is null)
                    {
                        if (!(await Read()).Missing)
                        {
                            Emit(
                                subscriber,
                                "logs-reset",
                                "The log file became available. Return to latest logs."
                            );
                            subscriber.Stopped = true;
                        }
                        continue;
                    }
                    var next = await Read(
                        "after",
                        subscriber.Cursor.Offset,
                        subscriber.Cursor.FileId
                    );
                    if (next.Size - subscriber.Cursor.Offset > CatchupBytes)
                    {
                        Emit(
                            subscriber,
                            "logs-gap",
                            "Some logs were not displayed. Return to latest logs."
                        );
                        subscriber.Stopped = true;
                        continue;
                    }
                    if (
                        next.EndOffset > subscriber.Cursor.Offset
                        || subscriber.Initial
                        || next.Size != subscriber.LastSize
                    )
                    {
                        Emit(subscriber, "logs-delta", window: next);
                        subscriber.Cursor = new(next.FileId!, next.EndOffset);
                    }
                    subscriber.LastSize = next.Size;
                    subscriber.Initial = false;
                }
                catch (Exception error)
                {
                    Emit(
                        subscriber,
                        error is LogFileResetException ? "logs-reset" : "logs-error",
                        error.Message
                    );
                    subscriber.Stopped = true;
                }
            }
        }
        finally
        {
            lock (gate)
            {
                running = false;
                subscribers.RemoveWhere(s => s.Stopped);
                Schedule();
            }
        }
    }

    private void Emit(
        Subscriber subscriber,
        string type,
        string? message = null,
        LogWindow? window = null
    )
    {
        lock (gate)
        {
            if (disposed || subscriber.Stopped || !subscribers.Contains(subscriber))
                return;
            var frame = new JsonObject { ["type"] = type, ["logsId"] = subscriber.Request.Id };
            if (message is not null)
                frame["message"] = message;
            if (window is not null)
                frame["window"] = window.Json();
            subscriber.Emit(frame);
        }
    }

    private void CancelIfIdle()
    {
        if (subscribers.Count == 0)
        {
            timer?.Dispose();
            timer = null;
        }
    }

    internal int SubscriberCount
    {
        get
        {
            lock (gate)
                return subscribers.Count;
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
            foreach (var subscriber in subscribers)
                subscriber.Stopped = true;
            subscribers.Clear();
            CancelIfIdle();
        }
    }
}
