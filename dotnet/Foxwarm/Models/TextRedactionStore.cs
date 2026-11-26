using Microsoft.Data.Sqlite;

namespace Foxwarm.Models;

// The on-disk copy of a redactor's finished slot results and known originals, so a restarted
// process sends unchanged slots exactly as before and keeps masking the same known values.
// Formats, encryption and write coalescing are shared with every backend
// (TextRedactionRecordStore); this class keeps them in `state/text-redaction.sqlite`.
//
// The store is a cache. Reads that fail or find an invalid record are misses, writes happen
// in the background and a failed write only costs a later miss. Deleting the file returns to
// memory-only behaviour.
internal sealed partial class TextRedactionStore : TextRedactionRecordStore
{
    internal const string FileName = "text-redaction.sqlite";

    private readonly string path;
    private readonly object readGate = new();
    private readonly SqliteConnection reader;
    private readonly SqliteConnection writer;

    private TextRedactionStore(
        string path,
        byte[] key,
        TimeProvider clock,
        long slotLimit,
        long knownLimit
    )
        : base(key, clock, slotLimit, knownLimit)
    {
        this.path = path;
        writer = Connect(path);
        try
        {
            Prepare();
            reader = Connect(path);
        }
        catch
        {
            writer.Dispose();
            throw;
        }
    }

    internal string FilePath => path;

    // Opens or creates the store. A file that is not a usable database is only a cache, so it
    // is replaced once; any other failure leaves the redactor memory-only.
    internal static TextRedactionStore? Open(
        string path,
        byte[] key,
        long knownLimit,
        TimeProvider? clock = null,
        long slotLimit = DefaultSlotBytes
    )
    {
        if (key.Length < 64)
            throw new ArgumentException("Text redaction store key must have at least 64 bytes.");
        path = Path.GetFullPath(path);
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                return new TextRedactionStore(
                    path,
                    key,
                    clock ?? TimeProvider.System,
                    slotLimit,
                    knownLimit
                );
            }
            catch (SqliteException error) when (attempt == 0 && error.SqliteErrorCode is 11 or 26)
            {
                MainLog.Diagnostic(
                    "Text redaction store is unreadable and was recreated: "
                        + MainLog.SafeFailure(error),
                    failure: true
                );
                foreach (var suffix in new[] { "", "-wal", "-shm" })
                    File.Delete(path + suffix);
            }
            catch (Exception error)
            {
                MainLog.Diagnostic(
                    "Text redaction store is unavailable; results stay in memory only: "
                        + MainLog.SafeFailure(error),
                    failure: true
                );
                return null;
            }
        }
    }

    private static SqliteConnection Connect(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString()
        );
        try
        {
            connection.Open();
            // Losing the last commits on power failure only costs later misses.
            Execute(
                connection,
                null,
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000"
            );
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    private void Prepare()
    {
        using var transaction = writer.BeginTransaction(deferred: false);
        Execute(
            writer,
            transaction,
            """
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS slots(identity BLOB NOT NULL, slot BLOB NOT NULL, data BLOB NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(identity, slot)) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS slots_used ON slots(used);
            CREATE TABLE IF NOT EXISTS known(id BLOB PRIMARY KEY, data BLOB NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS known_seq ON known(seq);
            """
        );
        // Records sealed under another instance key or format can never be read again.
        var check = CheckValue();
        using (var command = writer.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "SELECT value FROM meta WHERE key='check'";
            if (command.ExecuteScalar() is not byte[] stored || !stored.SequenceEqual(check))
            {
                Execute(writer, transaction, "DELETE FROM slots; DELETE FROM known");
                using var update = writer.CreateCommand();
                update.Transaction = transaction;
                update.CommandText =
                    "INSERT OR REPLACE INTO meta(key, value) VALUES('check', $value)";
                update.Parameters.AddWithValue("$value", check);
                update.ExecuteNonQuery();
            }
        }
        slotEstimate = Estimate(transaction, "slots");
        knownEstimate = Estimate(transaction, "known");
        using (var command = writer.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "SELECT COALESCE(MAX(seq), 0) FROM known";
            knownSequence = Convert.ToInt64(command.ExecuteScalar());
        }
        transaction.Commit();
    }

    // Estimated bytes of a table: payloads plus keys and a fixed per-row overhead.
    private long Estimate(SqliteTransaction transaction, string table)
    {
        using var command = writer.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT COUNT(*), COALESCE(SUM(length(data)), 0) FROM " + table;
        using var rows = command.ExecuteReader();
        rows.Read();
        return rows.GetInt64(1) + rows.GetInt64(0) * (RowOverhead + 2 * IdBytes);
    }

    private protected override byte[]? ReadSlotData(byte[] identity, byte[] slot)
    {
        lock (readGate)
        {
            if (Disposed)
                return null;
            using var command = reader.CreateCommand();
            command.CommandText = "SELECT data FROM slots WHERE identity=$identity AND slot=$slot";
            command.Parameters.AddWithValue("$identity", identity);
            command.Parameters.AddWithValue("$slot", slot);
            return command.ExecuteScalar() as byte[];
        }
    }

    private protected override List<(byte[] Id, byte[] Data)> ReadKnownData()
    {
        var rows = new List<(byte[] Id, byte[] Data)>();
        lock (readGate)
        {
            if (Disposed)
                return rows;
            using var command = reader.CreateCommand();
            command.CommandText = "SELECT id, data FROM known ORDER BY seq";
            using var reading = command.ExecuteReader();
            while (reading.Read())
                rows.Add(((byte[])reading[0], (byte[])reading[1]));
        }
        return rows;
    }

    private protected override bool IsReadFailure(Exception error) =>
        error is SqliteException or InvalidOperationException;

    private protected override bool IsWriteFailure(Exception error) =>
        error is SqliteException or InvalidOperationException or IOException;

    private protected override void WriteBatch(IReadOnlyCollection<Write> batch, long today)
    {
        using var transaction = writer.BeginTransaction(deferred: false);
        foreach (var write in batch)
            Apply(transaction, write, today);
        if (slotEstimate > slotLimit)
            slotEstimate = Prune(transaction, "slots", "used", slotLimit);
        if (knownEstimate > knownLimit)
            knownEstimate = Prune(transaction, "known", "seq", knownLimit);
        transaction.Commit();
    }

    private void Apply(SqliteTransaction transaction, Write write, long today)
    {
        using var command = writer.CreateCommand();
        command.Transaction = transaction;
        var table = write.Known ? "known" : "slots";
        var where = write.Known ? "id=$id" : "identity=$identity AND slot=$id";
        if (!write.Known)
            command.Parameters.AddWithValue("$identity", write.Identity);
        command.Parameters.AddWithValue("$id", write.Id);
        if (write.Kind == Kind.Delete)
        {
            command.CommandText = "DELETE FROM " + table + " WHERE " + where;
            command.ExecuteNonQuery();
            return;
        }
        command.Parameters.AddWithValue("$used", write.Known ? NextKnownSequence() : today);
        if (write.Kind == Kind.Touch)
        {
            command.CommandText =
                "UPDATE "
                + table
                + " SET "
                + (write.Known ? "seq" : "used")
                + "=$used WHERE "
                + where;
            command.ExecuteNonQuery();
            return;
        }
        var data = Seal(write.Known, write.Identity, write.Id, write.Payload!);
        command.Parameters.AddWithValue("$data", data);
        var conflict = write.Replace ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
        command.CommandText = write.Known
            ? conflict + " INTO known(id, data, seq) VALUES($id, $data, $used)"
            : conflict
                + " INTO slots(identity, slot, data, used) VALUES($identity, $id, $data, $used)";
        if (command.ExecuteNonQuery() > 0)
        {
            var size = data.Length + RowOverhead + 2 * IdBytes;
            if (write.Known)
                knownEstimate += size;
            else
                slotEstimate += size;
        }
    }

    // Removes the least recently used rows until the table is within 90% of its limit.
    private long Prune(SqliteTransaction transaction, string table, string order, long limit)
    {
        var key = table == "known" ? "id" : "identity, slot";
        var target = limit / 10 * 9;
        var total = Estimate(transaction, table);
        while (total > target)
        {
            using var count = writer.CreateCommand();
            count.Transaction = transaction;
            count.CommandText = "SELECT COUNT(*) FROM " + table;
            var rows = Convert.ToInt64(count.ExecuteScalar());
            if (rows == 0)
                return 0;
            var remove = Math.Clamp(
                (long)Math.Ceiling((double)(total - target) * rows / total),
                1,
                rows
            );
            Execute(
                writer,
                transaction,
                $"DELETE FROM {table} WHERE ({key}) IN (SELECT {key} FROM {table} ORDER BY {order} LIMIT {remove})"
            );
            total = Estimate(transaction, table);
        }
        return total;
    }

    private static void Execute(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string sql
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private protected override void Close()
    {
        lock (readGate)
        {
            reader.Dispose();
            writer.Dispose();
        }
    }
}
