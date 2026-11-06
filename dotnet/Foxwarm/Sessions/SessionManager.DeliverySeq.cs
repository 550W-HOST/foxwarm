using System.Globalization;

namespace Foxwarm.Sessions;

// Correlates one inter-session delivery with the sender's committed model message.
// The ID is position-based so a restart or replay of the same batch yields the same value.
internal sealed partial class SessionManager
{
    private sealed record DeliveryScope(string SourceSessionId, string DeliverySeq);

    private readonly AsyncLocal<DeliveryScope?> deliveryScope = new();

    // Set by the tool executor for the duration of one attributed call. Inline queue processing
    // can inherit this context, so a delivery uses it only when it is sent by the same Session.
    internal void SetDeliverySeq(SessionOwner source, string? deliverySeq) =>
        deliveryScope.Value = deliverySeq is null ? null : new(source.Id, deliverySeq);

    private string? DeliverySeqFor(SessionOwner source) =>
        deliveryScope.Value is { } scope && scope.SourceSessionId == source.Id
            ? scope.DeliverySeq
            : null;

    /// <summary>
    /// <c>seq</c> for a single non-script call, <c>seq.k</c> for the k-th call of a batch
    /// (and for a single script call, so its subcalls stay hierarchical).
    /// </summary>
    internal static string? BatchDeliverySeq(long? anchorSeq, int? index, int? total, bool script)
    {
        if (anchorSeq is not long seq || index is not int position || total is not int count)
            return null;
        var anchor = seq.ToString(CultureInfo.InvariantCulture);
        return count == 1 && !script
            ? anchor
            : anchor + "." + (position + 1).ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>The n-th ToolScript subcall below a call's ID, or below <c>ts:runId</c> without one.</summary>
    internal static string? SubCallDeliverySeq(string? parent, string? runId, int? ordinal)
    {
        if (ordinal is not int n || n < 1)
            return null;
        var prefix = parent ?? (string.IsNullOrEmpty(runId) ? null : "ts:" + runId);
        return prefix is null ? null : prefix + "." + n.ToString(CultureInfo.InvariantCulture);
    }
}
