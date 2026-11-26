using System.Security.Cryptography;
using System.Text;

namespace Foxwarm.Models;

// The backend-independent part of the persistent text-redaction cache: record identities,
// payload formats, encryption and write coalescing. A backend only reads sealed records and
// applies coalesced batches, so every backend stores the same bytes for the same key and
// returns the same ranges for the same slot digest (D-request-prefix-stability).
//
// Slot records hold only replaced ranges (offset, length, labels and whether the range was
// detected or literal-masked), never the slot text or placeholders: originals come from the
// slot text and placeholders are recomputed with the placeholder HMAC. Records are keyed by a
// keyed hash of the slot's cache digest together with a keyed fingerprint of the detection
// settings. Known originals are private values, so every record payload is encrypted with
// AES-GCM under a key derived from the instance key; without that key nothing can be read.
internal abstract class TextRedactionRecordStore : ITextRedactionStore
{
    internal const long DefaultSlotBytes = 64L * 1024 * 1024;
    internal const int MaxPending = 65536;
    private protected const int FormatVersion = 1;
    private protected const int IdBytes = 16;
    private const int NonceBytes = 12;
    private const int TagBytes = 16;
    private protected const int RowOverhead = 64;

    // A record that would be larger is not persisted; the slot is detected again after a
    // restart.
    private const int MaxPayloadBytes = 1024 * 1024;

    // One replaced range as stored: offsets in the slot text for detected ranges and in the
    // detected form for literal ranges, as in the memory cache.
    internal readonly record struct Range(bool Literal, int Start, int Length, string[] Labels);

    private protected enum Kind
    {
        Put,
        Touch,
        Delete,
    }

    // A pending write. Payloads are plaintext until the backend seals them.
    private protected sealed record Write(
        Kind Kind,
        bool Known,
        byte[] Identity,
        byte[] Id,
        byte[]? Payload,
        bool Replace
    );

    private static readonly UTF8Encoding Strict = new(false, true);
    private readonly byte[] encryptionKey;
    private readonly byte[] indexKey;
    private readonly TimeProvider clock;
    private protected readonly long slotLimit;
    private protected readonly long knownLimit;
    private readonly object writeGate = new();
    private readonly object pendingGate = new();
    private Dictionary<string, Write> pending = new(StringComparer.Ordinal);
    private readonly Dictionary<TextRedactionOptions, byte[]> identities = new();
    private protected long slotEstimate;
    private protected long knownEstimate;
    private protected long knownSequence;
    private int scheduled;
    private bool disposed;
    private int reported;

    private protected TextRedactionRecordStore(
        byte[] key,
        TimeProvider clock,
        long slotLimit,
        long knownLimit
    )
    {
        if (key.Length < 64)
            throw new ArgumentException("Text redaction store key must have at least 64 bytes.");
        encryptionKey = key[..32];
        indexKey = key[32..64];
        this.clock = clock;
        this.slotLimit = slotLimit;
        this.knownLimit = knownLimit;
    }

    // Days since the Unix epoch. A record's last use is kept at this granularity, so an
    // entry used by every request is touched on disk at most once a day.
    public long Today => clock.GetUtcNow().ToUnixTimeSeconds() / 86400;

    // Whether the store is closed; backends check it under their read lock.
    private protected bool Disposed
    {
        get
        {
            lock (pendingGate)
                return disposed;
        }
    }

    // The keyed check value of this key and format; records under another key or format can
    // never be read, so a backend whose stored check differs clears every record.
    private protected byte[] CheckValue() => Mac("check\0" + FormatVersion, []);

    // The sealed record of one slot, or null. Read failures for which IsReadFailure holds
    // are misses.
    private protected abstract byte[]? ReadSlotData(byte[] identity, byte[] slot);

    // Every known record with its sealed data, least recently used first.
    private protected abstract List<(byte[] Id, byte[] Data)> ReadKnownData();

    // Applies one coalesced batch atomically, including pruning; a failure for which
    // IsWriteFailure holds drops the batch.
    private protected abstract void WriteBatch(IReadOnlyCollection<Write> batch, long today);

    private protected abstract bool IsReadFailure(Exception error);

    private protected abstract bool IsWriteFailure(Exception error);

    // Releases backend resources after the last flush.
    private protected abstract void Close();

    // Finished results of one slot, or null when none is stored or the record is unreadable.
    public Range[]? ReadSlot(TextRedactionOptions options, string digest)
    {
        var identity = Identity(options);
        var id = SlotId(digest);
        byte[]? data;
        try
        {
            data = ReadSlotData(identity, id);
        }
        catch (Exception error) when (IsReadFailure(error))
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
    public void DeleteSlot(TextRedactionOptions options, string digest) =>
        Enqueue(new(Kind.Delete, false, Identity(options), SlotId(digest), null, false));

    // Every readable known original with its labels, least recently used first. Unreadable
    // records are removed.
    public List<(string Original, string[] Labels)> ReadKnown()
    {
        var result = new List<(string, string[])>();
        List<(byte[] Id, byte[] Data)> rows;
        try
        {
            rows = ReadKnownData();
        }
        catch (Exception error) when (IsReadFailure(error))
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

    public void PutSlot(
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

    public void TouchSlot(TextRedactionOptions options, string digest) =>
        Enqueue(new(Kind.Touch, false, Identity(options), SlotId(digest), null, false));

    public void PutKnown(string placeholder, string original, string[] labels)
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

    public void TouchKnown(string placeholder) =>
        Enqueue(new(Kind.Touch, true, [], KnownId(placeholder), null, false));

    public void DeleteKnown(string placeholder) =>
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
    public void Flush()
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
                WriteBatch(batch.Values, Today);
            }
            catch (Exception error) when (IsWriteFailure(error))
            {
                Report("write", error);
            }
        }
    }

    // The next least-recently-used sequence of a known record.
    private protected long NextKnownSequence() => ++knownSequence;

    // Pending payloads are sealed by the backend at write time.
    private protected byte[] Seal(bool known, byte[] identity, byte[] id, byte[] payload)
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

    private byte[]? Unseal(bool known, byte[] identity, byte[] id, byte[] data) =>
        Unseal(encryptionKey, known, identity, id, data);

    private protected static byte[]? Unseal(
        byte[] encryptionKey,
        bool known,
        byte[] identity,
        byte[] id,
        byte[] data
    )
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

    private protected static (string Original, string[] Labels)? Known(byte[] payload)
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
            Field(options.KnownLabels.Labels?.Count.ToString());
            if (options.KnownLabels.Labels is { } knownLabels)
                foreach (var label in knownLabels)
                    Field(label);
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

    // One diagnostic per store is enough; every later failure is the same kind of miss.
    private protected void Report(string operation, Exception error)
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
            Close();
        }
    }
}
