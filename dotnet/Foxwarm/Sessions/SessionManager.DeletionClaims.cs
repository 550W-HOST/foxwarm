using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed class SessionDeletionException(
    string message,
    string code,
    int status = 409,
    JsonObject? details = null
) : InvalidOperationException(message)
{
    internal string Code { get; } = code;
    internal int Status { get; } = status;
    internal JsonObject Details { get; } = details ?? new();
}

internal sealed record DeleteSelection(
    string Root,
    string[] Targets,
    string[] Direct,
    string[] Post
);

internal sealed partial class SessionManager
{
    private sealed class DeleteOperation(
        DeleteSelection selection,
        bool recursive,
        string requested,
        SessionOwner? source,
        bool agentCommand
    )
    {
        internal readonly DeleteSelection Selection = selection;
        internal readonly bool Recursive = recursive;
        internal readonly bool AgentCommand = agentCommand;
        internal readonly string Requested = requested;
        internal readonly string? Source = source?.Id;
        internal readonly SessionOwner? SourceOwner = source;
        internal readonly Dictionary<string, SessionOwner> Owners = new(StringComparer.Ordinal);
        internal readonly HashSet<string> Retired = new(StringComparer.Ordinal),
            RetirementStarted = new(StringComparer.Ordinal),
            WorkerRowsRemoved = new(StringComparer.Ordinal);
        internal readonly HashSet<string> JsonRemoved = new(StringComparer.Ordinal),
            FrontierRemoved = new(StringComparer.Ordinal),
            JsonDurable = new(StringComparer.Ordinal),
            FrontierDurable = new(StringComparer.Ordinal);
        internal readonly HashSet<string> ChannelsCleaned = new(StringComparer.Ordinal),
            WorkersCleaned = new(StringComparer.Ordinal),
            TrackingCleaned = new(StringComparer.Ordinal);
        internal readonly List<string> Detached = [],
            Deleted = [];
        internal string Stage = "preflight";
        internal string? FailedId;
        internal bool Running;
        internal TaskCompletionSource Finished = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
    }

    private readonly Dictionary<string, DeleteOperation> deletionClaims = new(
        StringComparer.Ordinal
    );
    private readonly Dictionary<string, DeleteOperation> partialDeletes = new(
        StringComparer.Ordinal
    );
    private readonly HashSet<DeleteOperation> deletionOperations = [];
    private readonly Dictionary<string, DeleteOperation> crossDeletes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<TaskCompletionSource>> mutationAdmissions = new(
        StringComparer.Ordinal
    );
    private readonly AsyncLocal<DeleteOperation?> catalogDeleteOwner = new();
    private readonly AsyncLocal<MutationAdmission?> mutationContext = new();
    internal Func<string, string, Task>? BeforeDeleteStage { get; set; }

    private bool IsRetiring(string id)
    {
        lock (lifecycle)
            return identities.TryGetValue(id, out var slot) && slot.Retiring;
    }

    internal bool CanRunCallbacks(string id) =>
        !IsDeletionClaimed(id) && Find(id) is { } owner && owner.Entry.IdentityAvailable;

    private bool IsDeletionClaimed(string id)
    {
        lock (lifecycle)
            return deletionClaims.ContainsKey(id);
    }

    private bool IsCurrentOwner(SessionOwner owner) =>
        sessions.TryGetValue(owner.Id, out var current)
        && ReferenceEquals(current, owner)
        && !owner.Entry.Retired;

    private sealed class MutationAdmission(
        SessionManager manager,
        string[] ids,
        TaskCompletionSource finished,
        MutationAdmission? prior
    ) : IDisposable
    {
        private bool active = true;

        internal bool AlreadyAccepted(string id) =>
            active && ids.Contains(id, StringComparer.Ordinal)
            || prior?.AlreadyAccepted(id) == true;

        public void Dispose()
        {
            lock (manager.lifecycle)
            {
                active = false;
                if (manager.mutationContext.Value == this)
                    manager.mutationContext.Value = prior;
                foreach (var id in ids)
                    if (manager.mutationAdmissions.TryGetValue(id, out var set))
                    {
                        set.Remove(finished);
                        if (set.Count == 0)
                            manager.mutationAdmissions.Remove(id);
                    }
                finished.TrySetResult();
            }
        }
    }

    private IDisposable BeginMutation(
        IEnumerable<string> requested,
        DeleteOperation? owning = null,
        bool acceptedTimer = false
    )
    {
        var ids = requested.Distinct(StringComparer.Ordinal).ToArray();
        var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (lifecycle)
        {
            if (
                !accepting
                && !acceptedTimer
                && owning is null
                && !ids.All(id =>
                    mutationContext.Value?.AlreadyAccepted(id) == true
                    || sessions.TryGetValue(id, out var owner)
                        && owner.Entry.CanSettleDuringShutdown
                )
            )
                throw new InvalidOperationException("Host is shutting down.");
            foreach (var id in ids)
            {
                if (
                    identityMoveClaims.TryGetValue(id, out var moving)
                    && moving != owningIdentityMove.Value
                )
                    throw new InvalidOperationException(
                        "Session identity is changing. Retry after it finishes."
                    );
                if (sessions.TryGetValue(id, out var affected))
                    affected.Entry.RequireIdentityAuthority();
            }
            foreach (var id in ids)
                if (
                    deletionClaims.TryGetValue(id, out var claim)
                    && claim != owning
                    && mutationContext.Value?.AlreadyAccepted(id) != true
                    && !(
                        claim.AgentCommand
                        && sessions.TryGetValue(id, out var settling)
                        && settling.Entry.CanSettleDuringShutdown
                        && !IsRetiring(id)
                    )
                )
                    throw new SessionDeletionException(
                        $"Session '{id}' is being deleted. Retry after the operation finishes.",
                        "SESSION_DELETE_IN_PROGRESS"
                    );
            foreach (var id in ids)
            {
                if (!mutationAdmissions.TryGetValue(id, out var set))
                    mutationAdmissions[id] = set = [];
                set.Add(finished);
            }
        }
        var scope = new MutationAdmission(this, ids, finished, mutationContext.Value);
        mutationContext.Value = scope;
        return scope;
    }

    private IDisposable BeginOwnerMutation(SessionOwner owner, bool acceptedTimer = false)
    {
        var scope = BeginMutation([owner.Id], acceptedTimer: acceptedTimer);
        if (IsCurrentOwner(owner))
            return scope;
        scope.Dispose();
        throw new SessionDeletionException(
            "This Session owner is no longer current.",
            "SESSION_STATE_UNAVAILABLE",
            409
        );
    }

    private IDisposable BeginCatalogMutation(JsonObject[] rows)
    {
        var ids = new HashSet<string>(
            rows.Select(row => SessionCatalog.Text(row["id"])!),
            StringComparer.Ordinal
        );
        foreach (var row in rows)
        {
            var prior = Catalog.Get(SessionCatalog.Text(row["id"])!);
            if (
                !JsonNode.DeepEquals(prior?["parentSessionId"], row["parentSessionId"])
                && SessionCatalog.Text(row["parentSessionId"]) is { } parent
                && SessionCatalog.Text(Catalog.Resolve(parent)["sessionId"]) is { } canonical
            )
                ids.Add(canonical);
        }
        return BeginMutation(ids, catalogDeleteOwner.Value);
    }

    private async Task ClaimDeleteAsync(DeleteOperation operation)
    {
        var ids = RemainingDeleteClaims(operation);
        Task[] pending;
        lock (lifecycle)
        {
            if (!accepting)
                throw new InvalidOperationException("Host is shutting down.");
            foreach (var id in ids)
                if (deletionClaims.TryGetValue(id, out var claim) && claim != operation)
                    throw new SessionDeletionException(
                        "Another deletion claim overlaps this selection.",
                        "SESSION_DELETE_IN_PROGRESS"
                    );
            foreach (var id in ids)
                deletionClaims[id] = operation;
            pending = mutationAdmissions
                .Where(pair => ids.Any(id => id == pair.Key || SameAdmittedLifetime(id, pair.Key)))
                .SelectMany(pair => pair.Value)
                .Select(done => done.Task)
                .Concat(
                    ids.Where(identities.ContainsKey).Select(id => identities[id].Finished.Task)
                )
                .Distinct()
                .ToArray();
        }
        await Task.WhenAll(pending);
    }

    private static string[] RemainingDeleteClaims(DeleteOperation operation) =>
        operation
            .Selection.Targets.Except(operation.Deleted, StringComparer.Ordinal)
            .Concat(
                operation.Recursive
                    ? []
                    : operation.Selection.Direct.Except(operation.Detached, StringComparer.Ordinal)
            )
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    private void ReleaseDelete(DeleteOperation operation)
    {
        string[] released;
        lock (lifecycle)
        {
            released = deletionClaims
                .Where(pair => pair.Value == operation)
                .Select(pair => pair.Key)
                .ToArray();
            var partial = partialDeletes.Values.Contains(operation);
            foreach (var id in released)
                if (
                    !partial
                    || !RemainingDeleteClaims(operation).Contains(id, StringComparer.Ordinal)
                )
                    deletionClaims.Remove(id);
            released = released.Where(id => !deletionClaims.ContainsKey(id)).ToArray();
            foreach (
                var id in crossDeletes
                    .Where(pair => pair.Value == operation)
                    .Select(pair => pair.Key)
                    .ToArray()
            )
                crossDeletes.Remove(id);
            operation.Running = false;
            deletionOperations.Remove(operation);
            operation.Finished.TrySetResult();
        }
        foreach (var id in released)
            if (
                Accepting
                && Find(id) is { } owner
                && !owner.Entry.Retired
                && !owner.Entry.WithState(state => state.Busy || state.Stopping)
                && owner.Registry.HasRunnableWork(owner.Entry)
            )
                _ = owner.StartProcessing();
    }

    private async Task DeleteStageAsync(DeleteOperation operation, string stage, string id)
    {
        operation.Stage = stage;
        operation.FailedId = id;
        if (BeforeDeleteStage is { } before)
            await before(stage, id);
        var marker = Path.Combine(
            root,
            "state",
            "experiment-faults",
            SessionIdentity.ExecDirectorySegment(id) + ".delete-" + stage
        );
        if (File.Exists(marker))
        {
            File.Delete(marker);
            throw new IOException("Injected experimental deletion failure at " + stage + ".");
        }
        var hold = marker + "-hold";
        if (!File.Exists(hold))
            return;
        await File.WriteAllTextAsync(hold + ".reached", "reached");
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (File.Exists(hold) && DateTime.UtcNow < deadline)
            await Task.Delay(2);
        if (File.Exists(hold))
            throw new TimeoutException("Experimental deletion barrier expired.");
    }

    private void AssertDeleteSource(DeleteOperation operation)
    {
        if (operation.Source is null)
            return;
        if (
            Find(operation.Source) is not { } owner
            || !ReferenceEquals(owner, operation.SourceOwner)
            || !IsCurrentOwner(owner)
        )
            throw new SessionDeletionException(
                "Deletion source is no longer current.",
                "SESSION_DELETE_SOURCE_NOT_FOUND",
                404
            );
    }
}
