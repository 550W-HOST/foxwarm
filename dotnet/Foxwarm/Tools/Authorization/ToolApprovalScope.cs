using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed record ToolApprovalGrant(string ApprovalId, string Fingerprint, string? Note);

// One scope per tool invocation. The approval gate records the grant here before dispatch, so
// effect-owner rechecks and internal steps of the same invocation accept the ask outcome. Every
// nested invocation (ToolScript calls, later turns) installs its own empty scope.
internal sealed class ToolApprovalScope(SessionOwner owner)
{
    private static readonly AsyncLocal<ToolApprovalScope?> current = new();

    internal static ToolApprovalScope? Current => current.Value;

    internal SessionOwner Owner => owner;

    internal ToolApprovalGrant? Grant { get; set; }

    internal bool Covers(SessionOwner caller) =>
        Grant is not null && ReferenceEquals(owner, caller);

    // Synchronous so the value stays visible to the calling async method and its callees.
    internal static IDisposable Enter(ToolApprovalScope? scope)
    {
        var previous = current.Value;
        current.Value = scope;
        return new Restore(previous);
    }

    private sealed class Restore(ToolApprovalScope? previous) : IDisposable
    {
        public void Dispose() => current.Value = previous;
    }
}
