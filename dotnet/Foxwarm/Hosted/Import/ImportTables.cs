using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Foxwarm.Hosted.Postgres;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Hosted.Import;

/// <summary>
/// A file-mode SQLite table whose hosted table holds the same rows: the hosted schema keeps the
/// file store's columns (plan §5), adding only <c>tenant_id</c> and columns with defaults. Used
/// where the hosted store has no path for writing existing rows. <paramref name="Keys"/> is the
/// primary key, the order both sides are hashed in; <paramref name="Identity"/> names an identity
/// column whose stored values are kept, so its sequence is advanced past them afterwards.
/// <paramref name="Mapped"/> fills hosted columns from a source expression (an identity column
/// kept from SQLite's <c>rowid</c>). With <paramref name="ParentColumn"/>, rows are written
/// parents first, for a self-referencing foreign key.
/// </summary>
internal sealed record ImportTable(
    string Source,
    string Target,
    string[] Keys,
    string? Identity = null,
    bool OverridingSystemValue = false,
    string? Where = null,
    IReadOnlyDictionary<string, string>? Mapped = null,
    string? ParentColumn = null
)
{
    internal string Name => Target;
}

/// <summary>Row count and hash of one table on each side, over the columns both have.</summary>
internal sealed record TableVerification(
    string Table,
    IReadOnlyList<string> Columns,
    long SourceRows,
    string SourceSha256,
    long ImportedRows,
    string ImportedSha256,
    IReadOnlyDictionary<string, long> SourceOnlyColumns
)
{
    internal bool Equal => SourceRows == ImportedRows && SourceSha256 == ImportedSha256;
}

/// <summary>
/// Copies and hashes file-mode SQLite rows into their hosted tables through <see cref="TenantDb"/>.
/// Each batch is one fenced transaction of one multi-row insert, bounded in rows and bytes so it
/// stays well inside the transaction helper's statement timeout. Values are converted to the
/// hosted column's type before both inserting and hashing, so the two hashes compare the same
/// values; row encoding is a JSON array per row in key order (<see cref="RowHash"/>).
/// </summary>
internal static class ImportTables
{
    private const int MaxRowsPerBatch = 1000;
    private const long MaxBytesPerBatch = 4L * 1024 * 1024;

    internal sealed record Columns(IReadOnlyList<(string Name, string Type)> Shared, IReadOnlyDictionary<string, long> SourceOnly);

    internal static IReadOnlyList<(string Name, string Type)> TargetColumns(TenantDb database, string table) =>
        database.Read(tx =>
        {
            using var command = tx.Command(
                "SELECT column_name::text, data_type::text FROM information_schema.columns"
                    + " WHERE table_schema = current_schema() AND table_name = $1 AND column_name <> 'tenant_id'"
                    + " ORDER BY ordinal_position",
                table
            );
            using var reader = command.ExecuteReader();
            var columns = new List<(string, string)>();
            while (reader.Read())
                columns.Add((reader.GetString(0), reader.GetString(1)));
            return columns;
        });

    internal static Columns ResolveColumns(SqliteConnection source, TenantDb database, ImportTable table)
    {
        var target = TargetColumns(database, table.Target);
        if (target.Count == 0)
            throw new InvalidOperationException($"The hosted schema has no table {table.Target}.");
        var sourceColumns = SourceColumns(source, table.Source);
        var shared = target
            .Where(column => sourceColumns.Contains(column.Name) || table.Mapped?.ContainsKey(column.Name) == true)
            .ToList();
        var sourceOnly = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var column in sourceColumns.Where(name => target.All(item => item.Name != name)))
            sourceOnly[column] = Count(source, $"SELECT count(*) FROM {table.Source} WHERE {Quote(column)} IS NOT NULL");
        return new Columns(shared, sourceOnly);
    }

    internal static bool SourceHas(SqliteConnection source, string table)
    {
        using var command = source.CreateCommand();
        command.CommandText = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name";
        command.Parameters.AddWithValue("$name", table);
        return command.ExecuteScalar() is not null;
    }

    internal static long Count(SqliteConnection source, string sql)
    {
        using var command = source.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    internal static long CountRows(SqliteConnection source, ImportTable table) =>
        SourceHas(source, table.Source)
            ? Count(source, $"SELECT count(*) FROM {table.Source}" + (table.Where is null ? "" : " WHERE " + table.Where))
            : 0;

    /// <summary>
    /// Copies every source row and returns the source side's count and hash. A missing source
    /// table copies nothing.
    /// </summary>
    internal static (long Rows, string Sha256, Columns Columns) Copy(
        SqliteConnection source,
        TenantDb database,
        TenantDb owner,
        ImportTable table,
        CancellationToken token
    )
    {
        var columns = ResolveColumns(source, database, table);
        var hash = new RowHash();
        if (!SourceHas(source, table.Source))
            return (0, hash.Finish(), columns);
        var names = columns.Shared.Select(column => column.Name).ToArray();
        var batch = new List<object?[]>();
        long bytes = 0;
        long max = 0;
        var rows = SourceRows(source, table, columns.Shared);
        if (table.ParentColumn is { } parentColumn)
        {
            var all = rows.ToList();
            foreach (var row in all)
                hash.Add(row);
            rows = ParentsFirst(all, Array.IndexOf(names, table.Keys[0]), Array.IndexOf(names, parentColumn));
        }
        foreach (var row in rows)
        {
            token.ThrowIfCancellationRequested();
            if (table.ParentColumn is null)
                hash.Add(row);
            batch.Add(row);
            bytes += RowHash.Size(row);
            if (table.Identity is { } identity && row[Array.IndexOf(names, identity)] is long value)
                max = Math.Max(max, value);
            if (batch.Count >= MaxRowsPerBatch || bytes >= MaxBytesPerBatch)
            {
                Insert(database, table, names, batch);
                batch = [];
                bytes = 0;
            }
        }
        if (batch.Count > 0)
            Insert(database, table, names, batch);
        if (table.Identity is { } column && max > 0)
            AdvanceIdentity(owner, table.Target, column, max);
        return (hash.RowCount, hash.Finish(), columns);
    }

    /// <summary>Count and hash of the source rows over <paramref name="columns"/>.</summary>
    internal static (long Rows, string Sha256) HashSource(SqliteConnection source, ImportTable table, Columns columns)
    {
        var hash = new RowHash();
        if (SourceHas(source, table.Source))
            foreach (var row in SourceRows(source, table, columns.Shared))
                hash.Add(row);
        return (hash.RowCount, hash.Finish());
    }

    /// <summary>Count and hash of the imported rows over <paramref name="columns"/>, read in key order.</summary>
    internal static (long Rows, string Sha256) HashTarget(TenantDb database, ImportTable table, Columns columns) =>
        database.Read(
            tx =>
            {
                var hash = new RowHash();
                using var command = tx.Command(
                    "SELECT " + string.Join(", ", columns.Shared.Select(column => Quote(column.Name)))
                        + " FROM " + table.Target
                        + " ORDER BY " + string.Join(", ", table.Keys.Select(Quote))
                );
                using var reader = command.ExecuteReader();
                var row = new object?[columns.Shared.Count];
                while (reader.Read())
                {
                    for (var index = 0; index < row.Length; index++)
                        row[index] = reader.IsDBNull(index) ? null : Normalize(reader.GetValue(index), columns.Shared[index].Type);
                    hash.Add(row);
                }
                return (hash.RowCount, hash.Finish());
            },
            snapshot: true
        );

    internal static TableVerification Verify(SqliteConnection source, TenantDb database, ImportTable table)
    {
        var columns = ResolveColumns(source, database, table);
        var (sourceRows, sourceHash) = HashSource(source, table, columns);
        var (rows, hash) = HashTarget(database, table, columns);
        return new TableVerification(table.Target, columns.Shared.Select(column => column.Name).ToArray(), sourceRows, sourceHash, rows, hash, columns.SourceOnly);
    }

    private static IEnumerable<object?[]> SourceRows(SqliteConnection source, ImportTable table, IReadOnlyList<(string Name, string Type)> columns)
    {
        using var command = source.CreateCommand();
        command.CommandText =
            "SELECT " + string.Join(", ", columns.Select(column => table.Mapped?.GetValueOrDefault(column.Name) ?? Quote(column.Name)))
            + " FROM " + table.Source
            + (table.Where is null ? "" : " WHERE " + table.Where)
            + " ORDER BY " + string.Join(", ", table.Keys.Select(Quote));
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var row = new object?[columns.Count];
            for (var index = 0; index < row.Length; index++)
                row[index] = reader.IsDBNull(index) ? null : Normalize(reader.GetValue(index), columns[index].Type);
            yield return row;
        }
    }

    // Rows ordered by their depth below a root, keeping key order within a depth. A parent
    // that doesn't exist counts as a root; the hosted foreign key then refuses the row.
    private static List<object?[]> ParentsFirst(List<object?[]> rows, int id, int parent)
    {
        var parents = rows.ToDictionary(row => (string)row[id]!, row => row[parent] as string, StringComparer.Ordinal);
        int Depth(string key)
        {
            var depth = 0;
            for (var current = parents.GetValueOrDefault(key); current is not null && depth <= parents.Count; current = parents.GetValueOrDefault(current))
                depth++;
            return depth;
        }
        return rows.OrderBy(row => Depth((string)row[id]!)).ToList();
    }

    private static HashSet<string> SourceColumns(SqliteConnection source, string table)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        if (!SourceHas(source, table))
            return names;
        using var command = source.CreateCommand();
        command.CommandText = $"SELECT name FROM pragma_table_info('{table}')";
        using var reader = command.ExecuteReader();
        while (reader.Read())
            names.Add(reader.GetString(0));
        return names;
    }

    /// <summary>A value as the hosted column type holds it: integers as long, floating point as double.</summary>
    internal static object Normalize(object value, string type) =>
        type switch
        {
            "bigint" or "integer" or "smallint" => value switch
            {
                long number => number,
                int number => (long)number,
                short number => (long)number,
                double number when number == Math.Floor(number) => (long)number,
                _ => throw new InvalidDataException($"A {type} column holds a {value.GetType().Name} value."),
            },
            "double precision" or "real" => value switch
            {
                double number => number,
                float number => (double)number,
                long number => (double)number,
                int number => (double)number,
                _ => throw new InvalidDataException($"A {type} column holds a {value.GetType().Name} value."),
            },
            "boolean" => value switch
            {
                bool flag => flag,
                long number => number != 0,
                _ => throw new InvalidDataException($"A boolean column holds a {value.GetType().Name} value."),
            },
            "bytea" => value as byte[] ?? throw new InvalidDataException($"A bytea column holds a {value.GetType().Name} value."),
            "text" => value as string ?? throw new InvalidDataException($"A text column holds a {value.GetType().Name} value."),
            _ => throw new InvalidDataException($"Import doesn't copy {type} columns."),
        };

    private static void Insert(TenantDb database, ImportTable table, string[] names, List<object?[]> rows)
    {
        var sql = new System.Text.StringBuilder()
            .Append("INSERT INTO ").Append(table.Target)
            .Append(" (").Append(string.Join(", ", names.Select(Quote))).Append(')')
            .Append(table.OverridingSystemValue ? " OVERRIDING SYSTEM VALUE" : "")
            .Append(" VALUES ");
        var parameters = new List<object?>(rows.Count * names.Length);
        for (var row = 0; row < rows.Count; row++)
        {
            sql.Append(row == 0 ? "(" : ", (");
            for (var column = 0; column < names.Length; column++)
            {
                parameters.Add(rows[row][column]);
                sql.Append(column == 0 ? "$" : ", $").Append(parameters.Count.ToString(CultureInfo.InvariantCulture));
            }
            sql.Append(')');
        }
        var text = sql.ToString();
        var values = parameters.ToArray();
        // A lost COMMIT is resolved by the first row: the batch commits as a whole, and the
        // tenant held none of these keys before.
        var keyIndexes = table.Keys.Select(key => Array.IndexOf(names, key)).ToArray();
        var first = rows[0];
        database.Write(
            tx => tx.Execute(text, values),
            new PgWriteOptions(Verify: tx =>
                tx.Scalar(
                    "SELECT 1 FROM " + table.Target + " WHERE "
                        + string.Join(" AND ", table.Keys.Select((key, index) => Quote(key) + " = $" + (index + 1).ToString(CultureInfo.InvariantCulture))),
                    keyIndexes.Select(index => first[index]).ToArray()
                ) is not null
            )
        );
    }

    /// <summary>
    /// Moves an identity column's sequence past <paramref name="max"/>, never back. Sequences are
    /// shared by all tenants and owned by the migrating role, so this runs on its connection;
    /// the transaction helper still checks the import's lease first.
    /// </summary>
    internal static void AdvanceIdentity(TenantDb owner, string table, string column, long max) =>
        owner.Write(tx =>
            tx.Scalar(
                "SELECT setval(s::regclass, greatest($2, coalesce(pg_sequence_last_value(s::regclass), 0)), true)"
                    + " FROM pg_get_serial_sequence($1, $3) AS s",
                table,
                max,
                column
            )
        );

    internal static string Quote(string name) => "\"" + name.Replace("\"", "\"\"") + "\"";
}

/// <summary>
/// SHA-256 over rows, each encoded as a compact JSON array followed by a newline: integers as
/// numbers, floating point as <c>"d:"</c> plus its round-trip text, bytes as <c>"x:"</c> plus
/// hex, text as strings.
/// </summary>
internal sealed class RowHash
{
    private readonly IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
    private readonly MemoryStream buffer = new();

    internal long RowCount { get; private set; }

    internal void Add(IReadOnlyList<object?> row)
    {
        buffer.SetLength(0);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            foreach (var value in row)
                switch (value)
                {
                    case null:
                        writer.WriteNullValue();
                        break;
                    case long number:
                        writer.WriteNumberValue(number);
                        break;
                    case double number:
                        writer.WriteStringValue("d:" + number.ToString("R", CultureInfo.InvariantCulture));
                        break;
                    case bool flag:
                        writer.WriteBooleanValue(flag);
                        break;
                    case byte[] bytes:
                        writer.WriteStringValue("x:" + Convert.ToHexStringLower(bytes));
                        break;
                    case string text:
                        writer.WriteStringValue(text);
                        break;
                    default:
                        writer.WriteStringValue(Convert.ToString(value, CultureInfo.InvariantCulture));
                        break;
                }
            writer.WriteEndArray();
        }
        buffer.WriteByte((byte)'\n');
        hash.AppendData(buffer.GetBuffer(), 0, (int)buffer.Length);
        RowCount++;
    }

    internal string Finish() => Convert.ToHexStringLower(hash.GetHashAndReset());

    internal static long Size(IReadOnlyList<object?> row) =>
        row.Sum(value => value switch
        {
            string text => (long)text.Length * 2,
            byte[] bytes => bytes.Length,
            _ => 8L,
        });
}
