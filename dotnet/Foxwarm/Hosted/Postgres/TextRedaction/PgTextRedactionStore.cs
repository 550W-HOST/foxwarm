using Foxwarm.Models;
using Npgsql;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The tenant's persistent text-redaction cache in PostgreSQL. Record identities, formats,
/// encryption and coalescing are the file store's (<see cref="TextRedactionRecordStore"/>), so
/// the replica that takes over a tenant reads the slot ranges the previous owner wrote and
/// sends unchanged history byte for byte (D-request-prefix-stability). The key is the tenant's
/// derived redaction-store key. Like the file store it is a cache: a failed read is a miss and
/// a failed or fenced write only drops its batch.
/// </summary>
internal sealed class PgTextRedactionStore : TextRedactionRecordStore
{
    private readonly TenantDb database;

    private PgTextRedactionStore(
        TenantDb database,
        byte[] key,
        TimeProvider clock,
        long slotLimit,
        long knownLimit
    )
        : base(key, clock, slotLimit, knownLimit)
    {
        this.database = database;
        Prepare();
    }

    /// <summary>Opens the store; a failure leaves the redactor memory-only.</summary>
    internal static PgTextRedactionStore? Open(
        TenantDb database,
        byte[] key,
        long knownLimit,
        TimeProvider? clock = null,
        long slotLimit = DefaultSlotBytes
    )
    {
        if (key.Length < 64)
            throw new ArgumentException("Text redaction store key must have at least 64 bytes.");
        try
        {
            return new PgTextRedactionStore(
                database,
                key,
                clock ?? TimeProvider.System,
                slotLimit,
                knownLimit
            );
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

    // Records sealed under another key or format can never be read again, so a different
    // stored check clears them; a matching one (every takeover with the same key) changes
    // nothing.
    private void Prepare()
    {
        var check = CheckValue();
        var stored = database.Read(tx =>
            tx.Scalar("SELECT value FROM text_redaction_meta WHERE key='check'") as byte[]
        );
        if (stored is null || !stored.SequenceEqual(check))
            database.Write(tx =>
            {
                tx.Execute("DELETE FROM text_redaction_slots");
                tx.Execute("DELETE FROM text_redaction_known");
                tx.Execute(
                    "INSERT INTO text_redaction_meta(key, value) VALUES('check', $1)"
                        + " ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value",
                    check
                );
                return true;
            });
        (slotEstimate, knownEstimate, knownSequence) = database.Read(
            tx => (
                Estimate(tx, "text_redaction_slots"),
                Estimate(tx, "text_redaction_known"),
                (long)tx.Scalar("SELECT COALESCE(MAX(seq), 0)::bigint FROM text_redaction_known")!
            ),
            snapshot: true
        );
    }

    // Estimated bytes of a table: payloads plus keys and a fixed per-row overhead.
    private static long Estimate(PgTx tx, string table)
    {
        using var command = tx.Command(
            "SELECT COUNT(*), COALESCE(SUM(octet_length(data)), 0)::bigint FROM " + table
        );
        using var rows = command.ExecuteReader();
        rows.Read();
        return rows.GetInt64(1) + rows.GetInt64(0) * (RowOverhead + 2 * IdBytes);
    }

    private protected override byte[]? ReadSlotData(byte[] identity, byte[] slot) =>
        Disposed
            ? null
            : database.Read(tx =>
                tx.Scalar(
                    "SELECT data FROM text_redaction_slots WHERE identity=$1 AND slot=$2",
                    identity,
                    slot
                ) as byte[]
            );

    private protected override List<(byte[] Id, byte[] Data)> ReadKnownData() =>
        Disposed
            ? []
            : database.Read(tx =>
            {
                var rows = new List<(byte[] Id, byte[] Data)>();
                using var command = tx.Command(
                    "SELECT id, data FROM text_redaction_known ORDER BY seq, id"
                );
                using var reading = command.ExecuteReader();
                while (reading.Read())
                    rows.Add(((byte[])reading[0], (byte[])reading[1]));
                return rows;
            });

    private protected override bool IsReadFailure(Exception error) => IsStoreFailure(error);

    private protected override bool IsWriteFailure(Exception error) => IsStoreFailure(error);

    private static bool IsStoreFailure(Exception error) =>
        error
            is NpgsqlException
                or IOException
                or InvalidOperationException
                or TenantFencedException
                or CommitOutcomeUnknownException;

    // One fenced transaction per batch; the estimates and the known sequence advance only
    // once it commits.
    private protected override void WriteBatch(IReadOnlyCollection<Write> batch, long today)
    {
        var (slots, known, sequence) = database.Write(tx =>
        {
            var slotBytes = slotEstimate;
            var knownBytes = knownEstimate;
            var next = knownSequence;
            foreach (var write in batch)
            {
                var size = Apply(tx, write, today, ref next);
                if (write.Known)
                    knownBytes += size;
                else
                    slotBytes += size;
            }
            if (slotBytes > slotLimit)
                slotBytes = Prune(tx, "text_redaction_slots", "used, identity, slot", "identity, slot", slotLimit);
            if (knownBytes > knownLimit)
                knownBytes = Prune(tx, "text_redaction_known", "seq, id", "id", knownLimit);
            return (slotBytes, knownBytes, next);
        });
        slotEstimate = slots;
        knownEstimate = known;
        knownSequence = sequence;
    }

    // Applies one write and returns the bytes it added.
    private long Apply(PgTx tx, Write write, long today, ref long sequence)
    {
        if (write.Kind == Kind.Delete)
        {
            if (write.Known)
                tx.Execute("DELETE FROM text_redaction_known WHERE id=$1", write.Id);
            else
                tx.Execute(
                    "DELETE FROM text_redaction_slots WHERE identity=$1 AND slot=$2",
                    write.Identity,
                    write.Id
                );
            return 0;
        }
        var used = write.Known ? ++sequence : today;
        if (write.Kind == Kind.Touch)
        {
            if (write.Known)
                tx.Execute("UPDATE text_redaction_known SET seq=$2 WHERE id=$1", write.Id, used);
            else
                tx.Execute(
                    "UPDATE text_redaction_slots SET used=$3 WHERE identity=$1 AND slot=$2",
                    write.Identity,
                    write.Id,
                    used
                );
            return 0;
        }
        var data = Seal(write.Known, write.Identity, write.Id, write.Payload!);
        var inserted = write.Known
            ? tx.Execute(
                "INSERT INTO text_redaction_known(id, data, seq) VALUES($1, $2, $3)"
                    + (write.Replace
                        ? " ON CONFLICT (tenant_id, id) DO UPDATE SET data = excluded.data, seq = excluded.seq"
                        : " ON CONFLICT DO NOTHING"),
                write.Id,
                data,
                used
            )
            : tx.Execute(
                "INSERT INTO text_redaction_slots(identity, slot, data, used) VALUES($1, $2, $3, $4)"
                    + (write.Replace
                        ? " ON CONFLICT (tenant_id, identity, slot) DO UPDATE SET data = excluded.data, used = excluded.used"
                        : " ON CONFLICT DO NOTHING"),
                write.Identity,
                write.Id,
                data,
                used
            );
        return inserted > 0 ? data.Length + RowOverhead + 2 * IdBytes : 0;
    }

    // Removes the least recently used rows until the table is within 90% of its limit.
    private static long Prune(PgTx tx, string table, string order, string key, long limit)
    {
        var target = limit / 10 * 9;
        var total = Estimate(tx, table);
        while (total > target)
        {
            var rows = (long)tx.Scalar("SELECT COUNT(*) FROM " + table)!;
            if (rows == 0)
                return 0;
            var remove = Math.Clamp(
                (long)Math.Ceiling((double)(total - target) * rows / total),
                1,
                rows
            );
            tx.Execute(
                $"DELETE FROM {table} WHERE ({key}) IN (SELECT {key} FROM {table} ORDER BY {order} LIMIT $1)",
                remove
            );
            total = Estimate(tx, table);
        }
        return total;
    }

    private protected override void Close() { }
}
