using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

/// <summary>
/// Read-only, on-demand projection of Session activity for the WebUI sequence view, paged
/// newest first across all Sessions. Sessions are chosen by their own Archive rows (span cached
/// in memory) and events come from those rows; nothing is persisted. Deliveries pair exactly by (sourceSessionId, deliverySeq) and
/// older rows without that ID pair heuristically and are marked inferred.
/// </summary>
internal sealed partial class SessionSequenceProjection
{
    internal const int DefaultPageLimit = 400;
    internal const int MaxPageLimit = 2000;
    internal const int DefaultEventLimit = 400;
    internal const int MaxEventLimit = 2000;
    internal const int MaxSessionIds = 1000;
    private const double SendTolerance = 3000;
    private const double Minute = 60_000;
    private const int PositionChunk = 64;

    /// <summary>One newest-first page: rows older than <see cref="Before"/> (newest when null).</summary>
    internal sealed record PageRequest(
        ArchiveSequenceCursor? Before = null,
        int Limit = DefaultPageLimit,
        IReadOnlyList<string>? SessionIds = null
    );

    /// <summary>
    /// Live append: rows after each known Session's cursor, plus Sessions not yet known that have
    /// rows at or after <see cref="Since"/>.
    /// </summary>
    internal sealed record IncrementalRequest(
        double Since,
        IReadOnlyDictionary<string, long> After,
        int EventLimit = DefaultEventLimit,
        IReadOnlyList<string>? SessionIds = null
    );

    /// <summary>Visibility for one caller. Administrators see every Session.</summary>
    internal sealed record Visibility(
        Func<string, bool> Allows,
        Func<string, string> Opaque,
        Func<JsonObject, JsonObject> Session
    );

    private sealed record ToolSpan(
        long Seq,
        long? CallSeq,
        int Call,
        int Total,
        string Name,
        double Start,
        double End,
        IReadOnlyList<(double Start, double End)> SubCalls
    );

    private sealed class Outgoing(
        string target,
        string? deliverySeq,
        double at,
        string preview,
        long seq,
        long? callSeq,
        int call,
        int? sub
    )
    {
        internal string Target { get; } = target;
        internal string? DeliverySeq { get; } = deliverySeq;
        internal double At { get; } = at;
        internal string Preview { get; } = preview;
        internal long Seq { get; } = seq;
        internal long? CallSeq { get; } = callSeq;
        internal int Call { get; } = call;
        internal int? Sub { get; } = sub;
        internal bool Matched { get; set; }
    }

    private sealed record Incoming(
        long Seq,
        int Part,
        double ConsumedAt,
        string Type,
        IReadOnlyDictionary<string, string> Attributes,
        string Preview
    );

    private sealed class Lane(string id, ArchiveSpan span)
    {
        internal string Id { get; } = id;
        internal ArchiveSpan Span { get; } = span;
        internal ArchiveSequencePage? Page { get; set; }
        internal List<JsonObject> Events { get; } = [];
        internal List<ToolSpan> Tools { get; } = [];
        internal List<Outgoing> Outgoing { get; } = [];
        internal List<Incoming> Incoming { get; } = [];
        internal (double At, string? Parent, string Kind, long Seq)? Start { get; set; }
    }

    // One Session's position in the newest-first merge.
    private sealed class Source(SessionCatalog.SequenceSession session, ArchiveSpan span, long high)
    {
        internal SessionCatalog.SequenceSession Session { get; } = session;
        internal ArchiveSpan Span { get; } = span;
        internal long High { get; set; } = high;
        internal Queue<(long Seq, double Timestamp)> Buffer { get; } = new();
        internal long? Low { get; set; }
        internal long? Top { get; set; }
    }

    // Newest first: later time, then the larger Session ID, then the larger seq.
    private sealed class Newest : IComparer<(double At, string Id, long Seq)>
    {
        internal static readonly Newest Instance = new();

        public int Compare((double At, string Id, long Seq) x, (double At, string Id, long Seq) y)
        {
            var order = y.At.CompareTo(x.At);
            if (order == 0)
                order = string.CompareOrdinal(y.Id, x.Id);
            return order != 0 ? order : y.Seq.CompareTo(x.Seq);
        }
    }

    private readonly SessionRuntime runtime;
    private readonly string archivePath;
    private Func<string, bool> allows = _ => true;
    private double? pageFrom;

    internal SessionSequenceProjection(SessionRuntime runtime, string archivePath)
    {
        this.runtime = runtime;
        this.archivePath = archivePath;
    }

    // Visible catalog Sessions with own Archive rows, optionally limited to requested IDs.
    private List<(SessionCatalog.SequenceSession Session, ArchiveSpan Span)> Candidates(
        SqliteConnection connection,
        IReadOnlyList<string>? requested
    )
    {
        HashSet<string>? only = null;
        if (requested is not null)
            only = requested.Select(Canonical).OfType<string>().ToHashSet(StringComparer.Ordinal);
        var result = new List<(SessionCatalog.SequenceSession, ArchiveSpan)>();
        foreach (var session in runtime.Catalog.SequenceSessions())
        {
            if (only is not null && !only.Contains(session.Id) || !allows(session.Id))
                continue;
            if (SqliteArchiveSequence.Span(connection, archivePath, session) is { } span)
                result.Add((session, span));
        }
        return result;
    }

    /// <summary>
    /// A k-way newest-first merge over the Sessions whose own Archive rows reach the scan
    /// position. A Session joins once the scan reaches its last row; one already open at the
    /// cursor starts from a binary search on seq. After <see cref="PageRequest.Limit"/> rows
    /// the page completes its oldest minute, so a minute is never split across pages.
    /// </summary>
    internal JsonObject BuildPage(PageRequest request, Visibility? visibility)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        allows = visibility?.Allows ?? (_ => true);
        using var connection = SqliteArchiveSequence.Open(archivePath);
        var lanes = new Dictionary<string, Lane>(StringComparer.Ordinal);
        var order = new List<string>();
        var cursor = request.Before;
        JsonObject? next = null;
        var hasMore = false;
        double? from = null;
        if (connection is not null)
        {
            var heap = new PriorityQueue<Source, (double, string, long)>(Newest.Instance);
            var waiting = new List<(SessionCatalog.SequenceSession Session, ArchiveSpan Span)>();
            foreach (var (session, span) in Candidates(connection, request.SessionIds))
            {
                if (cursor is null || span.Last < cursor.At)
                    waiting.Add((session, span));
                else if (cursor.Includes(span.First, session.Id, span.FirstSeq))
                {
                    var high = SqliteArchiveSequence.SeqBefore(
                        connection,
                        session.Id,
                        span,
                        cursor
                    );
                    Push(connection, heap, new Source(session, span, high));
                }
            }
            waiting.Sort((a, b) => b.Span.Last.CompareTo(a.Span.Last));
            var nextWaiting = 0;
            var sources = new List<Source>();
            var total = 0;
            var hardCap = request.Limit * 4;
            double? stop = null;
            double oldest = 0;
            while (true)
            {
                while (
                    nextWaiting < waiting.Count
                    && (heap.Count == 0 || waiting[nextWaiting].Span.Last >= PeekTime(heap))
                )
                {
                    var (session, span) = waiting[nextWaiting++];
                    Push(connection, heap, new Source(session, span, span.LastSeq));
                }
                if (heap.Count == 0)
                    break;
                heap.TryPeek(out _, out var top);
                if (stop is double boundary && top.Item1 < boundary)
                {
                    hasMore = true;
                    next = new JsonObject { ["at"] = boundary };
                    from = boundary;
                    break;
                }
                var source = heap.Dequeue();
                var (seq, at) = source.Buffer.Dequeue();
                if (source.Top is null)
                    sources.Add(source);
                source.Top ??= seq;
                source.Low = seq;
                oldest = at;
                total++;
                if (total >= request.Limit && stop is null)
                    stop = Math.Floor(at / Minute) * Minute;
                Push(connection, heap, source);
                if (total >= hardCap)
                {
                    // One extraordinarily busy minute: split it with a full row cursor.
                    hasMore = heap.Count > 0 || nextWaiting < waiting.Count;
                    if (hasMore)
                        next = new JsonObject
                        {
                            ["at"] = at,
                            ["sessionId"] = source.Session.Id,
                            ["seq"] = seq,
                        };
                    from = at;
                    break;
                }
            }
            foreach (var source in sources)
            {
                var lane = new Lane(source.Session.Id, source.Span)
                {
                    Page = SqliteArchiveSequence.ReadRange(
                        connection,
                        source.Session.Id,
                        source.Span,
                        source.Low!.Value,
                        source.Top!.Value
                    ),
                };
                Normalize(lane);
                lanes[lane.Id] = lane;
                order.Add(lane.Id);
            }
            if (!hasMore && sources.Count > 0)
                from = Math.Floor(oldest / Minute) * Minute;
        }
        pageFrom = from;
        var result = Result(lanes, order, visibility, watch);
        result["mode"] = "page";
        result["range"] = new JsonObject { ["from"] = from, ["to"] = cursor?.At };
        result["next"] = next;
        result["hasMore"] = hasMore;
        return result;
    }

    private static double PeekTime(PriorityQueue<Source, (double, string, long)> heap)
    {
        heap.TryPeek(out _, out var key);
        return key.Item1;
    }

    // Queues the Source's next row, reading positions in small newest-first chunks.
    private static void Push(
        SqliteConnection connection,
        PriorityQueue<Source, (double, string, long)> heap,
        Source source
    )
    {
        if (source.Buffer.Count == 0 && source.High >= source.Span.FirstSeq)
        {
            var rows = SqliteArchiveSequence.Positions(
                connection,
                source.Span,
                source.High,
                PositionChunk
            );
            foreach (var row in rows)
                source.Buffer.Enqueue(row);
            source.High = rows.Count < PositionChunk ? source.Span.FirstSeq - 1 : rows[^1].Seq - 1;
        }
        if (source.Buffer.TryPeek(out var head))
            heap.Enqueue(source, (head.Timestamp, source.Session.Id, head.Seq));
    }

    /// <summary>Rows appended since the caller's cursors, ascending per Session.</summary>
    internal JsonObject BuildIncremental(IncrementalRequest request, Visibility? visibility)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        allows = visibility?.Allows ?? (_ => true);
        pageFrom = null;
        using var connection = SqliteArchiveSequence.Open(archivePath);
        var lanes = new Dictionary<string, Lane>(StringComparer.Ordinal);
        var order = new List<string>();
        if (connection is not null)
        {
            var after = new Dictionary<string, long>(StringComparer.Ordinal);
            foreach (var (id, seq) in request.After)
                if (Canonical(id) is { } canonical)
                    after[canonical] = seq;
            foreach (var (session, span) in Candidates(connection, request.SessionIds))
            {
                long? cursor = after.TryGetValue(session.Id, out var known) ? known : null;
                if (cursor is long seq ? span.LastSeq <= seq : span.Last < request.Since)
                    continue;
                var lane = new Lane(session.Id, span)
                {
                    Page = SqliteArchiveSequence.ReadAfter(
                        connection,
                        session.Id,
                        span,
                        cursor,
                        request.Since,
                        request.EventLimit
                    ),
                };
                if (lane.Page.Rows.Count == 0)
                    continue;
                Normalize(lane);
                lanes[lane.Id] = lane;
                order.Add(lane.Id);
            }
        }
        var result = Result(lanes, order, visibility, watch);
        result["mode"] = "incremental";
        result["since"] = request.Since;
        return result;
    }

    private JsonObject Result(
        Dictionary<string, Lane> lanes,
        List<string> order,
        Visibility? visibility,
        System.Diagnostics.Stopwatch watch
    )
    {
        var links = Pair(lanes, visibility);
        var sessions = Sessions(order, lanes, visibility);
        var peers = Peers(links, lanes, visibility);
        var events = new JsonArray();
        foreach (var id in order)
        foreach (var item in lanes[id].Events)
            events.Add(item);
        var cursors = new JsonObject();
        foreach (var id in order)
            if (lanes[id].Page?.Rows is { Count: > 0 } rows)
                cursors[id] = rows[^1].Seq;
        var result = new JsonObject
        {
            ["version"] = 2,
            ["revision"] = runtime.PresentationRevision,
            ["generatedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["sessions"] = sessions,
            ["peers"] = peers,
            ["events"] = events,
            ["links"] = links,
            ["cursors"] = cursors,
            ["elapsedMs"] = Math.Round(watch.Elapsed.TotalMilliseconds, 1),
        };
        if (visibility is null)
            result["tasks"] = Tasks(links);
        return result;
    }

    private string? Canonical(string id) =>
        SessionCatalog.Text(runtime.Catalog.Resolve(id)["sessionId"]);

    private void Normalize(Lane lane)
    {
        var calls = new Dictionary<
            string,
            (long Seq, int Call, int Total, string Name, string Preview)
        >(StringComparer.Ordinal);
        if (lane.Page!.Context is { } context)
            NormalizeModel(new Lane(lane.Id, lane.Span), context, calls);
        foreach (var row in lane.Page.Rows)
        {
            switch (row.Role)
            {
                case "model":
                    NormalizeModel(lane, row, calls);
                    break;
                case "tool":
                    NormalizeTool(lane, row, calls);
                    break;
                case "user":
                    NormalizeUser(lane, row);
                    break;
            }
        }
    }

    private static void NormalizeModel(
        Lane lane,
        ArchiveSequenceRow row,
        Dictionary<string, (long Seq, int Call, int Total, string Name, string Preview)> calls
    )
    {
        var list = (row.Data["calls"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];
        for (var index = 0; index < list.Length; index++)
        {
            var (name, args) = Concrete(list[index]);
            if (Str(list[index]["id"]) is { } callId)
                calls[callId] = (row.Seq, index + 1, list.Length, name, ArgsPreview(name, args));
        }
        var text = Preview(Str(row.Data["text"]));
        // Text-only rows without request timing (for example external runtime output) still show.
        var timing = row.Data["timing"] as JsonObject;
        if (
            timing is null
            && (text.Length == 0 || IsHidden(row) || Str(row.Data["notice"]) is not null)
        )
            return;
        var end = Num(timing?["completedAt"]) ?? row.Timestamp;
        var start = Num(timing?["startedAt"]) ?? end - (Num(timing?["durationMs"]) ?? 0);
        var item = new JsonObject
        {
            ["sessionId"] = lane.Id,
            ["seq"] = row.Seq,
            ["kind"] = "llm",
            ["start"] = start,
            ["end"] = end,
            ["calls"] = list.Length,
            ["preview"] = text,
        };
        if (Str(row.Data["phase"]) is "commentary" or "final_answer" && text.Length > 0)
            item["phase"] = Str(row.Data["phase"]);
        lane.Events.Add(item);
    }

    private static void NormalizeTool(
        Lane lane,
        ArchiveSequenceRow row,
        Dictionary<string, (long Seq, int Call, int Total, string Name, string Preview)> calls
    )
    {
        var responses = (row.Data["responses"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];
        for (var index = 0; index < responses.Length; index++)
        {
            var response = responses[index];
            var id = Str(response["id"]) ?? "";
            var known = calls.TryGetValue(id, out var call);
            var name = known ? call.Name : Str(response["name"]) ?? "tool";
            var position = known ? call.Call : index + 1;
            var total = known ? call.Total : responses.Length;
            long? callSeq = known ? call.Seq : null;
            var timing = response["timing"] as JsonObject;
            var start = Num(timing?["startedAt"]) ?? row.Timestamp;
            var end = Num(timing?["completedAt"]) ?? Math.Max(start, row.Timestamp);
            var status =
                response["canceled"] is JsonValue canceled
                && canceled.TryGetValue<bool>(out var flag)
                && flag
                    ? "canceled"
                : response["failed"] is JsonValue failed
                && (failed.TryGetValue<bool>(out var bad) ? bad : failed.ToString() == "1")
                    ? "error"
                : "ok";
            var script = name is "run_script" or "start_toolscript_run" or "continue_script";
            var callDelivery = SessionManager.BatchDeliverySeq(
                callSeq,
                position - 1,
                total,
                script
            );
            var subCalls =
                (response["subCalls"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];
            var spans = new List<(double, double)>();
            var projected = new JsonArray();
            for (var n = 0; n < subCalls.Length; n++)
            {
                var sub = subCalls[n];
                var subStart = Num(sub["startedAt"]) ?? start;
                var subEnd = subStart + (Num(sub["durationMs"]) ?? 0);
                spans.Add((subStart, subEnd));
                if (projected.Count < 50)
                    projected.Add(
                        new JsonObject
                        {
                            ["n"] = n + 1,
                            ["name"] = Str(sub["name"]) ?? "tool",
                            ["start"] = subStart,
                            ["end"] = subEnd,
                            ["status"] = Str(sub["status"]) ?? "completed",
                        }
                    );
                if (Str(sub["target"]) is { } subTarget && Str(sub["status"]) == "completed")
                    lane.Outgoing.Add(
                        new(
                            subTarget,
                            Str(sub["deliverySeq"]),
                            subStart,
                            Preview(Str(sub["message"])),
                            row.Seq,
                            callSeq,
                            position,
                            n + 1
                        )
                    );
            }
            lane.Tools.Add(new(row.Seq, callSeq, position, total, name, start, end, spans));
            var item = new JsonObject
            {
                ["sessionId"] = lane.Id,
                ["seq"] = row.Seq,
                ["kind"] = "tool",
                ["name"] = name,
                ["start"] = start,
                ["end"] = end,
                ["status"] = status,
                ["call"] = position,
                ["preview"] = known ? call.Preview : "",
            };
            if (callSeq is long anchor)
                item["callSeq"] = anchor;
            if (callDelivery is not null)
                item["deliverySeq"] = callDelivery;
            if (Str(response["error"]) is { } errorType)
                item["error"] = errorType;
            if (projected.Count > 0)
                item["subCalls"] = projected;
            lane.Events.Add(item);
            foreach (
                var delivery in (response["deliveries"] as JsonArray)?.OfType<JsonObject>() ?? []
            )
                if (Str(delivery["target"]) is { } target)
                    lane.Outgoing.Add(
                        new(
                            target,
                            Str(delivery["deliverySeq"]),
                            start,
                            Preview(Str(delivery["message"])),
                            row.Seq,
                            callSeq,
                            position,
                            null
                        )
                    );
        }
    }

    private static void NormalizeUser(Lane lane, ArchiveSequenceRow row)
    {
        var parts = (row.Data["system"] as JsonArray)?.Select(Str).OfType<string>().ToArray() ?? [];
        var wrapped = false;
        for (var index = 0; index < parts.Length; index++)
        {
            if (ParseWrapper(parts[index]) is not { } wrapper)
                continue;
            if (wrapper.Tag == "foxwarm-system")
            {
                if (
                    wrapper.Attributes.GetValueOrDefault("kind") == "session-boundary"
                    && lane.Start is null
                )
                    lane.Start = (
                        row.Timestamp,
                        wrapper.Attributes.GetValueOrDefault("parentSessionId"),
                        wrapper.Attributes.GetValueOrDefault("event") ?? "created",
                        row.Seq
                    );
                continue;
            }
            wrapped = true;
            var type = wrapper.Attributes.GetValueOrDefault("type") ?? "message";
            var body = wrapper.Body;
            if (body.Length == 0 && type == "channel")
                body = Str(row.Data["text"]) ?? "";
            lane.Incoming.Add(
                new(row.Seq, index, row.Timestamp, type, wrapper.Attributes, Preview(body))
            );
        }
        if (!wrapped && Str(row.Data["text"]) is { Length: > 0 } text && !IsHidden(row))
            lane.Incoming.Add(
                new(
                    row.Seq,
                    -1,
                    row.Timestamp,
                    "user",
                    new Dictionary<string, string>(),
                    Preview(text)
                )
            );
    }

    private static bool IsHidden(ArchiveSequenceRow row) =>
        row.Data["visible"] is JsonValue value && value.TryGetValue<bool>(out var flag) && !flag;

    private static string Key(params object?[] parts) =>
        string.Join(
            "|",
            parts.Select(part => Convert.ToString(part, CultureInfo.InvariantCulture) ?? "")
        );
}
