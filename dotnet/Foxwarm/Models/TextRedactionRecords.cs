namespace Foxwarm.Models;

/// <summary>
/// Persistent text-redaction results: per-slot ranges keyed by slot digest and redaction
/// options, and known originals with their labels. The same slot digest must return the same
/// ranges after a restart, so a redacted request prefix stays byte-identical
/// (D-request-prefix-stability). Records are a cache: an unreadable record is dropped, and a
/// write may be coalesced, delayed or lost, which only costs a later miss. The file
/// implementation is <see cref="TextRedactionStore"/>.
/// </summary>
internal interface ITextRedactionStore : IDisposable
{
    /// <summary>Days since the Unix epoch; record use is tracked at this granularity.</summary>
    long Today { get; }

    /// <summary>Finished results of one slot, or null when none is stored or it is unreadable.</summary>
    TextRedactionStore.Range[]? ReadSlot(TextRedactionOptions options, string digest);
    void PutSlot(
        TextRedactionOptions options,
        string digest,
        TextRedactor.Found[] spans,
        TextRedactor.Found[] masked
    );
    void TouchSlot(TextRedactionOptions options, string digest);
    void DeleteSlot(TextRedactionOptions options, string digest);

    /// <summary>Every readable known original with its labels, least recently used first.</summary>
    List<(string Original, string[] Labels)> ReadKnown();
    void PutKnown(string placeholder, string original, string[] labels);
    void TouchKnown(string placeholder);
    void DeleteKnown(string placeholder);

    /// <summary>Writes pending records now.</summary>
    void Flush();
}
