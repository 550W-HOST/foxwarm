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

    // The approved identity of a call: what it is, where it runs, and every fact of the request
    // the evaluator receives. The projection names each fact explicitly (it must hold in a
    // trimmed native build, where reflection could lose members);
    // Approval_fingerprint_binds_every_fact_of_the_request enumerates the request and its nested
    // fact types and fails when a property is not bound here.
    internal static string Fingerprint(ResolvedTool resolved, ToolAuthorizationRequest request)
    {
        var value = new JsonObject
        {
            ["call"] = new JsonObject
            {
                ["source"] = resolved.Source,
                ["name"] = resolved.Name,
                ["server"] = resolved.Server,
                ["executionNode"] = resolved.ExecutionNode,
                ["args"] = resolved.Args.DeepClone(),
            },
            ["request"] = FingerprintFacts(request),
        };
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value.ToJsonText())));
    }

    // Every property of the request; an empty collection is an absent fact to the evaluator.
    internal static JsonObject FingerprintFacts(ToolAuthorizationRequest request) =>
        new()
        {
            ["source"] = request.Source,
            ["name"] = request.Name,
            ["server"] = request.Server,
            ["args"] = request.Args.DeepClone(),
            ["paths"] = Facts(request.Paths, PathFact),
            ["agent"] = request.Agent,
            ["session"] = request.Session,
            ["targetNode"] = request.TargetNode,
            ["workspace"] = request.Workspace,
            ["agentDirectory"] = request.AgentDirectory,
            ["memoryDirectory"] = request.MemoryDirectory,
            ["sourceParent"] = request.SourceParent,
            ["sessionTarget"] = request.SessionTarget is { } target ? TargetFact(target) : null,
            ["principal"] = request.Principal,
            ["externalId"] = request.ExternalId,
            ["taskOwnerSession"] = request.TaskOwnerSession,
            ["nodeTargets"] = Facts(request.NodeTargets, node => JsonValue.Create(node)),
            ["currentNode"] = request.CurrentNode,
            ["nodeForest"] = request.NodeForest is { } forest ? NodeAncestry(forest, request) : null,
            ["secrets"] = Facts(request.Secrets, name => JsonValue.Create(name)),
            ["ownedSecrets"] = Facts(request.OwnedSecrets, name => JsonValue.Create(name)),
            ["operations"] = Facts(request.Operations, OperationFact),
        };

    // An operation with every fact operation rules read: its resources and attributes (the
    // normalized arguments they come from), path, resolved Sessions, Agent ancestry, Task
    // authority and secret ownership.
    private static JsonObject OperationFact(AuthorizationOperation operation)
    {
        var result = operation.ToJson();
        result["path"] = operation.Path is { } path ? PathFact(path) : null;
        result["target"] = operation.Target is { } target ? TargetFact(target) : null;
        result["parentTarget"] = operation.ParentTarget is { } parent ? TargetFact(parent) : null;
        result["agentDescendant"] = operation.AgentDescendant;
        result["taskOwned"] = operation.TaskOwned;
        result["taskCreated"] = operation.TaskCreated;
        result["secretOwned"] = operation.SecretOwned;
        return result;
    }

    private static JsonArray? Facts<T>(IEnumerable<T>? items, Func<T, JsonNode?> project) =>
        items?.ToArray() is { Length: > 0 } list ? new(list.Select(project).ToArray()) : null;

    private static JsonObject PathFact(AuthorizationPath path)
    {
        var fact = new JsonObject
        {
            ["arg"] = path.Arg,
            ["raw"] = path.Raw,
            ["resolved"] = path.Resolved,
            ["node"] = path.Node,
        };
        // Only copy legs carry it, so other fingerprints are unchanged.
        if (path.Tree)
            fact["tree"] = true;
        return fact;
    }

    private static JsonObject TargetFact(AuthorizationTarget target) =>
        new()
        {
            ["id"] = target.Id,
            ["agent"] = target.Agent,
            ["parent"] = target.Parent,
        };

    // The ancestry chain of each Node target, as the evaluator matches it. An ancestry the
    // evaluator rejects (a cycle or a missing ancestor) is bound as invalid.
    private static JsonObject NodeAncestry(
        Foxwarm.Nodes.NodeAuthorizationForest forest,
        ToolAuthorizationRequest request
    )
    {
        var chains = new JsonObject();
        var targets = (request.NodeTargets ?? []).Distinct(StringComparer.Ordinal);
        foreach (var node in targets.Order(StringComparer.Ordinal))
        {
            if (!forest.Contains(node))
            {
                chains[node] = null;
                continue;
            }
            try
            {
                chains[node] = new JsonArray(
                    forest.Chain(node).Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
                );
            }
            catch (InvalidDataException)
            {
                chains[node] = "invalid";
            }
        }
        return chains;
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

    internal bool IsEmpty => waiters.IsEmpty;
}
