using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;
using static Foxwarm.Vector.VectorText;

namespace Foxwarm.Vector;

internal sealed class ArchiveSearchRebuildRequiredException(string message) : IOException(message);

// The optional FTS database is a derivative. It stores locators, never authoritative preview text.
internal sealed class ArchiveSearchIndex : IDisposable
{
    private readonly SqliteConnection db;
    internal Action? BeforeCheckpointWrite { get; set; }

    private ArchiveSearchIndex(SqliteConnection db) => this.db = db;

    internal static ArchiveSearchIndex Open(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var db = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Pooling = false,
                DefaultTimeout = 5,
            }.ToString()
        );
        try
        {
            db.Open();
            var result = new ArchiveSearchIndex(db);
            result.Execute(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;"
            );
            result.Initialize();
            return result;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private SqliteCommand Command(string sql, params object?[] values)
    {
        var command = db.CreateCommand();
        command.CommandText = sql;
        for (var index = 0; index < values.Length; index++)
            command.Parameters.AddWithValue("$p" + index, values[index] ?? DBNull.Value);
        return command;
    }

    private void Execute(string sql, params object?[] values)
    {
        using var command = Command(sql, values);
        command.ExecuteNonQuery();
    }

    private object? Scalar(string sql, params object?[] values)
    {
        using var command = Command(sql, values);
        var value = command.ExecuteScalar();
        return value is DBNull ? null : value;
    }

    private T Transaction<T>(Func<T> run)
    {
        Execute("BEGIN IMMEDIATE");
        try
        {
            var value = run();
            Execute("COMMIT");
            return value;
        }
        catch
        {
            try
            {
                Execute("ROLLBACK");
            }
            catch { }
            throw;
        }
    }

    private static string NormalizeSql(string text) =>
        Lower(Regex.Replace(text, @"\s+", " ").Trim().TrimEnd(';').Trim());

    private void RequireObject(string name, string type, bool exact, params string[] clauses)
    {
        using var command = Command("SELECT type,sql FROM sqlite_master WHERE name=$p0", name);
        using var reader = command.ExecuteReader();
        if (!reader.Read() || reader.GetString(0) != type)
            throw new ArchiveSearchRebuildRequiredException(
                "Archive search object " + name + " is incompatible."
            );
        var sql = NormalizeSql(reader.GetString(1));
        if (
            reader.Read()
            || clauses.Any(clause =>
                exact
                    ? sql != NormalizeSql(clause)
                    : !sql.Contains(NormalizeSql(clause), StringComparison.Ordinal)
            )
        )
            throw new ArchiveSearchRebuildRequiredException(
                "Archive search object " + name + " has an incompatible definition."
            );
    }

    private void RequireColumns(
        string table,
        params (string Name, string Type, int? Pk, int? NotNull)[] columns
    )
    {
        using var command = Command("PRAGMA table_info(" + table + ")");
        using var rows = command.ExecuteReader();
        var actual = new Dictionary<string, (string Type, int Pk, int NotNull)>(
            StringComparer.Ordinal
        );
        while (rows.Read())
            actual.Add(
                rows.GetString(1),
                (rows.GetString(2).ToUpperInvariant(), rows.GetInt32(5), rows.GetInt32(3))
            );
        foreach (var expected in columns)
            if (
                !actual.TryGetValue(expected.Name, out var found)
                || found.Type != expected.Type
                || expected.Pk is { } pk && found.Pk != pk
                || expected.NotNull is { } notNull && found.NotNull != notNull
            )
                throw new ArchiveSearchRebuildRequiredException(
                    "Archive search table "
                        + table
                        + " has incompatible column "
                        + expected.Name
                        + "."
                );
    }

    private void Initialize()
    {
        if (
            Scalar(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_search_metadata'"
            )
            is null
        )
        {
            Transaction(() =>
            {
                Execute(ArchiveSearchSchema.Tables);
                Execute(
                    ArchiveSearchSchema.Insert
                        + ";"
                        + ArchiveSearchSchema.Delete
                        + ";"
                        + ArchiveSearchSchema.Update
                        + ";"
                );
                foreach (
                    var (key, value) in new[]
                    {
                        ("schema_version", "1"),
                        ("normalizer_version", "2"),
                        ("build_generation", Guid.NewGuid().ToString()),
                    }
                )
                    Execute(
                        "INSERT INTO archive_search_metadata(key,value) VALUES($p0,$p1)",
                        key,
                        value
                    );
                return true;
            });
            return;
        }
        if (
            Convert.ToString(
                Scalar("SELECT value FROM archive_search_metadata WHERE key='schema_version'")
            ) != "1"
            || Convert.ToString(
                Scalar("SELECT value FROM archive_search_metadata WHERE key='normalizer_version'")
            ) != "2"
        )
            throw new ArchiveSearchRebuildRequiredException("Archive search DB requires rebuild.");
        RequireObject(
            "archive_search_metadata",
            "table",
            false,
            "key text primary key",
            "value text not null"
        );
        RequireObject(
            "archive_search_checkpoints",
            "table",
            false,
            "session_id text primary key",
            "raw_last_indexed_seq integer not null",
            "last_indexed_block_id integer not null"
        );
        RequireObject(
            "archive_search_documents",
            "table",
            false,
            "rowid integer primary key",
            "unique(session_id, memory_kind, source_key)",
            "check(memory_kind in ('raw', 'block', 'fact'))"
        );
        RequireObject(
            "archive_search_fts",
            "table",
            false,
            "create virtual table archive_search_fts using fts5",
            "content='archive_search_documents'",
            "content_rowid='rowid'",
            "tokenize='trigram case_sensitive 1'"
        );
        RequireObject("archive_search_documents_ai", "trigger", true, ArchiveSearchSchema.Insert);
        RequireObject("archive_search_documents_ad", "trigger", true, ArchiveSearchSchema.Delete);
        RequireObject("archive_search_documents_au", "trigger", true, ArchiveSearchSchema.Update);
        RequireColumns(
            "archive_search_metadata",
            ("key", "TEXT", 1, null),
            ("value", "TEXT", null, 1)
        );
        RequireColumns(
            "archive_search_checkpoints",
            ("session_id", "TEXT", 1, null),
            ("raw_last_indexed_seq", "INTEGER", null, 1),
            ("last_indexed_block_id", "INTEGER", null, 1),
            ("updated_at", "INTEGER", null, 1)
        );
        RequireColumns(
            "archive_search_documents",
            new[] { ("rowid", "INTEGER", (int?)1, (int?)null) }
                .Concat(
                    new[]
                    {
                        "session_id",
                        "agent",
                        "memory_kind",
                        "source_key",
                        "source_family",
                        "index_text",
                        "content_hash",
                    }.Select(name => (name, "TEXT", (int?)null, (int?)1))
                )
                .ToArray()
        );
        using var indexes = Command("PRAGMA index_list(archive_search_documents)");
        using var indexRows = indexes.ExecuteReader();
        var names = new List<string>();
        while (indexRows.Read())
            if (indexRows.GetInt32(2) == 1)
                names.Add(indexRows.GetString(1));
        indexRows.Close();
        var identity = false;
        foreach (var name in names)
        {
            using var columns = Command(
                "PRAGMA index_info(\""
                    + name.Replace("\"", "\"\"", StringComparison.Ordinal)
                    + "\")"
            );
            using var rows = columns.ExecuteReader();
            var fields = new List<string>();
            while (rows.Read())
                fields.Add(rows.GetString(2));
            identity |= string.Join(',', fields) == "session_id,memory_kind,source_key";
        }
        if (!identity)
            throw new ArchiveSearchRebuildRequiredException(
                "Archive search document identity is incompatible."
            );
    }

    internal string Generation =>
        Convert.ToString(
            Scalar("SELECT value FROM archive_search_metadata WHERE key='build_generation'")
        ) ?? "";

    internal ArchiveVectorCheckpoint Checkpoint(string id)
    {
        using var command = Command(
            "SELECT raw_last_indexed_seq,last_indexed_block_id,updated_at FROM archive_search_checkpoints WHERE session_id=$p0",
            id
        );
        using var row = command.ExecuteReader();
        return row.Read() ? new(row.GetInt64(0), 0, row.GetInt64(1), row.GetInt64(2)) : new();
    }

    private void Advance(string id, long raw, long block)
    {
        BeforeCheckpointWrite?.Invoke();
        Execute(
            """
            INSERT INTO archive_search_checkpoints(session_id,raw_last_indexed_seq,last_indexed_block_id,updated_at) VALUES($p0,$p1,$p2,$p3)
            ON CONFLICT(session_id) DO UPDATE SET raw_last_indexed_seq=max(archive_search_checkpoints.raw_last_indexed_seq,excluded.raw_last_indexed_seq),
            last_indexed_block_id=max(archive_search_checkpoints.last_indexed_block_id,excluded.last_indexed_block_id),updated_at=excluded.updated_at
            """,
            id,
            raw,
            block,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        );
    }

    private static readonly string[] Fields =
        "session_id,agent,memory_kind,source_key,source_family,seq,start_seq,end_seq,raw_start_seq,raw_end_seq,timestamp,block_id,block_level,index_text,content_hash,updated_at".Split(
            ','
        );

    private void Upsert(JsonObject row)
    {
        var normalized = ArchiveSearchText.IndexText(Text(row["text"]));
        if (normalized.Length == 0)
            throw new InvalidDataException(
                "Archive search documents require nonempty canonical text."
            );
        var kind = Text(row["memory_kind"]);
        if (
            kind is not ("raw" or "block" or "fact")
            || new[] { "session_id", "source_key", "source_family" }.Any(key =>
                Trim(Text(row[key])).Length == 0
            )
        )
            throw new InvalidDataException("Archive search document identity fields are required.");
        var value = (JsonObject)row.DeepClone();
        value["index_text"] = normalized;
        value["content_hash"] = Hash("1\0" + kind + "\0" + normalized);
        value["updated_at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var parameters = Fields.Select((field, index) => "$p" + index).ToArray();
        Execute(
            "INSERT INTO archive_search_documents("
                + string.Join(',', Fields)
                + ") VALUES("
                + string.Join(',', parameters)
                + ") ON CONFLICT(session_id,memory_kind,source_key) DO UPDATE SET "
                + string.Join(
                    ',',
                    Fields
                        .Where(field =>
                            field is not ("session_id" or "memory_kind" or "source_key")
                        )
                        .Select(field => field + "=excluded." + field)
                ),
            Fields
                .Select(field =>
                    value[field] is null ? null
                    : SessionWait.Text(value[field]) is { } text ? (object)text
                    : SessionWait.Number(value[field]) is { } number
                    && Math.Truncate(number) == number
                        ? (object)(long)number
                    : null
                )
                .ToArray()
        );
    }

    internal void Raw(string id, IReadOnlyList<JsonObject> documents, long seq) =>
        Transaction(() =>
        {
            if (
                documents.Any(row =>
                    Text(row["session_id"]) != id || Text(row["memory_kind"]) != "raw"
                )
            )
                throw new InvalidDataException("Raw archive search batch identity mismatch.");
            foreach (var row in documents)
                Upsert(row);
            Advance(id, seq, 0);
            return true;
        });

    internal void Blocks(
        string id,
        IReadOnlyList<(JsonObject Block, IReadOnlyList<JsonObject> Facts)> documents,
        long blockId
    ) =>
        Transaction(() =>
        {
            foreach (var (block, facts) in documents)
            {
                if (
                    Text(block["session_id"]) != id
                    || Text(block["memory_kind"]) != "block"
                    || SessionWait.Number(block["block_id"]) is null
                    || facts.Any(fact =>
                        Text(fact["session_id"]) != id
                        || Text(fact["memory_kind"]) != "fact"
                        || VectorRuntime.Number(fact["block_id"])
                            != VectorRuntime.Number(block["block_id"])
                        || Text(fact["source_family"]) != Text(block["source_family"])
                    )
                )
                    throw new InvalidDataException("Block archive search batch identity mismatch.");
                Execute(
                    "DELETE FROM archive_search_documents WHERE session_id=$p0 AND memory_kind='fact' AND block_id=$p1",
                    id,
                    VectorRuntime.Integer(block["block_id"])
                );
                Upsert(block);
                foreach (var fact in facts)
                    Upsert(fact);
            }
            Advance(id, 0, blockId);
            return true;
        });

    internal void Delete(string id, string? kind = null) =>
        Transaction(() =>
        {
            if (kind is null)
            {
                Execute("DELETE FROM archive_search_documents WHERE session_id=$p0", id);
                Execute("DELETE FROM archive_search_checkpoints WHERE session_id=$p0", id);
            }
            else
            {
                Execute(
                    "DELETE FROM archive_search_documents WHERE session_id=$p0 AND "
                        + (kind == "block" ? "memory_kind IN ('block','fact')" : "memory_kind=$p1"),
                    kind == "block" ? [id] : [id, kind]
                );
                Execute(
                    "UPDATE archive_search_checkpoints SET "
                        + (kind == "raw" ? "raw_last_indexed_seq" : "last_indexed_block_id")
                        + "=0,updated_at=$p1 WHERE session_id=$p0",
                    id,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                );
            }
            return true;
        });

    internal void Reset(string id, long raw = 0, long block = 0) =>
        Transaction(() =>
        {
            Execute("DELETE FROM archive_search_documents WHERE session_id=$p0", id);
            Execute(
                """
                INSERT INTO archive_search_checkpoints(session_id,raw_last_indexed_seq,last_indexed_block_id,updated_at) VALUES($p0,$p1,$p2,$p3)
                ON CONFLICT(session_id) DO UPDATE SET raw_last_indexed_seq=excluded.raw_last_indexed_seq,last_indexed_block_id=excluded.last_indexed_block_id,updated_at=excluded.updated_at
                """,
                id,
                Math.Max(0, raw),
                Math.Max(0, block),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            );
            return true;
        });

    internal string[] SessionIds()
    {
        using var command = Command(
            "SELECT session_id FROM archive_search_checkpoints UNION SELECT session_id FROM archive_search_documents ORDER BY session_id"
        );
        using var rows = command.ExecuteReader();
        var ids = new List<string>();
        while (rows.Read())
            ids.Add(rows.GetString(0));
        return ids.ToArray();
    }

    internal string Rename(string oldId, string newId) =>
        Transaction(() =>
        {
            long Count(string id) =>
                Convert.ToInt64(
                    Scalar(
                        "SELECT (SELECT count(*) FROM archive_search_documents WHERE session_id=$p0)+(SELECT count(*) FROM archive_search_checkpoints WHERE session_id=$p0)",
                        id
                    )
                );
            if (Count(oldId) == 0)
                return "missing";
            if (Count(newId) > 0)
                return "conflict";
            Execute(
                """
                UPDATE archive_search_documents SET session_id=$p0,source_family=CASE WHEN substr(source_family,1,length($p1)+1)=$p1||':' THEN $p0||substr(source_family,length($p1)+1) ELSE source_family END,
                updated_at=$p2 WHERE session_id=$p1
                """,
                newId,
                oldId,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            );
            Execute(
                "UPDATE archive_search_checkpoints SET session_id=$p0,updated_at=$p2 WHERE session_id=$p1",
                newId,
                oldId,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            );
            return "renamed";
        });

    internal IReadOnlyList<JsonObject> Query(string query, VectorSearchOptions? options, int limit)
    {
        var compiled = ArchiveSearchText.Compile(query);
        var scope = (options?.LineageSessions ?? [])
            .GroupBy(entry => Trim(entry.SessionId), StringComparer.Ordinal)
            .Select(group => new ArchiveVectorScope(
                group.Key,
                group
                    .Where(entry => entry.MaxMessageSeq.HasValue)
                    .Select(entry => entry.MaxMessageSeq)
                    .Min(),
                group
                    .Where(entry => entry.MaxBlockId.HasValue)
                    .Select(entry => entry.MaxBlockId)
                    .Min()
            ))
            .ToArray();
        var ids = (options?.SessionIds ?? [])
            .Where(id => id.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (
            scope.Length > 64
            || ids.Length > 64
            || scope.Length > 0 && ids.Length > 0
            || scope.Any(entry => entry.SessionId.Length == 0)
        )
            throw new InvalidDataException("Invalid Archive search Session scope.");
        var result = new List<JsonObject>();
        foreach (
            var (lane, expression) in new[]
            {
                ("identifier", compiled.IdentifierMatch),
                ("prose", compiled.ProseMatch),
            }
        )
        {
            if (expression is null)
                continue;
            var args = new List<object?> { expression };
            string Param(object? value)
            {
                args.Add(value);
                return "$p" + (args.Count - 1);
            }
            var predicates = new List<string> { "archive_search_fts MATCH $p0" };
            if (scope.Length > 0)
                predicates.Add(
                    "("
                        + string.Join(
                            " OR ",
                            scope.Select(entry =>
                                "(d.session_id="
                                + Param(entry.SessionId)
                                + " AND ((d.memory_kind='raw'"
                                + (entry.MaxMessageSeq is { } m ? " AND d.seq<=" + Param(m) : "")
                                + ") OR (d.memory_kind IN ('block','fact')"
                                + (entry.MaxBlockId is { } b ? " AND d.block_id<=" + Param(b) : "")
                                + ")))"
                            )
                        )
                        + ")"
                );
            else if (ids.Length > 0)
                predicates.Add(
                    "d.session_id IN (" + string.Join(',', ids.Select(id => Param(id))) + ")"
                );
            if (options?.Agent is { Length: > 0 } agent)
                predicates.Add("d.agent=" + Param(agent));
            var limitParameter = Param(Math.Clamp(limit, 1, 200));
            using var command = Command(
                """
                SELECT d.session_id,d.agent,d.memory_kind,d.source_key,d.source_family,d.seq,d.start_seq,d.end_seq,d.raw_start_seq,d.raw_end_seq,d.timestamp,d.block_id,d.block_level
                FROM archive_search_fts JOIN archive_search_documents d ON d.rowid=archive_search_fts.rowid WHERE
                """
                    + " "
                    + string.Join(" AND ", predicates)
                    + " ORDER BY bm25(archive_search_fts),d.rowid LIMIT "
                    + limitParameter,
                args.ToArray()
            );
            using var rows = command.ExecuteReader();
            var rank = 0;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            while (rows.Read())
            {
                var kind = rows.GetString(2);
                var family = rows.GetString(4);
                var row = new JsonObject
                {
                    ["id"] = $"fts:{kind}:{rows.GetString(0)}:{rows.GetString(3)}",
                    ["kind"] = kind == "raw" ? "raw" : "block",
                    ["session_id"] = rows.GetString(0),
                    ["agent"] = rows.GetString(1),
                    ["source_family"] = family,
                    ["lexical_lane"] = lane,
                    ["lexical_rank"] = rank,
                    ["lexical_score"] = Math.Max(1, 999 - rank++),
                };
                foreach (
                    var (name, column) in new[]
                    {
                        ("seq", 5),
                        ("start_seq", 6),
                        ("end_seq", 7),
                        ("raw_start_seq", 8),
                        ("raw_end_seq", 9),
                        ("timestamp", 10),
                        ("block_id", 11),
                        ("block_level", 12),
                    }
                )
                    if (!rows.IsDBNull(column))
                        row[name] = rows.GetInt64(column);
                if (seen.Add(family))
                    result.Add(row);
            }
        }
        return result;
    }

    internal void Maintenance()
    {
        Execute("PRAGMA wal_checkpoint(PASSIVE)");
        Execute("INSERT INTO archive_search_fts(archive_search_fts,rank) VALUES('merge',256)");
        Execute("PRAGMA optimize");
    }

    public void Dispose()
    {
        try
        {
            Execute("PRAGMA wal_checkpoint(TRUNCATE)");
        }
        catch { }
        db.Dispose();
    }
}
