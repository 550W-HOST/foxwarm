using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// Approval requests of tool calls that matched an ask rule. Records live beside question
/// records in <c>meta.questions.approvals</c> and share its revision. A pending record always
/// belongs to a live waiter in this process; a restart expires it and nothing is replayed.
/// </summary>
internal static class SessionApprovals
{
    internal const int MaxPending = 32;
    internal const int RetainedResolved = 20;
    internal const int MaxArgsBytes = 16 * 1024;
    internal const int MaxArgsPreviewLength = 4000;
    internal const int MaxNoteLength = 2000;
    internal const long UnattendedTimeoutSeconds = 60 * 60;

    internal static readonly string[] Statuses =
    [
        "pending",
        "approved",
        "rejected",
        "expired",
        "cancelled",
    ];

    internal static JsonObject[] Records(JsonObject meta) =>
        (meta["questions"]?["approvals"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];

    internal static JsonObject[] Pending(JsonObject meta) =>
        Records(meta).Where(record => Status(record) == "pending").ToArray();

    internal static JsonObject? Find(JsonObject meta, string id) =>
        Records(meta).FirstOrDefault(record => SessionWait.Text(record["id"]) == id);

    internal static string Status(JsonObject record) =>
        SessionWait.Text(record["status"]) ?? "pending";

    internal static string NewId() => "ap-" + Guid.NewGuid().ToString("N")[..10];

    internal static void Add(JsonObject meta, JsonObject record)
    {
        var container = SessionQuestions.Container(meta);
        if (container["approvals"] is not JsonArray approvals)
            container["approvals"] = approvals = new JsonArray();
        approvals.Add(record);
        SessionQuestions.Touch(meta);
    }

    /// <summary>Moves one pending record to a final state; the first transition wins.</summary>
    internal static bool Resolve(
        JsonObject meta,
        string id,
        string status,
        JsonObject decidedBy,
        string? note = null
    )
    {
        var record = Find(meta, id);
        if (record is null || Status(record) != "pending")
            return false;
        record["status"] = status;
        record["decidedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        record["decidedBy"] = decidedBy.DeepClone();
        if (!string.IsNullOrWhiteSpace(note))
            record["note"] = note.Trim();
        SessionQuestions.Touch(meta);
        return true;
    }

    /// <summary>Expires every pending record of a Session loaded after a restart.</summary>
    internal static JsonObject[] ExpireStale(JsonObject meta)
    {
        var stale = Pending(meta);
        foreach (var record in stale)
            Resolve(
                meta,
                SessionWait.Text(record["id"])!,
                "expired",
                new JsonObject { ["kind"] = "system", ["reason"] = "restart" }
            );
        return stale;
    }

    internal static string NotPendingMessage(JsonObject meta, string id) =>
        Find(meta, id) is { } record
            ? $"Approval {id} is no longer pending; it was {Status(record)}."
            : $"Approval {id} does not exist in this Session.";

    /// <summary>Removes old resolved records, keeping every pending one.</summary>
    internal static void Prune(JsonObject container)
    {
        if (container["approvals"] is not JsonArray approvals)
            return;
        var resolved = approvals
            .OfType<JsonObject>()
            .Where(record => Status(record) != "pending")
            .ToArray();
        foreach (var stale in resolved.Take(Math.Max(0, resolved.Length - RetainedResolved)))
            approvals.Remove(stale);
    }

    internal static void Validate(JsonObject container)
    {
        if (!container.ContainsKey("approvals"))
            return;
        if (container["approvals"] is not JsonArray approvals)
            throw SessionAuthorityErrors.Invalid("Approval state must be an array.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in approvals)
            if (
                node is not JsonObject record
                || SessionWait.Text(record["id"]) is not { Length: > 0 } id
                || !ids.Add(id)
                || !Statuses.Contains(SessionWait.Text(record["status"]))
                || record["tool"] is not JsonObject tool
                || SessionWait.Text(tool["source"]) is null
                || SessionWait.Text(tool["name"]) is null
            )
                throw SessionAuthorityErrors.Invalid("Invalid approval record.");
    }
}
