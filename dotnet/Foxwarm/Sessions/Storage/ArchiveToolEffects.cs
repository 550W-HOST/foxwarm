using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Persistence;
using Foxwarm.Tools;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

/// <summary>
/// One indexed tool effect: a direct call (<c>Sub = 0</c>) or a ToolScript subcall of a Session
/// tool row, or a direct record of an effect that never reaches a Session Archive.
/// </summary>
internal sealed record ToolEffectRow(
    string? SessionId,
    long Seq,
    int Part,
    int Sub,
    string? Agent,
    long StartedAt,
    double? DurationMs,
    string Origin,
    string Tool,
    string? Source,
    string? Server,
    string? Node,
    string? Action,
    string Outcome,
    string? ErrorType,
    string? Approval,
    string? Approver,
    string? Rules,
    string? Summary,
    long? AnchorSeq,
    long? InputSeq,
    string? InitiatorKind,
    string? InitiatorId,
    string? RunId,
    string? Principal,
    string? Refs
);

/// <summary>Who started the turn of a call, as far as the Archive records it.</summary>
internal sealed record ToolEffectInitiator(long Seq, string Kind, string? Id);

/// <summary>
/// Derived index of tool effects recorded in Session Archive rows. The Archive row is the
/// authority: index rows are written with it under their own savepoint, removed with an
/// uncommitted row, and rebuilt by the activity backfill when missing. Nothing here may fail or
/// delay an Archive write beyond its own small inserts.
/// </summary>
internal static class ArchiveToolEffects
{
    internal const string Table = "archive_tool_effects";
    internal const string DirectTable = "archive_direct_effects";
    internal const string MetadataTable = "archive_effects_metadata";
    internal const string LowKey = "low";
    internal const string HighKey = "high";
    internal const string VersionKey = "version";

    // A shape change bumps this; the backfill then rebuilds every derived row.
    internal const long Version = 1;

    private const int MaxSummary = 200;
    private const int MaxAction = 40;
    private const int MaxRules = 1000;
    private const int MaxRefs = 1000;
    private const int MaxText = 200;

    internal const string Columns =
        "agent,started_at,duration_ms,origin,tool,source,server,node,action,outcome,error_type,approval,approver,rules,summary,anchor_seq,input_seq,initiator_kind,initiator_id,run_id,principal,refs";

    // Additive and cheap on any Archive size: the tables start empty, so their own indexes are
    // the only work. Older readers ignore them.
    internal const string SchemaSql = $"""
        CREATE TABLE IF NOT EXISTS {Table}(
          session_id TEXT NOT NULL,seq INTEGER NOT NULL,part INTEGER NOT NULL,sub INTEGER NOT NULL,
          agent TEXT,started_at INTEGER NOT NULL,duration_ms REAL,origin TEXT NOT NULL,tool TEXT NOT NULL,
          source TEXT,server TEXT,node TEXT,action TEXT,outcome TEXT NOT NULL,error_type TEXT,
          approval TEXT,approver TEXT,rules TEXT,summary TEXT,anchor_seq INTEGER,input_seq INTEGER,
          initiator_kind TEXT,initiator_id TEXT,run_id TEXT,principal TEXT,refs TEXT,
          PRIMARY KEY(session_id,seq,part,sub));
        CREATE INDEX IF NOT EXISTS idx_{Table}_time ON {Table}(started_at);
        CREATE INDEX IF NOT EXISTS idx_{Table}_node ON {Table}(node,started_at);
        CREATE INDEX IF NOT EXISTS idx_{Table}_tool ON {Table}(tool,started_at);
        CREATE TABLE IF NOT EXISTS {DirectTable}(
          id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,
          agent TEXT,started_at INTEGER NOT NULL,duration_ms REAL,origin TEXT NOT NULL,tool TEXT NOT NULL,
          source TEXT,server TEXT,node TEXT,action TEXT,outcome TEXT NOT NULL,error_type TEXT,
          approval TEXT,approver TEXT,rules TEXT,summary TEXT,anchor_seq INTEGER,input_seq INTEGER,
          initiator_kind TEXT,initiator_id TEXT,run_id TEXT,principal TEXT,refs TEXT);
        CREATE INDEX IF NOT EXISTS idx_{DirectTable}_time ON {DirectTable}(started_at);
        CREATE TABLE IF NOT EXISTS {MetadataTable}(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
        """;

    internal static void InitializeSchema(
        SqliteConnection connection,
        SqliteTransaction? transaction
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = SchemaSql;
        command.ExecuteNonQuery();
    }

    internal static bool TableExists(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string table
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT 1 FROM sqlite_master WHERE type='table' AND name=$name";
        command.Parameters.AddWithValue("$name", table);
        return command.ExecuteScalar() is not null;
    }

    private static string? Text(JsonNode? value) => SessionWait.Text(value);

    private static string? Bounded(string? value, int length) =>
        value is null ? null
        : value.Length > length ? value[..(length - 1)] + "…"
        : value;

    private static string? Compact(JsonNode? value, int length)
    {
        if (value is null)
            return null;
        var text = EcmaJson.Stringify(value);
        return text.Length > length ? null : text;
    }

    private static long Milliseconds(JsonNode? value, long fallback) =>
        SessionWait.Number(value) is double number && double.IsFinite(number) && number > 0
            ? (long)number
            : fallback;

    private static string? Approver(JsonNode? decidedBy) =>
        decidedBy is not JsonObject value ? null
        : Text(value["kind"]) is "identity" ? "identity:" + Text(value["id"])
        : Text(value["kind"]);

    private static string Outcome(JsonNode? response, string? approval)
    {
        if (response is JsonObject value)
        {
            if (
                value["canceled"] is JsonValue canceled
                && canceled.TryGetValue<bool>(out var flag)
                && flag
            )
                return "cancelled";
            if (value["error"] is JsonObject error)
                return Text(error["type"]) switch
                {
                    "tool_authorization_denied" => "denied",
                    "tool_approval_rejected" => "approval-rejected",
                    "tool_approval_expired" or "tool_approval_unavailable" => "approval-expired",
                    "tool_call_skipped" => "skipped",
                    _ => "error",
                };
            if (value["error"] is not null)
                return "error";
        }
        return approval is "rejected" ? "approval-rejected" : "ok";
    }

    // Old rows without a recorded target still name the wrapped tool of call_tool.
    private static (string Name, string? Source, string? Server) Wrapped(
        string name,
        JsonObject? args
    )
    {
        if (name != "call_tool" || args is null)
            return (name, null, null);
        if (Text(args["toolId"]) is { } id)
        {
            var colon = id.IndexOf(':');
            if (colon > 0)
            {
                var rest = id[(colon + 1)..];
                var slash = rest.LastIndexOf('/');
                return (
                    slash >= 0 ? rest[(slash + 1)..] : rest,
                    id[..colon],
                    slash > 0 && id[..colon] == "mcp" ? rest[..slash] : null
                );
            }
        }
        return Text(args["name"]) is { } wrapped
            ? (wrapped, Text(args["source"]), Text(args["server"]))
            : (name, null, null);
    }

    private static string? Refs(JsonObject? meta, JsonObject? subcall)
    {
        var refs = new JsonObject();
        if (meta?["resolvedPaths"] is JsonArray paths)
        {
            var resolved = new JsonArray(
                paths
                    .Take(5)
                    .Select(path => Text(path?["resolved"]) ?? Text(path?["raw"]))
                    .OfType<string>()
                    .Select(path => (JsonNode?)Bounded(path, MaxText))
                    .ToArray()
            );
            if (resolved.Count > 0)
                refs["paths"] = resolved;
        }
        var exec = (subcall ?? meta)?["exec"] as JsonObject;
        if (Text(exec?["execId"]) is { } execId)
            refs["execId"] = execId;
        if (Text(exec?["cwd"]) is { } cwd)
            refs["cwd"] = Bounded(cwd, MaxText);
        var deliveries = new List<JsonObject>();
        if (subcall?["sessionMessage"] is JsonObject delivery)
            deliveries.Add(delivery);
        else if (subcall is null && meta?["sessionMessages"] is JsonArray messages)
            deliveries.AddRange(messages.OfType<JsonObject>().Take(5));
        var targets = new JsonArray();
        foreach (var item in deliveries)
            if (Text(item["targetSessionId"]) is { } target)
            {
                var value = new JsonObject { ["sessionId"] = target };
                if (SessionWait.Number(item["deliverySeq"]) is not null)
                    value["deliverySeq"] = item["deliverySeq"]!.DeepClone();
                targets.Add(value);
            }
        if (targets.Count > 0)
            refs["deliveries"] = targets;
        return refs.Count == 0 ? null : Compact(refs, MaxRefs);
    }

    private static string? Node(JsonObject? target, JsonObject? exec, JsonObject? meta) =>
        Text(target?["node"])
        ?? Text(exec?["nodeId"])
        ?? Text((meta?["resolvedPaths"] as JsonArray)?.FirstOrDefault()?["nodeId"]);

    /// <summary>Tool rows of one Archive message, with the model row whose calls they answer.</summary>
    internal static IReadOnlyList<ToolEffectRow> FromToolMessage(
        string sessionId,
        string agent,
        long seq,
        double timestamp,
        JsonObject tool,
        JsonObject? anchor,
        long? anchorSeq,
        ToolEffectInitiator? initiator,
        string origin = "model"
    )
    {
        var rows = new List<ToolEffectRow>();
        if (tool["parts"] is not JsonArray parts)
            return rows;
        var calls = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var part in (anchor?["parts"] as JsonArray ?? []).OfType<JsonObject>())
            if (part["functionCall"] is JsonObject call && Text(call["id"]) is { } id)
                calls.TryAdd(id, call);
        var fallback = (long)timestamp;
        for (var index = 0; index < parts.Count; index++)
        {
            if (parts[index]?["functionResponse"] is not JsonObject response)
                continue;
            var name = Text(response["name"]) ?? "unknown";
            var callArgs =
                Text(response["tool_use_id"]) is { } callId
                && calls.TryGetValue(callId, out var call)
                    ? call["args"] as JsonObject
                    : null;
            var meta = response["__meta"] as JsonObject;
            var target = meta?["target"] as JsonObject;
            var exec = meta?["exec"] as JsonObject;
            var approval = meta?["approval"] as JsonObject;
            var timing = response["executionTiming"] as JsonObject;
            var wrapped = Wrapped(name, callArgs);
            var toolName = Text(target?["name"]) ?? wrapped.Name;
            var innerArgs =
                name == "call_tool" ? callArgs?["args"] as JsonObject ?? callArgs : callArgs;
            var startedAt = Milliseconds(timing?["startedAt"], fallback);
            var approvalStatus = Text(approval?["status"]);
            rows.Add(
                new(
                    sessionId,
                    seq,
                    index,
                    0,
                    agent,
                    startedAt,
                    SessionWait.Number(timing?["durationMs"]),
                    origin,
                    toolName,
                    Text(target?["source"]) ?? wrapped.Source,
                    Text(target?["server"]) ?? wrapped.Server,
                    Node(target, exec, meta),
                    Bounded(Text(innerArgs?["action"]), MaxAction),
                    Outcome(response["response"], approvalStatus),
                    Bounded(Text(response["response"]?["error"]?["type"]), MaxText),
                    approvalStatus,
                    Approver(approval?["decidedBy"]),
                    Compact(target?["rules"], MaxRules),
                    innerArgs is null
                        ? null
                        : Bounded(
                            SessionToolExecutor.ToolArgsPreview(toolName, innerArgs),
                            MaxSummary
                        ),
                    anchorSeq,
                    initiator?.Seq,
                    initiator?.Kind,
                    Bounded(initiator?.Id, MaxText),
                    null,
                    null,
                    Refs(meta, null)
                )
            );
            var sub = 0;
            foreach (
                var subcall in (meta?["toolScriptSubCalls"] as JsonArray ?? []).OfType<JsonObject>()
            )
                rows.Add(
                    FromSubCall(
                        subcall,
                        ++sub,
                        sessionId,
                        seq,
                        index,
                        agent,
                        startedAt,
                        origin,
                        anchorSeq,
                        initiator,
                        null
                    )
                );
        }
        return rows;
    }

    /// <summary>One ToolScript subcall record as an effect row.</summary>
    internal static ToolEffectRow FromSubCall(
        JsonObject subcall,
        int sub,
        string? sessionId,
        long seq,
        int part,
        string? agent,
        long fallback,
        string origin,
        long? anchorSeq,
        ToolEffectInitiator? initiator,
        string? runId
    )
    {
        var target = subcall["target"] as JsonObject;
        var exec = subcall["exec"] as JsonObject;
        var rules = target?["rules"] as JsonArray;
        var denied = rules?.Any(rule => Text(rule?["effect"]) == "deny") == true;
        var status = Text(subcall["status"]);
        return new(
            sessionId,
            seq,
            part,
            sub,
            agent,
            Milliseconds(subcall["startedAt"], fallback),
            SessionWait.Number(subcall["durationMs"]),
            origin,
            Text(target?["name"]) ?? Text(subcall["name"]) ?? "unknown",
            Text(target?["source"]),
            Text(target?["server"]),
            Node(target, exec, null),
            null,
            denied ? "denied"
                : status is "failed" ? "error"
                : status is "running" ? "cancelled"
                : "ok",
            null,
            null,
            null,
            Compact(rules, MaxRules),
            Bounded(Text(subcall["argsSummary"]), MaxSummary),
            anchorSeq,
            initiator?.Seq,
            initiator?.Kind,
            Bounded(initiator?.Id, MaxText),
            runId,
            null,
            Refs(null, subcall)
        );
    }

    /// <summary>
    /// A call without a Session tool row: an unattended ToolScript call or an inbound MCP call.
    /// The summary must already be redacted by the caller.
    /// </summary>
    internal static ToolEffectRow FromDirectCall(
        string? sessionId,
        string? agent,
        string origin,
        long startedAt,
        JsonObject? target,
        string tool,
        JsonObject? exec,
        JsonNode? response,
        string? summary,
        ToolEffectInitiator? initiator,
        string? runId,
        string? principal,
        JsonObject? delivery = null,
        string? fallbackNode = null
    )
    {
        var subcall = new JsonObject();
        if (exec is not null)
            subcall["exec"] = exec.DeepClone();
        if (delivery is not null)
            subcall["sessionMessage"] = delivery.DeepClone();
        return new(
            sessionId,
            0,
            0,
            0,
            agent,
            startedAt,
            Math.Max(0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - startedAt),
            origin,
            Text(target?["name"]) ?? tool,
            Text(target?["source"]),
            Text(target?["server"]),
            Node(target, exec, null) ?? fallbackNode,
            null,
            Outcome(response, null),
            Bounded(Text(response?["error"]?["type"]), MaxText),
            null,
            null,
            Compact(target?["rules"], MaxRules),
            Bounded(summary, MaxSummary),
            null,
            null,
            initiator?.Kind,
            Bounded(initiator?.Id, MaxText),
            runId,
            principal,
            Refs(null, subcall)
        );
    }

    /// <summary>
    /// Classifies the input row that started a turn. Background notices are not initiators:
    /// the caller keeps looking further back for the input they followed.
    /// </summary>
    internal static ToolEffectInitiator? Initiator(long seq, JsonObject message)
    {
        if (message["__meta"]?["sender"] is JsonObject sender)
            return Text(sender["kind"]) == "identity"
                ? new(seq, "identity", Text(sender["id"]))
                : new(seq, "administrator", null);
        var first = (message["parts"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault();
        var text = Text(first?["system"]) ?? Text(first?["text"]);
        if (text is null)
            return new(seq, "user", null);
        var wrapper = SessionSequenceProjection.ParseWrapper(text);
        if (wrapper is null)
            return new(seq, "user", null);
        var attributes = wrapper.Attributes;
        string? Attribute(string name) => attributes.GetValueOrDefault(name);
        if (wrapper.Tag == "foxwarm-message")
            return Attribute("type") switch
            {
                "channel" when Attribute("channelInstanceId") is null => new(
                    seq,
                    "user",
                    Attribute("channelType")
                ),
                "channel" => new(
                    seq,
                    "channel",
                    Attribute("channelTargetId") ?? Attribute("channelInstanceId")
                ),
                "inter-agent" or "toolscript" => new(seq, "session", Attribute("sourceSessionId")),
                "task" when Attribute("sourceKind") == "user" => new(
                    seq,
                    "user",
                    Attribute("taskId")
                ),
                "task" => new(seq, "session", Attribute("sourceSessionId")),
                "timer" => new(seq, "timer", Attribute("timerId")),
                _ => null,
            };
        if (Attribute("kind") == "external-input" && Attribute("webhook") is { } webhook)
            return new(seq, "webhook", webhook);
        return null;
    }

    private const string InsertColumns = "session_id,seq,part,sub," + Columns;

    private static void Bind(SqliteCommand command, ToolEffectRow row, bool keyed)
    {
        command.Parameters.Clear();
        void Add(string name, object? value) =>
            command.Parameters.AddWithValue(name, value ?? DBNull.Value);
        Add("$session", row.SessionId);
        if (keyed)
        {
            Add("$seq", row.Seq);
            Add("$part", row.Part);
            Add("$sub", row.Sub);
        }
        Add("$agent", row.Agent);
        Add("$started", row.StartedAt);
        Add("$duration", row.DurationMs);
        Add("$origin", row.Origin);
        Add("$tool", row.Tool);
        Add("$source", row.Source);
        Add("$server", row.Server);
        Add("$node", row.Node);
        Add("$action", row.Action);
        Add("$outcome", row.Outcome);
        Add("$error", row.ErrorType);
        Add("$approval", row.Approval);
        Add("$approver", row.Approver);
        Add("$rules", row.Rules);
        Add("$summary", row.Summary);
        Add("$anchor", row.AnchorSeq);
        Add("$input", row.InputSeq);
        Add("$initiatorKind", row.InitiatorKind);
        Add("$initiatorId", row.InitiatorId);
        Add("$run", row.RunId);
        Add("$principal", row.Principal);
        Add("$refs", row.Refs);
    }

    private const string Values =
        "$agent,$started,$duration,$origin,$tool,$source,$server,$node,$action,$outcome,$error,$approval,$approver,$rules,$summary,$anchor,$input,$initiatorKind,$initiatorId,$run,$principal,$refs";

    internal static void Insert(
        SqliteConnection connection,
        SqliteTransaction transaction,
        IEnumerable<ToolEffectRow> rows
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            $"INSERT OR IGNORE INTO {Table}({InsertColumns}) VALUES($session,$seq,$part,$sub,{Values})";
        foreach (var row in rows)
        {
            Bind(command, row, keyed: true);
            command.ExecuteNonQuery();
        }
    }

    internal static void InsertDirect(
        SqliteConnection connection,
        SqliteTransaction transaction,
        ToolEffectRow row
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            $"INSERT INTO {DirectTable}(session_id,{Columns}) VALUES($session,{Values})";
        Bind(command, row, keyed: false);
        command.ExecuteNonQuery();
    }

    /// <summary>
    /// The nearest earlier model row of a Session and the turn's initiator. Reads only the
    /// Session's own rows through the primary key; at most a bounded number of rows back.
    /// </summary>
    internal static (long? AnchorSeq, JsonObject? Anchor, ToolEffectInitiator? Initiator) Context(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string sessionId,
        long seq,
        IReadOnlyDictionary<long, JsonObject>? pending = null
    )
    {
        JsonObject? Load(long target)
        {
            if (pending is not null && pending.TryGetValue(target, out var message))
                return message;
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                "SELECT message_json FROM archive_messages WHERE session_id=$session AND seq=$seq";
            command.Parameters.AddWithValue("$session", sessionId);
            command.Parameters.AddWithValue("$seq", target);
            return command.ExecuteScalar() is string json
                ? JsonNode.Parse(json) as JsonObject
                : null;
        }
        // Rows of the same uncommitted write come first (they are the newest); stored rows are
        // read lazily through the primary key and only the rows actually needed are parsed.
        IEnumerable<(long Seq, string Role)> Candidates()
        {
            var floor = long.MaxValue;
            foreach (
                var (pendingSeq, message) in (pending ?? new Dictionary<long, JsonObject>())
                    .Where(pair => pair.Key < seq)
                    .OrderByDescending(pair => pair.Key)
            )
                if (Text(message["role"]) is { } role)
                {
                    floor = pendingSeq;
                    yield return (pendingSeq, role);
                }
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                "SELECT seq,role FROM archive_messages WHERE session_id=$session AND seq<$seq ORDER BY seq DESC LIMIT $limit";
            command.Parameters.AddWithValue("$session", sessionId);
            command.Parameters.AddWithValue("$seq", Math.Min(seq, floor));
            command.Parameters.AddWithValue("$limit", ContextScan);
            using var reader = command.ExecuteReader();
            while (reader.Read())
                yield return (reader.GetInt64(0), reader.GetString(1));
        }
        long? anchorSeq = null;
        JsonObject? anchor = null;
        ToolEffectInitiator? background = null;
        foreach (var (candidate, role) in Candidates().Take(ContextScan))
        {
            if (anchorSeq is null)
            {
                if (role == "model")
                {
                    anchorSeq = candidate;
                    anchor = Load(candidate);
                }
                continue;
            }
            if (role != "user" || Load(candidate) is not { } input)
                continue;
            if (Initiator(candidate, input) is { } initiator)
                return (anchorSeq, anchor, initiator);
            background ??= new(candidate, "event", null);
        }
        return (anchorSeq, anchor, background);
    }

    // How far back a tool row looks for its model row and the input that started its turn.
    internal const int ContextScan = 200;

    /// <summary>
    /// Indexes the tool rows of one Archive write inside its transaction, isolated by a
    /// savepoint: an index failure (such as a removed table) rolls back only index rows and
    /// returns false, never failing the Archive rows. The covered range then advances over the
    /// written rows when everything before them is already covered.
    /// </summary>
    internal static bool TryRecordLive(
        SqliteConnection connection,
        SqliteTransaction transaction,
        IReadOnlyList<(ArchiveMessageRecord Record, long RowId)> inserted
    )
    {
        if (inserted.Count == 0)
            return true;
        void Execute(string sql)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = sql;
            command.ExecuteNonQuery();
        }
        Execute("SAVEPOINT archive_tool_effects_live");
        try
        {
            if (inserted.Any(item => item.Record.Role == "tool"))
            {
                var pending = inserted
                    .GroupBy(item => item.Record.SessionId)
                    .ToDictionary(
                        group => group.Key,
                        group =>
                            (IReadOnlyDictionary<long, JsonObject>)
                                group.ToDictionary(
                                    item => item.Record.Seq,
                                    item => item.Record.Message
                                )
                    );
                var rows = new List<ToolEffectRow>();
                foreach (var (record, _) in inserted)
                {
                    if (record.Role != "tool")
                        continue;
                    var context = Context(
                        connection,
                        transaction,
                        record.SessionId,
                        record.Seq,
                        pending[record.SessionId]
                    );
                    rows.AddRange(
                        FromToolMessage(
                            record.SessionId,
                            record.Agent,
                            record.Seq,
                            record.Timestamp,
                            record.Message,
                            context.Anchor,
                            context.AnchorSeq,
                            context.Initiator
                        )
                    );
                }
                Insert(connection, transaction, rows);
            }
            var first = inserted.Min(item => item.RowId);
            var last = inserted.Max(item => item.RowId);
            using (var advance = connection.CreateCommand())
            {
                advance.Transaction = transaction;
                advance.CommandText = $"""
                    UPDATE {MetadataTable} SET value=$last WHERE key='{HighKey}'
                      AND value>=(SELECT coalesce(max(rowid),0) FROM archive_messages WHERE rowid<$first)
                      AND value<$last
                    """;
                advance.Parameters.AddWithValue("$first", first);
                advance.Parameters.AddWithValue("$last", last);
                advance.ExecuteNonQuery();
            }
            Execute("RELEASE archive_tool_effects_live");
            return true;
        }
        catch (Exception)
        {
            Execute("ROLLBACK TO archive_tool_effects_live");
            Execute("RELEASE archive_tool_effects_live");
            return false;
        }
    }

    /// <summary>Removes index rows of Archive rows that are being rolled back.</summary>
    internal static void Remove(
        SqliteConnection connection,
        SqliteTransaction transaction,
        IEnumerable<ArchiveMessageRecord> records
    )
    {
        if (!TableExists(connection, transaction, Table))
            return;
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"DELETE FROM {Table} WHERE session_id=$session AND seq=$seq";
        var session = command.Parameters.Add("$session", SqliteType.Text);
        var seq = command.Parameters.Add("$seq", SqliteType.Integer);
        foreach (var record in records.Where(record => record.Role == "tool"))
        {
            session.Value = record.SessionId;
            seq.Value = record.Seq;
            command.ExecuteNonQuery();
        }
    }

    internal static long? ReadMetadata(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string key
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"SELECT value FROM {MetadataTable} WHERE key=$key";
        command.Parameters.AddWithValue("$key", key);
        var value = command.ExecuteScalar();
        return value is null or DBNull
            ? null
            : Convert.ToInt64(value, CultureInfo.InvariantCulture);
    }

    internal static void WriteMetadata(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string key,
        long value
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            $"INSERT INTO {MetadataTable}(key,value) VALUES($key,$value) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
        command.Parameters.AddWithValue("$key", key);
        command.Parameters.AddWithValue("$value", value);
        command.ExecuteNonQuery();
    }
}
