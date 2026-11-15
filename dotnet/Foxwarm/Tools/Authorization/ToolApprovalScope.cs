using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// An approver's decision for one approval request. Fingerprints are the exact requests it
// covers: the call and every other check of the call that asked when it was requested.
internal sealed record ToolApprovalGrant(
    string ApprovalId,
    IReadOnlySet<string> Fingerprints,
    string? Note,
    ToolApprovalStage Stage = ToolApprovalStage.Call
);

// Stage A approves reading inputs whose content decides the facts of the call; stage B
// approves the call's complete plan.
internal enum ToolApprovalStage
{
    Input,
    Call,
}

// One scope per tool invocation. The approval gate records its grants here before dispatch. A
// check inside the invocation passes an ask outcome only when a grant covers that exact request
// (identity, raw arguments and facts); every check still evaluates the current policy first.
// Every nested invocation (ToolScript calls, later turns) installs its own scope without a grant.
internal sealed class ToolApprovalScope(SessionOwner owner)
{
    private static readonly AsyncLocal<ToolApprovalScope?> current = new();
    private readonly List<ToolApprovalGrant> grants = [];

    internal static ToolApprovalScope? Current => current.Value;

    internal SessionOwner Owner => owner;

    // The grants of this invocation, in the order they were given.
    internal IReadOnlyList<ToolApprovalGrant> Grants
    {
        get
        {
            lock (grants)
                return grants.ToArray();
        }
    }

    // The latest grant: the call approval when there is one.
    internal ToolApprovalGrant? Grant => Grants.LastOrDefault();

    internal void Add(ToolApprovalGrant grant)
    {
        lock (grants)
            grants.Add(grant);
    }

    // Set when the invocation dispatches its call. An approved call that never dispatched is
    // recorded as not started.
    internal bool Dispatched { get; set; }

    // The call the gate authorizes, for attribution of the checks made on its behalf.
    internal ResolvedTool? Primary { get; set; }

    // Input bytes admitted before the plan was derived, which the effect consumes instead of
    // reading again. Keyed by input kind and path.
    internal Dictionary<string, byte[]> Inputs { get; } = new(StringComparer.Ordinal);

    internal bool Covers(SessionOwner caller, string fingerprint) =>
        ReferenceEquals(owner, caller)
        && Grants.Any(grant => grant.Fingerprints.Contains(fingerprint));

    // The admitted plan of the current invocation for effect work that continues outside its
    // flow, such as a detached transfer task or a later reception callback: its grants and the
    // call they belong to. That work must enter the returned scope explicitly: the ambient value
    // does not reach it. A check inside it passes an ask only for a request the grants cover.
    internal static ToolApprovalScope? Detach(SessionOwner owner)
    {
        if (current.Value is not { } scope || !ReferenceEquals(scope.Owner, owner))
            return null;
        var detached = new ToolApprovalScope(owner) { Primary = scope.Primary };
        foreach (var grant in scope.Grants)
            detached.Add(grant);
        return detached;
    }

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
        if (request.OwnedSecrets is { Count: > 0 } owned)
            value["ownedSecrets"] = new JsonArray(
                owned.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()
            );
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value.ToJsonText())));
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
