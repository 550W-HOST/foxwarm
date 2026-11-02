using System.Globalization;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// Read-only, on-demand projection of recent Session activity for the WebUI sequence view.
/// Session selection comes from the Main catalog and events from each Session's own Archive
/// rows; nothing is persisted. Deliveries pair exactly by (sourceSessionId, deliverySeq) and
/// older rows without that ID pair heuristically and are marked inferred.
/// </summary>
internal sealed partial class SessionSequenceProjection
{
    internal const int DefaultSessionLimit = 30;
    internal const int MaxSessionLimit = 80;
    internal const int DefaultEventLimit = 400;
    internal const int MaxEventLimit = 2000;
    private const double SendTolerance = 3000;
    private const int CandidateLimit = 2000;

    internal sealed record Request(
        double Since,
        string? FocusSessionId = null,
        IReadOnlyList<string>? SessionIds = null,
        IReadOnlyDictionary<string, long>? After = null,
        int SessionLimit = DefaultSessionLimit,
        int EventLimit = DefaultEventLimit
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

    private sealed class Lane(string id)
    {
        internal string Id { get; } = id;
        internal ArchiveSequencePage? Page { get; set; }
        internal List<JsonObject> Events { get; } = [];
        internal List<ToolSpan> Tools { get; } = [];
        internal List<Outgoing> Outgoing { get; } = [];
        internal List<Incoming> Incoming { get; } = [];
        internal (double At, string? Parent, string Kind, long Seq)? Start { get; set; }
    }

    private readonly SessionRuntime runtime;
    private readonly string archivePath;

    internal SessionSequenceProjection(SessionRuntime runtime, string archivePath)
    {
        this.runtime = runtime;
        this.archivePath = archivePath;
    }

    internal JsonObject Build(Request request, Visibility? visibility)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var allows = visibility?.Allows ?? (_ => true);
        var lanes = new Dictionary<string, Lane>(StringComparer.Ordinal);
        var order = new List<string>();
        var truncatedSessions = false;
        using var connection = SqliteArchiveSequence.Open(archivePath);

        Lane Load(string id)
        {
            var lane = new Lane(id);
            if (connection is not null)
            {
                long? after =
                    request.After?.TryGetValue(id, out var cursor) == true ? cursor : null;
                lane.Page = SqliteArchiveSequence.Read(
                    connection,
                    id,
                    request.Since,
                    after,
                    request.EventLimit
                );
                Normalize(lane);
            }
            lanes[id] = lane;
            order.Add(id);
            return lane;
        }

        if (request.SessionIds is { } explicitIds)
        {
            foreach (var requested in explicitIds)
            {
                var id = Canonical(requested);
                if (id is null || lanes.ContainsKey(id) || !allows(id))
                    continue;
                if (lanes.Count >= request.SessionLimit)
                {
                    truncatedSessions = true;
                    break;
                }
                Load(id);
            }
        }
        else
        {
            // Scoped callers and focus components filter after selection, so they read a wider
            // (still bounded, metadata-only) candidate set.
            var candidates = runtime.Catalog.SequenceCandidates(
                request.Since,
                request.FocusSessionId is null && visibility is null
                    ? request.SessionLimit + 1
                    : CandidateLimit
            );
            var visible = candidates.Where(row => allows(row.Id)).ToList();
            if (request.FocusSessionId is { } focusRequest)
            {
                var focus = Canonical(focusRequest);
                if (focus is not null && allows(focus))
                    truncatedSessions = Component(focus, visible, lanes, request, allows, Load);
            }
            else
            {
                foreach (var row in visible)
                {
                    if (lanes.Count >= request.SessionLimit)
                    {
                        truncatedSessions = true;
                        break;
                    }
                    Load(row.Id);
                }
            }
        }

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
            else if (request.After?.TryGetValue(id, out var cursor) == true)
                cursors[id] = cursor;
        var result = new JsonObject
        {
            ["version"] = 1,
            ["revision"] = runtime.PresentationRevision,
            ["generatedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["since"] = request.Since,
            ["incremental"] = request.After is not null,
            ["sessions"] = sessions,
            ["peers"] = peers,
            ["events"] = events,
            ["links"] = links,
            ["cursors"] = cursors,
            ["truncatedSessions"] = truncatedSessions,
            ["elapsedMs"] = Math.Round(watch.Elapsed.TotalMilliseconds, 1),
        };
        if (visibility is null)
            result["tasks"] = Tasks(links);
        return result;
    }

    private string? Canonical(string id) =>
        SessionCatalog.Text(runtime.Catalog.Resolve(id)["sessionId"]);

    // The collaboration component of the focus Session: parent/child relations plus peers
    // actually seen in loaded deliveries, bounded by the Session limit.
    private bool Component(
        string focus,
        IReadOnlyList<SessionCatalog.SequenceCandidate> candidates,
        Dictionary<string, Lane> lanes,
        Request request,
        Func<string, bool> allows,
        Func<string, Lane> load
    )
    {
        var window = candidates.ToDictionary(row => row.Id, StringComparer.Ordinal);
        var children = candidates
            .Where(row => row.Parent is not null)
            .GroupBy(row => row.Parent!, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => group.Select(row => row.Id).ToArray(),
                StringComparer.Ordinal
            );
        var queue = new Queue<string>([focus]);
        var queued = new HashSet<string>([focus], StringComparer.Ordinal);
        while (queue.Count > 0)
        {
            if (lanes.Count >= request.SessionLimit)
                return true;
            var id = queue.Dequeue();
            var lane = load(id);
            var neighbors = new List<string>();
            var parent = window.TryGetValue(id, out var row)
                ? row.Parent
                : SessionCatalog.Text(runtime.Catalog.Presentation(id)?["parentSessionId"]);
            if (parent is not null && window.ContainsKey(parent))
                neighbors.Add(parent);
            if (children.TryGetValue(id, out var kids))
                neighbors.AddRange(kids);
            if (lane.Start?.Parent is { } creator)
                neighbors.Add(creator);
            neighbors.AddRange(lane.Outgoing.Select(item => item.Target));
            neighbors.AddRange(
                lane.Incoming.Select(item => item.Attributes.GetValueOrDefault("sourceSessionId"))
                    .OfType<string>()
            );
            foreach (var neighbor in neighbors)
            {
                var canonical = window.ContainsKey(neighbor) ? neighbor : Canonical(neighbor);
                if (canonical is not null && allows(canonical) && queued.Add(canonical))
                    queue.Enqueue(canonical);
            }
        }
        return false;
    }

    private void Normalize(Lane lane)
    {
        var calls = new Dictionary<
            string,
            (long Seq, int Call, int Total, string Name, string Preview)
        >(StringComparer.Ordinal);
        if (lane.Page!.Context is { } context)
            NormalizeModel(new Lane(lane.Id), context, calls);
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
