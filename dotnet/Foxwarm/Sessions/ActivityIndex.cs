using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

/// <summary>Filters of an activity page. Times are Unix milliseconds; To is exclusive.</summary>
internal sealed record ActivityQuery(
    long? From = null,
    long? To = null,
    long? BeforeTime = null,
    string? BeforeKey = null,
    int Limit = 100,
    IReadOnlyCollection<string>? Sessions = null,
    string? ExecutionAgent = null,
    string? Node = null,
    string? Tool = null,
    string? Kind = "changes",
    string? Outcome = null,
    string? Initiator = null,
    string? Origin = null,
    string? Text = null
);

/// <summary>
/// Installation activity: who ran which tool, on which Node, with which effect. Owns the
/// background backfill of the derived Archive index, direct records of effects that never reach
/// a Session Archive, and filtered newest-first pages for System › Activity. Read-only
/// presentation; it never changes Archive rows, tool results or policy.
/// </summary>
internal sealed class ActivityIndex : IAsyncDisposable
{
    internal const int MaxLimit = 200;
    internal const int BackfillBatch = 500;
    private const int MaxScopedSessions = 20000;

    private readonly SessionManager manager;
    private readonly string path;
    private readonly object gate = new();
    private Task backfill = Task.CompletedTask;
    private CancellationToken stop = CancellationToken.None;
    private bool started;

    // Whether this process has checked the index for Sessions moved without it.
    private bool verified;
    private bool rerun;
    private int changePending;

    internal ActivityIndex(SessionManager manager)
    {
        this.manager = manager;
        path = Path.GetFullPath(manager.ArchiveDatabase);
        SqliteArchiveMessageStore.ToolEffectsRecorded += Recorded;
        SqliteArchiveMessageStore.ToolEffectsFailed += Failed;
    }

    /// <summary>Coalesced (at most about once a second) notice that activity changed.</summary>
    internal event Action? Changed;

    internal TimeSpan ChangeDelay { get; set; } = TimeSpan.FromSeconds(1);

    private void Recorded(string database)
    {
        if (database == path)
            NotifyChanged();
    }

    private void Failed(string database)
    {
        if (database == path)
            Repair();
    }

    private void NotifyChanged()
    {
        if (Interlocked.Exchange(ref changePending, 1) == 1)
            return;
        _ = Task.Delay(ChangeDelay)
            .ContinueWith(
                _ =>
                {
                    Volatile.Write(ref changePending, 0);
                    try
                    {
                        Changed?.Invoke();
                    }
                    catch
                    {
                        // Presentation listeners cannot affect recorded activity.
                    }
                },
                TaskScheduler.Default
            );
    }

    /// <summary>Starts the index backfill in the background after startup.</summary>
    internal void StartBackfill(CancellationToken stop)
    {
        lock (gate)
        {
            this.stop = stop;
            started = true;
        }
        Repair();
    }

    /// <summary>Runs (or reruns after the current pass) the backfill, which also repairs the index.</summary>
    private void Repair()
    {
        lock (gate)
        {
            if (!started || stop.IsCancellationRequested)
                return;
            if (!backfill.IsCompleted)
            {
                rerun = true;
                return;
            }
            backfill = Task.Run(RunBackfillAsync, CancellationToken.None);
        }
    }

    private async Task RunBackfillAsync()
    {
        while (true)
        {
            try
            {
                await BackfillAsync(stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(
                    "Activity index backfill stopped; it resumes at the next start: "
                        + MainLog.SafeFailure(error)
                );
                return;
            }
            lock (gate)
            {
                if (!rerun || stop.IsCancellationRequested)
                    return;
                rerun = false;
            }
        }
    }

    internal Task BackfillTask
    {
        get
        {
            lock (gate)
                return backfill;
        }
    }

    public async ValueTask DisposeAsync()
    {
        SqliteArchiveMessageStore.ToolEffectsRecorded -= Recorded;
        SqliteArchiveMessageStore.ToolEffectsFailed -= Failed;
        await BackfillTask.ConfigureAwait(false);
        await PendingDirect.ConfigureAwait(false);
    }

    private async Task<T> WriteAsync<T>(
        Func<SqliteConnection, SqliteTransaction, T> execute,
        CancellationToken token
    )
    {
        var receipt = await SqliteArchiveMessageStore
            .EnqueueWriteAsync(path, execute, token)
            .ConfigureAwait(false);
        return await receipt.Completion.ConfigureAwait(false);
    }

    private SqliteConnection OpenRead()
    {
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
                DefaultTimeout = 5,
            }.ToString()
        );
        connection.Open();
        return connection;
    }

    private static object? Scalar(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string sql,
        params (string Name, object Value)[] parameters
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        foreach (var (name, value) in parameters)
            command.Parameters.AddWithValue(name, value);
        return command.ExecuteScalar();
    }

    private static long Number(object? value) =>
        value is null or DBNull ? 0 : Convert.ToInt64(value, CultureInfo.InvariantCulture);

    /// <summary>
    /// Ensures the index and its checkpoints. The schema step drops an index of another shape or
    /// version; an index emptied while its checkpoints claim coverage also starts over, so the
    /// backfill rebuilds every derived row from the Archive. Only empty-table creation and small
    /// reads run on the writer here, so this costs the same on any Archive size.
    /// </summary>
    private Task<(long Low, long High)> PrepareAsync(CancellationToken token) =>
        WriteAsync(
            (connection, transaction) =>
            {
                ArchiveToolEffects.InitializeSchema(connection, transaction);
                if (
                    ArchiveToolEffects.ReadMetadata(
                        connection,
                        transaction,
                        ArchiveToolEffects.HighKey
                    )
                        is long covered
                    && ArchiveToolEffects.ReadMetadata(
                        connection,
                        transaction,
                        ArchiveToolEffects.LowKey
                    )
                        is long from
                    && Scalar(
                        connection,
                        transaction,
                        $"SELECT 1 FROM {ArchiveToolEffects.Table} LIMIT 1"
                    )
                        is null
                    && Scalar(
                        connection,
                        transaction,
                        "SELECT 1 FROM archive_messages WHERE rowid>=$low AND rowid<=$high AND role='tool' LIMIT 1",
                        ("$low", from),
                        ("$high", covered)
                    )
                        is not null
                )
                    Scalar(
                        connection,
                        transaction,
                        $"DELETE FROM {ArchiveToolEffects.MetadataTable} WHERE key IN ('{ArchiveToolEffects.LowKey}','{ArchiveToolEffects.HighKey}')"
                    );
                var top = Number(
                    Scalar(
                        connection,
                        transaction,
                        "SELECT coalesce(max(rowid),0) FROM archive_messages"
                    )
                );
                long Read(string key, long initial)
                {
                    if (ArchiveToolEffects.ReadMetadata(connection, transaction, key) is long value)
                        return value;
                    ArchiveToolEffects.WriteMetadata(connection, transaction, key, initial);
                    return initial;
                }
                // A fresh index covers nothing below the current newest row; rows written from
                // here on are indexed live and extend the covered range.
                var high = Read(ArchiveToolEffects.HighKey, top);
                var low = Read(ArchiveToolEffects.LowKey, high + 1);
                return (low, high);
            },
            token
        );

    /// <summary>
    /// Rebuilds missing index rows: first rows written while the index was not maintained
    /// (newer than the covered range, oldest first), then older history newest first. Reading
    /// and row preparation happen on a read connection; the writer only inserts prepared rows in
    /// batches, so Archive writes wait at most for one batch. Progress is checkpointed per batch
    /// and reruns are idempotent.
    /// </summary>
    internal async Task BackfillAsync(CancellationToken token, int batchSize = BackfillBatch)
    {
        if (!File.Exists(path))
            return;
        var (low, high) = await PrepareAsync(token).ConfigureAwait(false);
        using var source = OpenRead();
        if (!Volatile.Read(ref verified))
        {
            await RepairMovedAsync(source, token, batchSize).ConfigureAwait(false);
            Volatile.Write(ref verified, true);
        }
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var top = Number(
                Scalar(source, null, "SELECT coalesce(max(rowid),0) FROM archive_messages")
            );
            if (top <= high)
                break;
            var end = Math.Min(top, high + batchSize);
            var batch = ReadRows(
                source,
                "rowid>$a AND rowid<=$b",
                "ASC",
                null,
                ("$a", high),
                ("$b", end)
            );
            token.ThrowIfCancellationRequested();
            high = await WriteBatchAsync(batch.Rows, ArchiveToolEffects.HighKey, end, token)
                .ConfigureAwait(false);
        }
        while (low > 1)
        {
            token.ThrowIfCancellationRequested();
            var batch = ReadRows(source, "rowid<$a", "DESC", batchSize, ("$a", low));
            var next = batch.Scanned < batchSize ? 1 : batch.Lowest;
            token.ThrowIfCancellationRequested();
            await WriteBatchAsync(batch.Rows, ArchiveToolEffects.LowKey, next, token)
                .ConfigureAwait(false);
            low = next;
        }
    }

    private static (List<ToolEffectRow> Rows, int Scanned, long Lowest, long Highest) ReadRows(
        SqliteConnection connection,
        string range,
        string order,
        int? limit,
        params (string Name, object Value)[] parameters
    )
    {
        var records =
            new List<(
                long RowId,
                string Session,
                string Agent,
                long Seq,
                double Time,
                string Json
            )>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText =
                $"SELECT rowid,session_id,agent,seq,timestamp,message_json FROM archive_messages WHERE {range} AND role='tool' ORDER BY rowid {order}"
                + (limit is null ? "" : " LIMIT $limit");
            foreach (var (name, value) in parameters)
                command.Parameters.AddWithValue(name, value);
            if (limit is int count)
                command.Parameters.AddWithValue("$limit", count);
            using var reader = command.ExecuteReader();
            while (reader.Read())
                records.Add(
                    (
                        reader.GetInt64(0),
                        reader.GetString(1),
                        reader.GetString(2),
                        reader.GetInt64(3),
                        reader.GetDouble(4),
                        reader.GetString(5)
                    )
                );
        }
        var inference = new InitiatorInference(connection);
        var rows = new List<ToolEffectRow>();
        foreach (var record in records)
        {
            try
            {
                if (JsonNode.Parse(record.Json) is not JsonObject message)
                    continue;
                var (hasTarget, hasInitiator) = ArchiveToolEffects.SelfContained(message);
                rows.AddRange(
                    ArchiveToolEffects.FromToolMessage(
                        record.Session,
                        record.Agent,
                        record.Seq,
                        record.Time,
                        message,
                        hasTarget ? null : inference.Anchor(record.Session, record.Seq),
                        hasInitiator ? null : inference.Find(record.Session, record.Seq)
                    )
                );
            }
            catch (Exception error)
                when (error
                        is System.Text.Json.JsonException
                            or InvalidOperationException
                            or FormatException
                )
            {
                // An unreadable historical row stays out of the index; the Archive keeps it.
            }
        }
        return (
            rows,
            records.Count,
            records.Count == 0 ? 0 : records.Min(record => record.RowId),
            records.Count == 0 ? 0 : records.Max(record => record.RowId)
        );
    }

    /// <summary>
    /// Reads what tool rows written before calls recorded their target and initiator need:
    /// the model row they answer and the input that started their turn. Runs on the backfill's
    /// read connection, never in the Archive writer. Rows between a turn's input and a resolved
    /// tool row cannot hold another input, so each resolved span answers later lookups inside it
    /// and stops later scans that reach it. A batch reads each earlier row about once, and a long
    /// turn keeps its initiator however far back its input is.
    /// </summary>
    private sealed class InitiatorInference(SqliteConnection connection)
    {
        private readonly Dictionary<
            string,
            List<(long Low, long High, ToolEffectInitiator? Initiator)>
        > spans = new(StringComparer.Ordinal);

        private JsonObject? Load(string sql, string session, long seq)
        {
            using var command = connection.CreateCommand();
            command.CommandText = sql;
            command.Parameters.AddWithValue("$session", session);
            command.Parameters.AddWithValue("$seq", seq);
            return command.ExecuteScalar() is string json
                ? JsonNode.Parse(json) as JsonObject
                : null;
        }

        internal JsonObject? Anchor(string session, long seq) =>
            Load(
                "SELECT message_json FROM archive_messages WHERE session_id=$session AND seq<$seq AND role='model' ORDER BY seq DESC LIMIT 1",
                session,
                seq
            );

        internal ToolEffectInitiator? Find(string session, long seq)
        {
            if (!spans.TryGetValue(session, out var known))
                spans[session] = known = [];
            int Covering(long target) =>
                known.FindIndex(span => span.Low < target && target <= span.High);
            if (Covering(seq) is var hit and >= 0)
                return known[hit].Initiator;
            using var command = connection.CreateCommand();
            command.CommandText =
                "SELECT seq,role FROM archive_messages WHERE session_id=$session AND seq<$seq ORDER BY seq DESC";
            command.Parameters.AddWithValue("$session", session);
            command.Parameters.AddWithValue("$seq", seq);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var candidate = reader.GetInt64(0);
                if (Covering(candidate) is var span and >= 0)
                {
                    var (low, high, initiator) = known[span];
                    known[span] = (low, Math.Max(high, seq), initiator);
                    return initiator;
                }
                if (
                    reader.GetString(1) == "user"
                    && Load(
                        "SELECT message_json FROM archive_messages WHERE session_id=$session AND seq=$seq",
                        session,
                        candidate
                    )
                        is { } input
                    && TurnInitiator.FromInput(candidate, input) is { } found
                )
                {
                    known.Add((candidate, seq, found));
                    return found;
                }
            }
            known.Add((0, seq, null));
            return null;
        }
    }

    /// <summary>
    /// Re-indexes Sessions whose index rows still use an ID the Archive no longer has, as an
    /// identity move by a build without this index leaves them. Each stale ID that the catalog
    /// resolves to a current Session is replaced by that Session's rows; an unresolvable one is
    /// left as it is. Coverage is incomplete until this pass has run.
    /// </summary>
    private async Task RepairMovedAsync(
        SqliteConnection source,
        CancellationToken token,
        int batchSize
    )
    {
        var stale = new List<string>();
        using (var command = source.CreateCommand())
        {
            command.CommandText =
                $"SELECT DISTINCT session_id FROM {ArchiveToolEffects.Table} e WHERE NOT EXISTS (SELECT 1 FROM archive_messages m WHERE m.session_id=e.session_id)";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                stale.Add(reader.GetString(0));
        }
        if (stale.Count == 0)
            return;
        var moves = new List<(string From, string To)>();
        foreach (var chunk in stale.Chunk(200))
        foreach (var (id, resolution) in manager.Catalog.ResolveMany(chunk))
            if (
                SessionCatalog.Text(resolution["kind"]) is "exact" or "alias"
                && SessionCatalog.Text(resolution["sessionId"]) is { } current
                && current != id
                && Scalar(
                    source,
                    null,
                    "SELECT 1 FROM archive_messages WHERE session_id=$session LIMIT 1",
                    ("$session", current)
                )
                    is not null
            )
                moves.Add((id, current));
        foreach (var (from, to) in moves)
        {
            token.ThrowIfCancellationRequested();
            await WriteAsync(
                    (connection, transaction) =>
                        Scalar(
                            connection,
                            transaction,
                            $"DELETE FROM {ArchiveToolEffects.Table} WHERE session_id IN ($from,$to)",
                            ("$from", from),
                            ("$to", to)
                        ),
                    token
                )
                .ConfigureAwait(false);
            long after = 0;
            while (true)
            {
                var batch = ReadRows(
                    source,
                    "session_id=$session AND rowid>$a",
                    "ASC",
                    batchSize,
                    ("$session", to),
                    ("$a", after)
                );
                if (batch.Scanned == 0)
                    break;
                await WriteAsync(
                        (connection, transaction) =>
                        {
                            ArchiveToolEffects.Insert(connection, transaction, batch.Rows);
                            return true;
                        },
                        token
                    )
                    .ConfigureAwait(false);
                after = batch.Highest;
            }
        }
        NotifyChanged();
    }

    /// <summary>
    /// Inserts one prepared batch and moves its checkpoint in the same write. The high mark
    /// never moves backwards (live writes may already have extended it).
    /// </summary>
    private async Task<long> WriteBatchAsync(
        IReadOnlyList<ToolEffectRow> rows,
        string checkpoint,
        long value,
        CancellationToken token
    )
    {
        var result = await WriteAsync(
                (connection, transaction) =>
                {
                    ArchiveToolEffects.Insert(connection, transaction, rows);
                    var stored = ArchiveToolEffects.ReadMetadata(
                        connection,
                        transaction,
                        checkpoint
                    );
                    if (checkpoint == ArchiveToolEffects.LowKey || stored is null || stored < value)
                    {
                        ArchiveToolEffects.WriteMetadata(
                            connection,
                            transaction,
                            checkpoint,
                            value
                        );
                        return value;
                    }
                    return stored.Value;
                },
                token
            )
            .ConfigureAwait(false);
        if (rows.Count > 0)
            NotifyChanged();
        return result;
    }

    private Task pendingDirect = Task.CompletedTask;

    internal Task PendingDirect
    {
        get
        {
            lock (gate)
                return pendingDirect;
        }
    }

    /// <summary>
    /// Records an effect that has no Session Archive row: unattended ToolScript calls and
    /// inbound MCP calls. These rows are the only record of such effects and are not
    /// rebuildable. Recording never fails or delays the effect; a failure is logged.
    /// </summary>
    internal Task RecordDirectAsync(ToolEffectRow row)
    {
        Task write;
        lock (gate)
        {
            write = pendingDirect = pendingDirect
                .ContinueWith(
                    async _ =>
                    {
                        try
                        {
                            await WriteAsync(
                                    (connection, transaction) =>
                                    {
                                        ArchiveToolEffects.InitializeSchema(
                                            connection,
                                            transaction
                                        );
                                        ArchiveToolEffects.InsertDirect(
                                            connection,
                                            transaction,
                                            row
                                        );
                                        return true;
                                    },
                                    CancellationToken.None
                                )
                                .ConfigureAwait(false);
                            NotifyChanged();
                        }
                        catch (Exception error)
                        {
                            Console.Error.WriteLine(
                                "Activity record was not saved: " + MainLog.SafeFailure(error)
                            );
                        }
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.None,
                    TaskScheduler.Default
                )
                .Unwrap();
        }
        return write;
    }

    /// <summary>Prepares and records a direct row; preparing it can never fail the caller.</summary>
    internal void RecordDirect(Func<ToolEffectRow> prepare)
    {
        try
        {
            _ = RecordDirectAsync(prepare());
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Activity record was not saved: " + MainLog.SafeFailure(error));
        }
    }

    /// <summary>Whether every Archive row is indexed, and the oldest indexed time.</summary>
    internal JsonObject Coverage()
    {
        if (!File.Exists(path))
            return new JsonObject { ["complete"] = true, ["earliest"] = null };
        using var connection = OpenRead();
        if (!ArchiveToolEffects.TableExists(connection, null, ArchiveToolEffects.MetadataTable))
            return new JsonObject { ["complete"] = false, ["earliest"] = null };
        var low = ArchiveToolEffects.ReadMetadata(connection, null, ArchiveToolEffects.LowKey);
        var high = ArchiveToolEffects.ReadMetadata(connection, null, ArchiveToolEffects.HighKey);
        var top = Number(
            Scalar(connection, null, "SELECT coalesce(max(rowid),0) FROM archive_messages")
        );
        var earliest = ArchiveToolEffects.TableExists(connection, null, ArchiveToolEffects.Table)
            ? Scalar(
                connection,
                null,
                $"SELECT min(started_at) FROM (SELECT min(started_at) started_at FROM {ArchiveToolEffects.Table} UNION ALL SELECT min(started_at) FROM {ArchiveToolEffects.DirectTable})"
            )
            : null;
        return new JsonObject
        {
            ["complete"] =
                Volatile.Read(ref verified)
                && low is <= 1
                && high is long covered
                && covered >= top,
            ["earliest"] = earliest is null or DBNull ? null : Number(earliest),
        };
    }

    private static string Key(SqliteDataReader reader, bool direct) =>
        direct
            ? "d:" + reader.GetInt64(0).ToString("D19", CultureInfo.InvariantCulture)
            : "s:"
                + reader.GetString(1)
                + ":"
                + reader.GetInt64(2).ToString("D19", CultureInfo.InvariantCulture)
                + ":"
                + reader.GetInt64(3).ToString("D6", CultureInfo.InvariantCulture)
                + ":"
                + reader.GetInt64(4).ToString("D6", CultureInfo.InvariantCulture);

    /// <summary>
    /// One newest-first page. Each table is read through its time index with the same filters
    /// and merged here, so a page costs indexed range reads, not an Archive scan.
    /// </summary>
    internal JsonObject Query(ActivityQuery query)
    {
        var limit = Math.Clamp(query.Limit, 1, MaxLimit);
        var rows = new List<(long Time, string Key, JsonObject Row)>();
        if (File.Exists(path))
        {
            using var connection = OpenRead();
            if (ArchiveToolEffects.TableExists(connection, null, ArchiveToolEffects.Table))
                foreach (var direct in new[] { false, true })
                    rows.AddRange(Read(connection, query, direct, limit + 1));
        }
        var ordered = rows.OrderByDescending(row => row.Time)
            .ThenByDescending(row => row.Key, StringComparer.Ordinal)
            .Take(limit + 1)
            .ToList();
        var hasMore = ordered.Count > limit;
        if (hasMore)
            ordered.RemoveAt(ordered.Count - 1);
        var sessionIds = ordered
            .Select(row => SessionWait.Text(row.Row["sessionId"]))
            .OfType<string>()
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var owners = manager.Usage.DescribeSessions(sessionIds);
        var titles = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (
            var row in manager.Catalog.GetMany(
                owners.Values.Select(owner => owner.CurrentId).OfType<string>().Distinct().ToArray()
            )
        )
            titles[SessionCatalog.Text(row["id"])!] = row;
        var items = new JsonArray();
        foreach (var (_, key, row) in ordered)
        {
            if (
                SessionWait.Text(row["sessionId"]) is { } id
                && owners.TryGetValue(id, out var owner)
            )
            {
                row["currentSessionId"] = owner.CurrentId;
                row["currentAgent"] = owner.Agent;
                row["deleted"] = owner.CurrentId is null;
                if (owner.CurrentId is { } current && titles.TryGetValue(current, out var session))
                    row["title"] =
                        SessionCatalog.Text(session["title"])
                        ?? SessionCatalog.Text(session["name"]);
            }
            row["key"] = key;
            items.Add(row);
        }
        var last = ordered.LastOrDefault();
        return new JsonObject
        {
            ["items"] = items,
            ["hasMore"] = hasMore,
            ["next"] = hasMore
                ? new JsonObject { ["beforeTime"] = last.Time, ["beforeKey"] = last.Key }
                : null,
            ["coverage"] = Coverage(),
        };
    }

    private IEnumerable<(long Time, string Key, JsonObject Row)> Read(
        SqliteConnection connection,
        ActivityQuery query,
        bool direct,
        int limit
    )
    {
        var table = direct ? ArchiveToolEffects.DirectTable : ArchiveToolEffects.Table;
        var keyExpression = direct
            ? "'d:'||printf('%019d',id)"
            : "'s:'||session_id||':'||printf('%019d',seq)||':'||printf('%06d',part)||':'||printf('%06d',sub)";
        var terms = new List<string>();
        using var command = connection.CreateCommand();
        void Term(string sql, string name, object value)
        {
            terms.Add(sql);
            command.Parameters.AddWithValue(name, value);
        }
        if (query.From is long from)
            Term("started_at>=$from", "$from", from);
        if (query.To is long to)
            Term("started_at<$to", "$to", to);
        if (query.BeforeTime is long beforeTime && query.BeforeKey is { } beforeKey)
        {
            command.Parameters.AddWithValue("$beforeKey", beforeKey);
            Term(
                $"(started_at<$beforeTime OR started_at=$beforeTime AND {keyExpression}<$beforeKey)",
                "$beforeTime",
                beforeTime
            );
        }
        if (query.Sessions is { } sessions)
            Term(
                "session_id IN (SELECT value FROM json_each($sessions))",
                "$sessions",
                new JsonArray(sessions.Select(id => (JsonNode?)id).ToArray()).ToJsonString()
            );
        if (query.ExecutionAgent is { } agent)
            Term("agent=$agent", "$agent", agent);
        if (query.Node is { } node)
            Term("node=$node", "$node", node);
        if (query.Tool is { } tool)
            Term("tool=$tool", "$tool", tool);
        if (query.Kind is "changes")
            terms.Add(
                $"({ActivityKinds.Sql}) NOT IN ({string.Join(',', ActivityKinds.Quiet.Select(kind => "'" + kind + "'"))})"
            );
        else if (query.Kind is { } kind and not "all")
            Term($"({ActivityKinds.Sql})=$kind", "$kind", kind);
        if (query.Outcome is "problems")
            terms.Add("outcome<>'ok'");
        else if (query.Outcome is { } outcome)
            Term("outcome=$outcome", "$outcome", outcome);
        if (query.Initiator is { } initiator)
            Term("initiator_kind=$initiator", "$initiator", initiator);
        if (query.Origin is { } origin)
            Term("origin=$origin", "$origin", origin);
        if (query.Text is { Length: > 0 } text)
            Term(
                "(instr(lower(coalesce(summary,'')),lower($text))>0 OR instr(lower(tool),lower($text))>0)",
                "$text",
                text
            );
        var indexed =
            !direct && query.Sessions is { } scoped
                ? $" INDEXED BY {ScopedIndex(connection, scoped, limit)}"
                : "";
        command.CommandText =
            $"SELECT {(direct ? "id,NULL,0,0,0" : "0,session_id,seq,part,sub")},{ArchiveToolEffects.Columns},session_id FROM {table}{indexed}"
            + (terms.Count > 0 ? " WHERE " + string.Join(" AND ", terms) : "")
            + $" ORDER BY started_at DESC,{keyExpression} DESC LIMIT $limit";
        command.Parameters.AddWithValue("$limit", limit);
        using var reader = command.ExecuteReader();
        var columns = ArchiveToolEffects.Columns.Split(',');
        var result = new List<(long, string, JsonObject)>();
        while (reader.Read())
        {
            string? Text(int index) => reader.IsDBNull(index) ? null : reader.GetString(index);
            long? Integer(int index) => reader.IsDBNull(index) ? null : reader.GetInt64(index);
            var at = 5;
            int Column(string name) => at + Array.IndexOf(columns, name);
            var source = Text(Column("source"));
            var toolName = Text(Column("tool"))!;
            var action = Text(Column("action"));
            var row = new JsonObject
            {
                ["sessionId"] = Text(reader.FieldCount - 1),
                ["seq"] = direct ? null : reader.GetInt64(2),
                ["sub"] = direct ? null : reader.GetInt64(4),
                ["agent"] = Text(Column("agent")),
                ["startedAt"] = reader.GetInt64(Column("started_at")),
                ["durationMs"] = reader.IsDBNull(Column("duration_ms"))
                    ? null
                    : reader.GetDouble(Column("duration_ms")),
                ["origin"] = Text(Column("origin")),
                ["tool"] = toolName,
                ["source"] = source,
                ["server"] = Text(Column("server")),
                ["node"] = Text(Column("node")),
                ["action"] = action,
                ["kind"] = ActivityKinds.Of(source, toolName, action),
                ["outcome"] = Text(Column("outcome")),
                ["errorType"] = Text(Column("error_type")),
                ["approval"] = Text(Column("approval")),
                ["approver"] = Text(Column("approver")),
                ["rules"] = Text(Column("rules")) is { } rules ? JsonNode.Parse(rules) : null,
                ["summary"] = Text(Column("summary")),
                ["initiator"] = Text(Column("initiator_kind")) is { } initiatorKind
                    ? new JsonObject
                    {
                        ["kind"] = initiatorKind,
                        ["id"] = Text(Column("initiator_id")),
                        ["from"] = Text(Column("initiator_from")),
                        ["seq"] = Integer(Column("input_seq")),
                    }
                    : null,
                ["runId"] = Text(Column("run_id")),
                ["refs"] = Text(Column("refs")) is { } refs ? JsonNode.Parse(refs) : null,
            };
            result.Add((reader.GetInt64(Column("started_at")), Key(reader, direct), row));
        }
        return result;
    }

    /// <summary>
    /// Chooses how to read a Session-scoped page. Reading the scope's own rows and sorting them
    /// costs about their number; walking the time index costs about limit × total / scoped
    /// rows until a page is found. Both counts come from indexes.
    /// </summary>
    private static string ScopedIndex(
        SqliteConnection connection,
        IReadOnlyCollection<string> sessions,
        int limit
    )
    {
        var total = Number(
            Scalar(connection, null, $"SELECT max(rowid) FROM {ArchiveToolEffects.Table}")
        );
        using var command = connection.CreateCommand();
        command.CommandText =
            $"SELECT count(*) FROM {ArchiveToolEffects.Table} WHERE session_id IN (SELECT value FROM json_each($sessions))";
        command.Parameters.AddWithValue(
            "$sessions",
            new JsonArray(sessions.Select(id => (JsonNode?)id).ToArray()).ToJsonString()
        );
        var scoped = Number(command.ExecuteScalar());
        return scoped * scoped <= (long)limit * Math.Max(total, 1)
            ? $"sqlite_autoindex_{ArchiveToolEffects.Table}_1"
            : $"idx_{ArchiveToolEffects.Table}_time";
    }

    /// <summary>
    /// Session IDs currently owned by an Agent, or one Session and its descendants. A scope
    /// larger than a filter can carry is refused rather than silently cut short.
    /// </summary>
    internal IReadOnlyCollection<string> AgentSessions(string agent)
    {
        var ids = manager
            .Catalog.OffsetPage(MaxScopedSessions + 1, 0, agent: agent)
            .Select(row => SessionCatalog.Text(row["id"]))
            .OfType<string>()
            .ToArray();
        if (ids.Length > MaxScopedSessions)
            throw new ArgumentException(TooManySessions);
        return ids;
    }

    internal IReadOnlyCollection<string> TreeSessions(string root)
    {
        var ids = manager
            .Catalog.Descendants(root, MaxScopedSessions)
            .Rows.Select(row => SessionCatalog.Text(row["id"]))
            .OfType<string>()
            .Prepend(root)
            .ToArray();
        if (ids.Length > MaxScopedSessions)
            throw new ArgumentException(TooManySessions);
        return ids;
    }

    internal const string TooManySessions =
        "Too many Sessions to filter by. Narrow the filter, for example to one Session or to the Agent a call ran in.";
}
