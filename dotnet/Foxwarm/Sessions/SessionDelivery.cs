using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// One committed Session-sourced delivery, reported to the call that caused it so the call can
/// keep UI-only presentation evidence. <see cref="Task"/> describes a Task notification.
/// </summary>
internal sealed record SessionDelivery(string TargetSessionId, string Message, string? DeliverySeq)
{
    internal JsonObject? Task { get; init; }
}
