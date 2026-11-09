using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed record ToolApprovalGrant(string ApprovalId, string Fingerprint, string? Note);

// One scope per tool invocation. The approval gate records the grant here before dispatch, so
// effect-owner rechecks and internal steps of the same invocation accept the ask outcome. Every
// nested invocation (ToolScript calls, later turns) installs its own scope without a grant.
internal sealed class ToolApprovalScope(SessionOwner owner)
{
    private static readonly AsyncLocal<ToolApprovalScope?> current = new();

    internal static ToolApprovalScope? Current => current.Value;

    internal SessionOwner Owner => owner;

    internal ToolApprovalGrant? Grant { get; set; }

    // Set when the invocation dispatches its call. An approved call that never dispatched is
    // recorded as not started.
    internal bool Dispatched { get; set; }

    // The call the gate authorizes. A grant covers it only for the facts the approver saw;
    // other checks inside the invocation are its internal steps.
    internal ResolvedTool? Primary { get; set; }

    internal bool Covers(
        SessionOwner caller,
        ResolvedTool resolved,
        ToolAuthorizationRequest request
    ) =>
        Grant is { } grant
        && ReferenceEquals(owner, caller)
        && (
            !ReferenceEquals(resolved, Primary)
            || grant.Fingerprint == Fingerprint(resolved, request)
        );

    // The grant of the current invocation for effect work that continues outside its flow, such
    // as a detached transfer task or a later reception callback. That work must enter the
    // returned scope explicitly: the ambient value does not reach it. Every check inside it is
    // an internal step of the approved call.
    internal static ToolApprovalScope? Detach(SessionOwner owner) =>
        current.Value is { Grant: { } grant } scope && ReferenceEquals(scope.Owner, owner)
            ? new ToolApprovalScope(owner) { Grant = grant }
            : null;

    // Synchronous so the value stays visible to the calling async method and its callees.
    internal static IDisposable Enter(ToolApprovalScope? scope)
    {
        var previous = current.Value;
        current.Value = scope;
        return new Restore(() => current.Value = previous);
    }

    // The approved identity of a call: what it is, where it runs and the facts policy saw. The
    // Session ID is excluded so an identity move does not invalidate an approval.
    internal static string Fingerprint(ResolvedTool resolved, ToolAuthorizationRequest request)
    {
        var value = new JsonObject
        {
            ["source"] = resolved.Source,
            ["name"] = resolved.Name,
            ["server"] = resolved.Server,
            ["executionNode"] = resolved.ExecutionNode,
            ["args"] = resolved.Args.DeepClone(),
            ["paths"] = new JsonArray(
                request
                    .Paths.Select(path =>
                        (JsonNode?)
                            new JsonObject
                            {
                                ["arg"] = path.Arg,
                                ["raw"] = path.Raw,
                                ["resolved"] = path.Resolved,
                                ["node"] = path.Node,
                            }
                    )
                    .ToArray()
            ),
            ["nodeTargets"] = new JsonArray(
                (request.NodeTargets ?? [])
                    .Select(node => (JsonNode?)JsonValue.Create(node))
                    .ToArray()
            ),
            ["sessionTarget"] = request.SessionTarget?.Id,
            ["taskOwner"] = request.TaskOwnerSession,
        };
        if (request.Secrets is { Count: > 0 } secrets)
            value["secrets"] = new JsonArray(
                secrets.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()
            );
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value.ToJsonString())));
    }

    private sealed class Restore(Action restore) : IDisposable
    {
        public void Dispose() => restore();
    }
}

// Time a ToolScript slice spent waiting for approval decisions, which does not count toward
// the slice's wall-clock limit.
internal sealed class ToolApprovalWaitMeter
{
    private static readonly AsyncLocal<ToolApprovalWaitMeter?> current = new();
    private long ticks;

    internal static ToolApprovalWaitMeter? Current => current.Value;

    internal TimeSpan Total => TimeSpan.FromTicks(Interlocked.Read(ref ticks));

    internal void Add(TimeSpan elapsed) => Interlocked.Add(ref ticks, elapsed.Ticks);

    internal static IDisposable Enter(ToolApprovalWaitMeter meter)
    {
        var previous = current.Value;
        current.Value = meter;
        return new Restore(() => current.Value = previous);
    }

    internal static long Start() => Stopwatch.GetTimestamp();

    internal static void Stop(long started) => Current?.Add(Stopwatch.GetElapsedTime(started));

    private sealed class Restore(Action restore) : IDisposable
    {
        public void Dispose() => restore();
    }
}

// Live waiters of pending approval records, owned by the Session owner in this process.
internal sealed class ToolApprovalWaiters
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, Waiter> waiters =
        new(StringComparer.Ordinal);

    internal sealed record Waiter(TaskCompletionSource<JsonObject> Decision, JsonObject Args);

    internal Waiter Register(string id, JsonObject args)
    {
        var waiter = new Waiter(
            new TaskCompletionSource<JsonObject>(
                TaskCreationOptions.RunContinuationsAsynchronously
            ),
            args
        );
        if (!waiters.TryAdd(id, waiter))
            throw new InvalidOperationException("Duplicate approval waiter.");
        return waiter;
    }

    internal JsonObject? Args(string id) =>
        waiters.TryGetValue(id, out var waiter) ? waiter.Args : null;

    internal void Complete(string id, JsonObject record)
    {
        if (waiters.TryGetValue(id, out var waiter))
            waiter.Decision.TrySetResult(record);
    }

    internal void Remove(string id) => waiters.TryRemove(id, out _);
}
