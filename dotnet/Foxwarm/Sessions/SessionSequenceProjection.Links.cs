using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionSequenceProjection
{
    private JsonArray Pair(Dictionary<string, Lane> lanes, Visibility? visibility)
    {
        var links = new JsonArray();
        string Peer(string id) =>
            visibility is null || visibility.Allows(id) ? id : visibility.Opaque(id);
        var exact = new Dictionary<string, Outgoing>(StringComparer.Ordinal);
        foreach (var lane in lanes.Values)
        foreach (var item in lane.Outgoing)
            if (item.DeliverySeq is { } id)
                exact.TryAdd(Key(lane.Id, id, item.Target), item);

        foreach (var lane in lanes.Values)
        {
            foreach (var incoming in lane.Incoming)
            {
                var attributes = incoming.Attributes;
                var sentAt = WrapperTime(attributes.GetValueOrDefault("time"));
                var link = new JsonObject
                {
                    ["to"] = new JsonObject
                    {
                        ["sessionId"] = lane.Id,
                        ["seq"] = incoming.Seq,
                        ["at"] = incoming.ConsumedAt,
                    },
                    ["consumedAt"] = incoming.ConsumedAt,
                    ["preview"] = incoming.Preview,
                };
                var source = attributes.GetValueOrDefault("sourceSessionId");
                var deliverySeq = attributes.GetValueOrDefault("deliverySeq");
                if (attributes.GetValueOrDefault("taskId") is { Length: > 0 } taskId)
                {
                    link["taskId"] = taskId;
                    if (attributes.GetValueOrDefault("event") is { Length: > 0 } taskEvent)
                        link["taskEvent"] = taskEvent;
                }
                switch (incoming.Type)
                {
                    case "inter-agent" or "task" when source is not null:
                    {
                        link["kind"] = incoming.Type == "task" ? "task" : "message";
                        var from = new JsonObject { ["lane"] = "session" };
                        double? at = null;
                        string pairing;
                        if (deliverySeq is not null)
                        {
                            pairing = "exact";
                            link["deliverySeq"] = deliverySeq;
                            link["key"] = Key("d", Peer(source), deliverySeq, lane.Id);
                            if (ParseDeliverySeq(deliverySeq) is { } anchor)
                            {
                                from["seq"] = anchor.Seq;
                                from["call"] = anchor.Call;
                                if (anchor.SubCall is int sub)
                                    from["sub"] = sub;
                            }
                            if (exact.TryGetValue(Key(source, deliverySeq, lane.Id), out var sent))
                            {
                                sent.Matched = true;
                                at = sent.At;
                            }
                            else if (lanes.TryGetValue(source, out var sender))
                                at = AnchorTime(sender, ParseDeliverySeq(deliverySeq));
                        }
                        else
                        {
                            pairing = "inferred";
                            link["key"] = Key("r", lane.Id, incoming.Seq, incoming.Part);
                            if (lanes.TryGetValue(source, out var sender) && sentAt is double time)
                                at = InferSend(sender, lane.Id, incoming, time, from);
                        }
                        link["pairing"] = pairing;
                        from["sessionId"] = Peer(source);
                        if (!lanes.ContainsKey(source))
                            from["outside"] = true;
                        from["at"] = at ?? sentAt ?? incoming.ConsumedAt;
                        link["from"] = from;
                        link["sentAt"] = at ?? sentAt ?? incoming.ConsumedAt;
                        break;
                    }
                    case "inter-agent" or "task":
                        // Task notifications made by an authenticated user have no source Session.
                        link["kind"] = incoming.Type == "task" ? "task" : "message";
                        link["key"] = Key("r", lane.Id, incoming.Seq, incoming.Part);
                        link["from"] = new JsonObject
                        {
                            ["lane"] = "user",
                            ["at"] = sentAt ?? incoming.ConsumedAt,
                        };
                        link["sentAt"] = sentAt ?? incoming.ConsumedAt;
                        break;
                    case "toolscript":
                        continue;
                    default:
                    {
                        var kind = incoming.Type switch
                        {
                            "user" => "user",
                            "channel" => "channel",
                            "timer" => "timer",
                            _ => "event",
                        };
                        link["kind"] = kind;
                        link["key"] = Key("r", lane.Id, incoming.Seq, incoming.Part);
                        var from = new JsonObject
                        {
                            ["lane"] = kind switch
                            {
                                "user" => "user",
                                "channel" => "channel",
                                "timer" => "timer",
                                _ => "system",
                            },
                            ["at"] = sentAt ?? incoming.ConsumedAt,
                        };
                        var label =
                            attributes.GetValueOrDefault("sender")
                            ?? attributes.GetValueOrDefault("channelType")
                            ?? (kind == "event" ? incoming.Type : null);
                        if (label is not null)
                            from["label"] = label;
                        link["from"] = from;
                        link["sentAt"] = sentAt ?? incoming.ConsumedAt;
                        break;
                    }
                }
                links.Add(link);
            }
        }

        foreach (var lane in lanes.Values)
        {
            foreach (var sent in lane.Outgoing.Where(item => !item.Matched))
            {
                var target = Canonical(sent.Target) ?? sent.Target;
                var targetLoaded = lanes.TryGetValue(target, out var targetLane);
                if (
                    targetLoaded
                    && sent.DeliverySeq is not null
                    && targetLane!.Incoming.Any(item =>
                        item.Attributes.GetValueOrDefault("sourceSessionId") == lane.Id
                        && item.Attributes.GetValueOrDefault("deliverySeq") == sent.DeliverySeq
                    )
                )
                    continue;
                var from = new JsonObject
                {
                    ["lane"] = "session",
                    ["sessionId"] = lane.Id,
                    ["at"] = sent.At,
                    ["seq"] = sent.CallSeq ?? sent.Seq,
                    ["call"] = sent.Call,
                };
                if (sent.Sub is int sub)
                    from["sub"] = sub;
                var to = new JsonObject { ["sessionId"] = Peer(target) };
                if (!targetLoaded)
                    to["outside"] = true;
                var link = new JsonObject
                {
                    ["kind"] = "message",
                    ["key"] = sent.DeliverySeq is not null
                        ? Key("d", lane.Id, sent.DeliverySeq, Peer(target))
                        : Key("s", lane.Id, sent.Seq, sent.Call, sent.Sub, Peer(target)),
                    ["from"] = from,
                    ["to"] = to,
                    ["sentAt"] = sent.At,
                    ["preview"] = sent.Preview,
                    // Not in the loaded receiver history: still queued, or outside what was read.
                    ["state"] =
                        targetLoaded && targetLane!.Page is { HasMore: false }
                            ? "queued"
                            : "unread",
                };
                if (sent.DeliverySeq is not null)
                    link["deliverySeq"] = sent.DeliverySeq;
                links.Add(link);
            }
        }

        foreach (var lane in lanes.Values)
        {
            if (lane.Start is not { Parent: { } parent } start)
                continue;
            if (start.Kind is not ("new-child" or "history-inherited" or "user-child-created"))
                continue;
            var parentId = Canonical(parent) ?? parent;
            var from = new JsonObject
            {
                ["lane"] = start.Kind == "user-child-created" ? "user" : "session",
                ["sessionId"] = Peer(parentId),
                ["at"] = start.At,
            };
            var pairing = "inferred";
            if (start.Kind != "user-child-created" && lanes.TryGetValue(parentId, out var creator))
            {
                var call = creator
                    .Tools.Where(tool =>
                        tool.Name == "create_child_session"
                        && tool.Start - 1500 <= start.At
                        && start.At <= tool.End + 1500
                    )
                    .OrderBy(tool => Math.Abs(tool.Start - start.At))
                    .FirstOrDefault();
                if (call is not null)
                {
                    pairing = "exact";
                    from["at"] = call.Start;
                    from["seq"] = call.CallSeq ?? call.Seq;
                    from["call"] = call.Call;
                }
            }
            else if (!lanes.ContainsKey(parentId))
                from["outside"] = true;
            links.Add(
                new JsonObject
                {
                    ["kind"] = "spawn",
                    ["key"] = Key("c", lane.Id),
                    ["mode"] = start.Kind,
                    ["from"] = from,
                    ["to"] = new JsonObject
                    {
                        ["sessionId"] = lane.Id,
                        ["seq"] = start.Seq,
                        ["at"] = start.At,
                    },
                    ["sentAt"] = from["at"]!.DeepClone(),
                    ["consumedAt"] = start.At,
                    ["pairing"] = pairing,
                    ["preview"] = "",
                }
            );
        }
        return links;
    }

    private static double? AnchorTime(Lane sender, DeliveryAnchor? anchor)
    {
        if (anchor is null)
            return null;
        var tool = sender.Tools.FirstOrDefault(item =>
            item.CallSeq == anchor.Seq && item.Call == anchor.Call
        );
        if (tool is null)
            return null;
        if (anchor.SubCall is int n && n >= 1 && n <= tool.SubCalls.Count)
            return tool.SubCalls[n - 1].Start;
        return tool.Start;
    }

    // Older deliveries without deliverySeq: same source and target, a send time within the
    // wrapper's second-resolution time and a matching body preview.
    private static double? InferSend(
        Lane sender,
        string target,
        Incoming incoming,
        double wrapperTime,
        JsonObject from
    )
    {
        if (incoming.Type == "inter-agent")
        {
            var candidate = sender
                .Outgoing.Where(item =>
                    !item.Matched
                    && item.DeliverySeq is null
                    && item.Target == target
                    && Math.Abs(item.At - wrapperTime) <= SendTolerance
                    && item.At <= incoming.ConsumedAt + 1000
                    && SamePreview(item.Preview, incoming.Preview)
                )
                .OrderBy(item => Math.Abs(item.At - wrapperTime))
                .FirstOrDefault();
            if (candidate is null)
                return null;
            candidate.Matched = true;
            from["seq"] = candidate.CallSeq ?? candidate.Seq;
            from["call"] = candidate.Call;
            if (candidate.Sub is int sub)
                from["sub"] = sub;
            return candidate.At;
        }
        var tool = sender
            .Tools.Where(item =>
                item.Name is "task" or "create_child_session"
                && item.Start - 1500 <= wrapperTime
                && wrapperTime <= item.End + 1500
            )
            .OrderBy(item => Math.Abs(item.Start - wrapperTime))
            .FirstOrDefault();
        if (tool is null)
            return null;
        from["seq"] = tool.CallSeq ?? tool.Seq;
        from["call"] = tool.Call;
        return tool.Start;
    }

    private static bool SamePreview(string sent, string received)
    {
        if (sent.Length == 0 || received.Length == 0)
            return true;
        var length = Math.Min(80, Math.Min(sent.Length, received.Length));
        return string.CompareOrdinal(sent, 0, received, 0, length) == 0;
    }

    private JsonArray Sessions(
        IReadOnlyList<string> order,
        Dictionary<string, Lane> lanes,
        Visibility? visibility
    )
    {
        var projections = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in order.Chunk(100))
        foreach (var row in runtime.Projections(chunk.ToArray()))
            if (SessionCatalog.Text(row["id"]) is { } id)
                projections[id] = row;
        var result = new JsonArray();
        foreach (var id in order)
        {
            var lane = lanes[id];
            projections.TryGetValue(id, out var row);
            var item = new JsonObject { ["id"] = id };
            if (row is not null)
            {
                var safe = visibility?.Session(row) ?? row;
                foreach (
                    var key in new[]
                    {
                        "displayName",
                        "agent",
                        "busy",
                        "queueLength",
                        "runtimeState",
                        "lastMessageTime",
                        "archived",
                        "runtime",
                    }
                )
                    if (safe[key] is { } value)
                        item[key] = value.DeepClone();
                if (SessionCatalog.Text(row["parentSessionId"]) is { } parent)
                    item["parentSessionId"] =
                        visibility is null || visibility.Allows(parent)
                            ? parent
                            : visibility.Opaque(parent);
            }
            if (lane.Page is { } page)
            {
                if (page.Rows.Count > 0)
                {
                    item["firstSeq"] = page.Rows[0].Seq;
                    item["lastSeq"] = page.Rows[^1].Seq;
                    item["firstAt"] = page.Rows[0].Timestamp;
                }
                if (page.MaxSeq is long max)
                    item["maxSeq"] = max;
                item["truncated"] = page.TruncatedStart;
                item["hasMore"] = page.HasMore;
            }
            if (lane.Start is { } start)
            {
                item["startedAt"] = start.At;
                item["startKind"] = start.Kind;
            }
            result.Add(item);
        }
        return result;
    }

    // Endpoints referenced by links that were not loaded as lanes.
    private JsonArray Peers(JsonArray links, Dictionary<string, Lane> lanes, Visibility? visibility)
    {
        var ids = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var link in links.OfType<JsonObject>())
        foreach (var side in new[] { link["from"], link["to"] })
            if (
                SessionCatalog.Text(side?["sessionId"]) is { } id
                && !lanes.ContainsKey(id)
                && seen.Add(id)
            )
                ids.Add(id);
        var result = new JsonArray();
        var known = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        if (visibility is null)
            foreach (var chunk in ids.Take(200).Chunk(100))
            foreach (var row in runtime.Projections(chunk.ToArray()))
                if (SessionCatalog.Text(row["id"]) is { } id)
                    known[id] = row;
        foreach (var id in ids)
        {
            var item = new JsonObject { ["id"] = id };
            if (visibility is not null && !visibility.Allows(id))
                item["opaque"] = true;
            else if (known.TryGetValue(id, out var row))
            {
                if (row["displayName"] is { } name)
                    item["displayName"] = name.DeepClone();
                if (row["agent"] is { } agent)
                    item["agent"] = agent.DeepClone();
            }
            result.Add(item);
        }
        return result;
    }

    private JsonObject Tasks(JsonArray links)
    {
        var ids = links
            .OfType<JsonObject>()
            .Select(link => SessionCatalog.Text(link["taskId"]))
            .OfType<string>()
            .Distinct(StringComparer.Ordinal)
            .Take(100)
            .ToArray();
        return ids.Length == 0 ? new JsonObject() : runtime.Manager.Tasks.Summaries(ids);
    }
}
