using System.Buffers;
using System.Text.Json;

namespace Foxwarm.ToolScript;

/// <summary>Budgeted temporary serialization buffer for opaque JsonElement-backed tool values.</summary>
internal sealed class ToolScriptBudgetBuffer(ToolScriptDataBudget budget) : IBufferWriter<byte>
{
    private byte[] buffer = [];
    private int count;
    private int processed;
    private JsonReaderState readerState = new(new JsonReaderOptions { MaxDepth = 256 });
    internal ReadOnlySpan<byte> Written => buffer.AsSpan(0, count);

    public void Advance(int amount)
    {
        if (amount < 0 || amount > buffer.Length - count)
            throw new ArgumentOutOfRangeException(nameof(amount));
        // Account tokens/strings before a later consumer creates JSON/protocol representations.
        count += amount;
        var reader = new Utf8JsonReader(
            buffer.AsSpan(processed, count - processed),
            isFinalBlock: false,
            readerState
        );
        while (reader.Read())
            budget.ChargeToken(ref reader);
        processed += (int)reader.BytesConsumed;
        readerState = reader.CurrentState;
    }

    public Memory<byte> GetMemory(int sizeHint = 0)
    {
        Ensure(sizeHint);
        return buffer.AsMemory(count);
    }

    public Span<byte> GetSpan(int sizeHint = 0)
    {
        Ensure(sizeHint);
        return buffer.AsSpan(count);
    }

    private void Ensure(int hint)
    {
        if (hint < 0)
            throw new ArgumentOutOfRangeException(nameof(hint));
        var size = checked(count + Math.Max(1, hint));
        if (size <= buffer.Length)
            return;
        var capacity = checked(
            (int)Math.Min(int.MaxValue, Math.Max(size, Math.Max(256L, 2L * buffer.Length)))
        );
        budget.Charge(capacity);
        var next = new byte[capacity];
        buffer.AsSpan(0, count).CopyTo(next);
        buffer = next;
    }
}
