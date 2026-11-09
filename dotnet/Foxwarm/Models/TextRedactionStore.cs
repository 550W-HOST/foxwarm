using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Models;

// The on-disk copy of a redactor's finished slot results and known originals, so a restarted
// process sends unchanged slots exactly as before and keeps masking the same known values.
//
// Slot records hold only replaced ranges (offset, length, labels and whether the range was
// detected or literal-masked), never the slot text or placeholders: originals come from the
// slot text and placeholders are recomputed with the placeholder HMAC. Records are keyed by a
// keyed hash of the slot's cache digest together with a keyed fingerprint of the detection
// settings. Known originals are private values, so every record payload is encrypted with
// AES-GCM under a key derived from the instance key; without that key nothing can be read.
//
// The store is a cache. Reads that fail or find an invalid record are misses, writes happen
// in the background and a failed write only costs a later miss. Deleting the file returns to
// memory-only behaviour.
internal sealed class TextRedactionStore : IDisposable
{
    internal const string FileName = "text-redaction.sqlite";
    internal const long DefaultSlotBytes = 64L * 1024 * 1024;
    internal const int MaxPending = 65536;
    private const int FormatVersion = 1;
    private const int IdBytes = 16;
    private const int NonceBytes = 12;
    private const int TagBytes = 16;
    private const int RowOverhead = 64;

    // A record that would be larger is not persisted; the slot is detected again after a
    // restart.
    private const int MaxPayloadBytes = 1024 * 1024;

    // One replaced range as stored: offsets in the slot text for detected ranges and in the
    // detected form for literal ranges, as in the memory cache.
    internal readonly record struct Range(bool Literal, int Start, int Length, string[] Labels);

    private enum Kind
    {
        Put,
        Touch,
        Delete,
    }

    // A pending write. Payloads are plaintext until the writer seals them.
    private sealed record Write(
        Kind Kind,
        bool Known,
        byte[] Identity,
        byte[] Id,
        byte[]? Payload,
        bool Replace
    );

    private static readonly UTF8Encoding Strict = new(false, true);
    private readonly string path;
    private readonly byte[] encryptionKey;
    private readonly byte[] indexKey;
    private readonly TimeProvider clock;
    private readonly long slotLimit;
    private readonly long knownLimit;
    private readonly object readGate = new();
    private readonly SqliteConnection reader;
    private readonly object writeGate = new();
    private readonly SqliteConnection writer;
    private readonly object pendingGate = new();
    private Dictionary<string, Write> pending = new(StringComparer.Ordinal);
    private readonly Dictionary<TextRedactionOptions, byte[]> identities = new();
    private long slotEstimate;
    private long knownEstimate;
    private long knownSequence;
    private int scheduled;
    private bool disposed;
    private int reported;

    private TextRedactionStore(
        string path,
        byte[] key,
        TimeProvider clock,
        long slotLimit,
        long knownLimit
    )
    {
        this.path = path;
        encryptionKey = key[..32];
        indexKey = key[32..64];
        this.clock = clock;
        this.slotLimit = slotLimit;
        this.knownLimit = knownLimit;
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

    // Days since the Unix epoch. A record's last use is kept at this granularity, so an
    // entry used by every request is touched on disk at most once a day.
    internal long Today => clock.GetUtcNow().ToUnixTimeSeconds() / 86400;

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
        var check = Mac("check\0" + FormatVersion, []);
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

    // Finished results of one slot, or null when none is stored or the record is unreadable.
    internal Range[]? ReadSlot(TextRedactionOptions options, string digest)
    {
        var identity = Identity(options);
        var id = SlotId(digest);
        byte[]? data;
        try
        {
            lock (readGate)
            {
                if (disposed)
                    return null;
                using var command = reader.CreateCommand();
                command.CommandText =
                    "SELECT data FROM slots WHERE identity=$identity AND slot=$slot";
                command.Parameters.AddWithValue("$identity", identity);
                command.Parameters.AddWithValue("$slot", id);
                data = command.ExecuteScalar() as byte[];
            }
        }
        catch (Exception error) when (error is SqliteException or InvalidOperationException)
        {
            Report("read", error);
            return null;
        }
        if (data is null)
            return null;
        var ranges = Unseal(false, identity, id, data) is { } payload ? Slot(payload) : null;
        if (ranges is null)
            Enqueue(new(Kind.Delete, false, identity, id, null, false));
        return ranges;
    }

    // Removes a slot record whose ranges do not fit its slot text.
    internal void DeleteSlot(TextRedactionOptions options, string digest) =>
        Enqueue(new(Kind.Delete, false, Identity(options), SlotId(digest), null, false));

    // Every readable known original with its labels, least recently used first. Unreadable
    // records are removed.
    internal List<(string Original, string[] Labels)> ReadKnown()
    {
        var result = new List<(string, string[])>();
        var rows = new List<(byte[] Id, byte[] Data)>();
        try
        {
            lock (readGate)
            {
                if (disposed)
                    return result;
                using var command = reader.CreateCommand();
                command.CommandText = "SELECT id, data FROM known ORDER BY seq";
                using var reading = command.ExecuteReader();
                while (reading.Read())
                    rows.Add(((byte[])reading[0], (byte[])reading[1]));
            }
        }
        catch (Exception error) when (error is SqliteException or InvalidOperationException)
        {
            Report("read", error);
            return result;
        }
        foreach (var (id, data) in rows)
        {
            if (Unseal(true, [], id, data) is { } payload && Known(payload) is { } known)
                result.Add(known);
            else
                Enqueue(new(Kind.Delete, true, [], id, null, false));
        }
        return result;
    }

    internal void PutSlot(
        TextRedactionOptions options,
        string digest,
        TextRedactor.Found[] spans,
        TextRedactor.Found[] masked
    )
    {
        var payload = new MemoryStream();
        using (var output = new BinaryWriter(payload, Strict, leaveOpen: true))
        {
            output.Write((byte)FormatVersion);
            output.Write7BitEncodedInt(spans.Length + masked.Length);
            foreach (var span in spans)
                WriteRange(output, false, span);
            foreach (var span in masked)
                WriteRange(output, true, span);
        }
        if (payload.Length > MaxPayloadBytes)
            return;
        Enqueue(new(Kind.Put, false, Identity(options), SlotId(digest), payload.ToArray(), false));
    }

    internal void TouchSlot(TextRedactionOptions options, string digest) =>
        Enqueue(new(Kind.Touch, false, Identity(options), SlotId(digest), null, false));

    internal void PutKnown(string placeholder, string original, string[] labels)
    {
        var payload = new MemoryStream();
        using (var output = new BinaryWriter(payload, Strict, leaveOpen: true))
        {
            output.Write((byte)FormatVersion);
            output.Write(original);
            WriteLabels(output, labels);
        }
        if (payload.Length > MaxPayloadBytes)
            return;
        Enqueue(new(Kind.Put, true, [], KnownId(placeholder), payload.ToArray(), true));
    }

    internal void TouchKnown(string placeholder) =>
        Enqueue(new(Kind.Touch, true, [], KnownId(placeholder), null, false));

    internal void DeleteKnown(string placeholder) =>
        Enqueue(new(Kind.Delete, true, [], KnownId(placeholder), null, false));

    // Coalesces writes per record: a delete wins over earlier writes, a put after a delete
    // replaces the record, the first put of a slot wins like the memory cache, and a touch
    // never overrides a pending put or delete. Beyond `MaxPending` new puts and touches are
    // dropped; they only cost later misses.
    private void Enqueue(Write write)
    {
        var key =
            (write.Known ? "k" : "s")
            + Convert.ToHexStringLower(write.Identity)
            + Convert.ToHexStringLower(write.Id);
        lock (pendingGate)
        {
            if (disposed)
                return;
            if (pending.TryGetValue(key, out var existing))
                write = (existing.Kind, write.Kind) switch
                {
                    (_, Kind.Delete) => write,
                    (Kind.Delete, Kind.Put) => write with { Replace = true },
                    (Kind.Put, Kind.Put) when !write.Known => existing,
                    (Kind.Put or Kind.Delete, Kind.Touch) => existing,
                    _ => write,
                };
            else if (pending.Count >= MaxPending && write.Kind != Kind.Delete)
                return;
            pending[key] = write;
        }
        if (Interlocked.Exchange(ref scheduled, 1) == 0)
            ThreadPool.QueueUserWorkItem(static store => store.Drain(), this, false);
    }

    private void Drain()
    {
        Volatile.Write(ref scheduled, 0);
        Flush();
    }

    // Writes the pending records in one transaction. A failure drops them; they become misses.
    internal void Flush()
    {
        lock (writeGate)
        {
            Dictionary<string, Write> batch;
            lock (pendingGate)
            {
                if (pending.Count == 0 || disposed)
                    return;
                batch = pending;
                pending = new(StringComparer.Ordinal);
            }
            try
            {
                using var transaction = writer.BeginTransaction(deferred: false);
                var today = Today;
                foreach (var write in batch.Values)
                    Apply(transaction, write, today);
                if (slotEstimate > slotLimit)
                    slotEstimate = Prune(transaction, "slots", "used", slotLimit);
                if (knownEstimate > knownLimit)
                    knownEstimate = Prune(transaction, "known", "seq", knownLimit);
                transaction.Commit();
            }
            catch (Exception error)
                when (error is SqliteException or InvalidOperationException or IOException)
            {
                Report("write", error);
            }
        }
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
        command.Parameters.AddWithValue("$used", write.Known ? ++knownSequence : today);
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

    private byte[] Seal(bool known, byte[] identity, byte[] id, byte[] payload)
    {
        var data = new byte[NonceBytes + payload.Length + TagBytes];
        var nonce = data.AsSpan(0, NonceBytes);
        RandomNumberGenerator.Fill(nonce);
        using var aes = new AesGcm(encryptionKey, TagBytes);
        aes.Encrypt(
            nonce,
            payload,
            data.AsSpan(NonceBytes, payload.Length),
            data.AsSpan(NonceBytes + payload.Length),
            AssociatedData(known, identity, id)
        );
        return data;
    }

    private byte[]? Unseal(bool known, byte[] identity, byte[] id, byte[] data)
    {
        if (data.Length < NonceBytes + TagBytes)
            return null;
        var payload = new byte[data.Length - NonceBytes - TagBytes];
        try
        {
            using var aes = new AesGcm(encryptionKey, TagBytes);
            aes.Decrypt(
                data.AsSpan(0, NonceBytes),
                data.AsSpan(NonceBytes, payload.Length),
                data.AsSpan(NonceBytes + payload.Length),
                payload,
                AssociatedData(known, identity, id)
            );
            return payload;
        }
        catch (CryptographicException)
        {
            return null;
        }
    }

    // Binds a payload to its record, so a payload moved to another record does not open.
    private static byte[] AssociatedData(bool known, byte[] identity, byte[] id) =>
        [(byte)(known ? 'k' : 's'), FormatVersion, .. identity, .. id];

    private static void WriteRange(BinaryWriter output, bool literal, TextRedactor.Found span)
    {
        output.Write(literal);
        output.Write7BitEncodedInt(span.Start);
        output.Write7BitEncodedInt(span.Length);
        WriteLabels(output, span.Labels);
    }

    private static Range[]? Slot(byte[] payload)
    {
        try
        {
            using var input = new BinaryReader(new MemoryStream(payload), Strict);
            if (input.ReadByte() != FormatVersion)
                return null;
            var ranges = new Range[Count(input, payload.Length)];
            for (var index = 0; index < ranges.Length; index++)
                ranges[index] = new(
                    input.ReadByte() switch
                    {
                        0 => false,
                        1 => true,
                        _ => throw new FormatException(),
                    },
                    input.Read7BitEncodedInt(),
                    input.Read7BitEncodedInt(),
                    ReadLabels(input, payload.Length)
                );
            return input.BaseStream.Position == payload.Length ? ranges : null;
        }
        catch (Exception error)
            when (error is IOException or FormatException or DecoderFallbackException)
        {
            return null;
        }
    }

    private static (string Original, string[] Labels)? Known(byte[] payload)
    {
        try
        {
            using var input = new BinaryReader(new MemoryStream(payload), Strict);
            if (input.ReadByte() != FormatVersion)
                return null;
            var original = input.ReadString();
            var labels = ReadLabels(input, payload.Length);
            return input.BaseStream.Position == payload.Length && original.Length > 0
                ? (original, labels)
                : null;
        }
        catch (Exception error)
            when (error is IOException or FormatException or DecoderFallbackException)
        {
            return null;
        }
    }

    private static void WriteLabels(BinaryWriter output, string[] labels)
    {
        output.Write7BitEncodedInt(labels.Length);
        foreach (var label in labels)
            output.Write(label);
    }

    private static string[] ReadLabels(BinaryReader input, int limit)
    {
        var labels = new string[Count(input, limit)];
        for (var index = 0; index < labels.Length; index++)
            labels[index] = input.ReadString();
        return labels;
    }

    // A count never exceeds the payload size, so a damaged one cannot allocate much.
    private static int Count(BinaryReader input, int limit)
    {
        var count = input.Read7BitEncodedInt();
        if (count < 0 || count > limit)
            throw new FormatException();
        return count;
    }

    // A keyed fingerprint of the settings that make up detection cache identity.
    private byte[] Identity(TextRedactionOptions options)
    {
        lock (identities)
        {
            if (identities.TryGetValue(options, out var cached))
                return cached;
            var text = new StringBuilder();
            void Field(string? value) =>
                text.Append(value is null ? "-" : value.Length + ":" + value).Append('\n');
            Field(options.Endpoint.AbsoluteUri);
            Field(options.ApiKey);
            Field(BitConverter.DoubleToInt64Bits(options.Threshold).ToString());
            Field(options.TimeoutMs.ToString());
            Field(options.ExcludeLabels.Count.ToString());
            foreach (var label in options.ExcludeLabels)
                Field(label);
            Field(options.KeepValues.Count.ToString());
            foreach (var value in options.KeepValues)
                Field(value);
            var identity = Mac("identity", Encoding.UTF8.GetBytes(text.ToString()));
            if (identities.Count >= 64)
                identities.Clear();
            identities[options] = identity;
            return identity;
        }
    }

    private byte[] SlotId(string digest) => Mac("slot", Convert.FromHexString(digest));

    private byte[] KnownId(string placeholder) => Mac("known", Encoding.UTF8.GetBytes(placeholder));

    private byte[] Mac(string purpose, byte[] value)
    {
        byte[] input = [.. Encoding.ASCII.GetBytes(purpose + "\0"), .. value];
        return HMACSHA256.HashData(indexKey, input)[..IdBytes];
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

    // One diagnostic per store is enough; every later failure is the same kind of miss.
    private void Report(string operation, Exception error)
    {
        if (Interlocked.Exchange(ref reported, 1) == 0)
            MainLog.Diagnostic(
                "Text redaction store "
                    + operation
                    + " failed; affected slots will be detected again: "
                    + MainLog.SafeFailure(error),
                failure: true
            );
    }

    // Writes what is pending, then closes. Later writes are ignored.
    public void Dispose()
    {
        lock (writeGate)
        {
            Flush();
            lock (pendingGate)
                disposed = true;
            lock (readGate)
            {
                reader.Dispose();
                writer.Dispose();
            }
        }
    }
}
