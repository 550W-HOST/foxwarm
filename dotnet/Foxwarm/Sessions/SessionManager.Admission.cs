using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private sealed class IdentitySlot(bool creating)
    {
        internal readonly bool Creating = creating;
        internal bool CatalogCreated;
        internal bool Retired,
            Retiring;
        internal readonly TaskCompletionSource<SessionOwner> Owner = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly TaskCompletionSource Finished = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
    }

    private readonly Dictionary<string, IdentitySlot> identities = new(StringComparer.Ordinal);
    private readonly HashSet<TaskCompletionSource> creations = [];
    private readonly ConcurrentDictionary<string, SemaphoreSlim> creationKeys = new(
        StringComparer.Ordinal
    );
    private readonly CancellationTokenSource admissionStop = new();
    private volatile bool servicesReady;
    private readonly AsyncLocal<CancellationToken?> semanticCaller = new();

    private sealed class SendReceiptBox
    {
        internal string? Target { get; set; }
    }

    private readonly AsyncLocal<SendReceiptBox?> successfulSendReceipt = new();

    internal void BeginSuccessfulSendReceipt() =>
        successfulSendReceipt.Value = new SendReceiptBox();

    internal string? ConsumeSuccessfulSendReceipt()
    {
        var value = successfulSendReceipt.Value?.Target;
        successfulSendReceipt.Value = null;
        return value;
    }

    internal Func<string, CancellationToken, Task>? BeforeAdmissionRead { get; set; }
    internal Action<string>? AdmissionReadObserved { get; set; }

    internal async Task<SessionOwner?> GetExistingAsync(
        string requestedId,
        CancellationToken cancellationToken = default,
        bool forDeletion = false,
        bool acceptedTimer = false
    )
    {
        if (!cancellationToken.CanBeCanceled)
            cancellationToken = semanticCaller.Value ?? default;
        await EnsureIdentityStartupAsync();
        while (true)
        {
            await WaitForIdentityMutationAsync(requestedId, cancellationToken);
            IdentitySlot? slot;
            IdentityMoveOperation? moving;
            lock (lifecycle)
            {
                if (!accepting && !acceptedTimer)
                    throw new InvalidOperationException("Host is shutting down.");
                identityMoveClaims.TryGetValue(requestedId, out moving);
                identities.TryGetValue(requestedId, out slot);
            }
            if (moving is not null && moving != owningIdentityMove.Value)
            {
                await moving.Finished.Task.WaitAsync(cancellationToken);
                continue;
            }
            if (slot is not null)
            {
                if (slot.Retired || slot.Retiring)
                    throw new SessionDeletionException(
                        "Session authority is retired pending deletion cleanup.",
                        "SESSION_STATE_UNAVAILABLE"
                    );
                var owner = await slot.Owner.Task.WaitAsync(cancellationToken);
                await WaitForIdentityMutationAsync(owner.Id, cancellationToken);
                owner.Entry.RequireIdentityAuthority();
                return owner;
            }
            // Main identity resolution may read SQLite. It never runs under the owner registry gate.
            var canonical = SessionCatalog.Text(Catalog.Resolve(requestedId)["sessionId"]);
            string? id = null;
            bool start = false;
            lock (lifecycle)
            {
                if (!accepting && !acceptedTimer)
                    throw new InvalidOperationException("Host is shutting down.");
                identityMoveClaims.TryGetValue(requestedId, out moving);
                if (moving is null && canonical is not null)
                    identityMoveClaims.TryGetValue(canonical, out moving);
                if (moving is null || moving == owningIdentityMove.Value)
                {
                    if (identities.TryGetValue(requestedId, out slot))
                        id = requestedId;
                    else if (canonical is not null)
                    {
                        id = canonical;
                        if (deletionClaims.ContainsKey(id) && !forDeletion)
                            throw new SessionDeletionException(
                                "Session is being deleted.",
                                "SESSION_DELETE_IN_PROGRESS"
                            );
                        if (!identities.TryGetValue(id, out slot))
                        {
                            slot = new(false);
                            identities.Add(id, slot);
                            start = true;
                        }
                    }
                }
            }
            if (moving is not null && moving != owningIdentityMove.Value)
            {
                await moving.Finished.Task.WaitAsync(cancellationToken);
                continue;
            }
            if (id is null)
                return null;
            if (start)
                _ = LoadOwnerAsync(id, slot!, acceptedTimer);
            var admitted = await slot!.Owner.Task.WaitAsync(cancellationToken);
            await WaitForIdentityMutationAsync(admitted.Id, cancellationToken);
            admitted.Entry.RequireIdentityAuthority();
            return admitted;
        }
    }

    internal async Task<SessionOwner> RequiredAsync(
        string id,
        CancellationToken cancellationToken = default
    ) =>
        await GetExistingAsync(id, cancellationToken)
        ?? throw new InvalidDataException($"Session `{id}` not found.");

    private async Task LoadOwnerAsync(string id, IdentitySlot slot, bool acceptedTimer = false)
    {
        try
        {
            var token = acceptedTimer ? CancellationToken.None : admissionStop.Token;
            token.ThrowIfCancellationRequested();
            if (BeforeAdmissionRead is { } before)
                await before(id, token);
            AdmissionReadObserved?.Invoke(id);
            var row =
                Catalog.Get(id)
                ?? throw new InvalidDataException(
                    "Cataloged Session membership disappeared during admission."
                );
            var agent = SessionCatalog.Text(row["agent"])!;
            if (!SessionIdentity.IsValid(id) || !agents.Exists(agent))
                throw new InvalidDataException(
                    "Catalog Session binding is unsupported or its Agent is missing."
                );
            var store = MakeStore(id, agent);
            var snapshot =
                await store.LoadAsync(id)
                ?? throw new SessionAuthorityUnavailableException(id,
                    new(null, "Cataloged Session authority is missing."));
            AgentMemory.NormalizePersistedSelection(snapshot.AuthorityEnvelope);
            var recoveringBusy = snapshot.Busy;
            snapshot = recoveringBusy ? RecoverBusySnapshot(snapshot) : snapshot;
            token.ThrowIfCancellationRequested();
            var owner = MakeSession(id, agent, store);
            owner.Registry.Add(id, snapshot);
            BindMutations(owner);
            if (recoveringBusy)
                await owner.Entry.SaveLane.SaveStrictAsync(token);
            PublishOwner(owner, slot, acceptedTimer);
            if (servicesReady && !IsDeletionClaimed(owner.Id))
                WaitTransition(owner.Id);
        }
        catch (Exception error)
        {
            FailIdentity(id, slot, error);
        }
        finally
        {
            slot.Finished.TrySetResult();
        }
    }

    private static SessionSnapshot RecoverBusySnapshot(SessionSnapshot snapshot)
    {
        var queue = snapshot.Queue.Select(item => item.CloneItem()).ToList();
        if (queue.LastOrDefault() is not { } last || !HasTrailingResumeEvent(last))
        {
            queue.Add(
                new QueueItem(
                    QueueItemType.Background,
                    [
                        new JsonObject
                        {
                            ["system"] = SessionBoundary.SystemEvent(
                                "session-resumed",
                                "The Foxwarm process restarted while this session was busy. Foxwarm is resuming session processing."
                            ),
                        },
                    ]
                )
            );
        }
        return snapshot with
        {
            Queue = queue,
            Busy = false,
            BusyStartedAt = null,
            Stopping = false,
        };
    }

    private static bool HasTrailingResumeEvent(QueueItem item)
    {
        if (
            item.Type != QueueItemType.Background
            || item.Source is not null
            || item.Message is not null
            || item.Parts is null
            || item.Parts.Count != 1
        )
            return false;
        var system = SessionWait.Text(item.Parts[0]["system"]);
        if (system is null)
            return false;
        var match = Regex.Match(
            system,
            "^<foxwarm-system\\s+(?<attributes>[^>]*)\\s*/>$",
            RegexOptions.CultureInvariant
        );
        if (!match.Success)
            return false;
        var attributes = match.Groups["attributes"].Value;
        return Regex.IsMatch(
                attributes,
                "(?:^|\\s)kind=\"event\"(?:\\s|$)",
                RegexOptions.CultureInvariant
            )
            && Regex.IsMatch(
                attributes,
                "(?:^|\\s)type=\"session-resumed\"(?:\\s|$)",
                RegexOptions.CultureInvariant
            );
    }

    internal static void ValidateExecutionEnvironment(
        JsonObject envelope,
        string workspace,
        string processCwd
    )
    {
        var node = SessionGoal.Trim(SessionWait.Text(envelope["currentNode"]) ?? "");
        if (node.Length > 0 && node != "master")
            Foxwarm.Nodes.NodeProviderRegistry.ValidateId(node);
    }

    private void PublishOwner(SessionOwner owner, IdentitySlot slot, bool acceptedTimer = false)
    {
        lock (lifecycle)
        {
            if (!accepting)
                owner.Registry.Runner.CloseAdmission();
            if (!slot.Creating && !acceptedTimer)
                admissionStop.Token.ThrowIfCancellationRequested();
            if (
                !identities.TryGetValue(owner.Id, out var current)
                || current != slot
                || !sessions.TryAdd(owner.Id, owner)
            )
                throw new InvalidOperationException("Session identity collision after validation.");
        }
        owner.EnableCommittedNotifications();
        try
        {
            NotifyCreated(owner);
        }
        finally
        {
            slot.Owner.TrySetResult(owner);
        }
    }

    private void FailIdentity(string id, IdentitySlot slot, Exception error)
    {
        lock (lifecycle)
        {
            if (
                !sessions.ContainsKey(id)
                && identities.TryGetValue(id, out var current)
                && current == slot
            )
                identities.Remove(id);
            slot.Owner.TrySetException(error);
        }
        _ = slot.Owner.Task.Exception; // A failed creator can have no joining caller.
    }

    private async Task<SessionOwner> WithCreationIdentityAsync(
        string id,
        Func<Task<SessionOwner>> action
    )
    {
        using var membership = BeginAgentAdmission(SessionIdentity.Agent(id));
        if (Catalog.Get(id) is not null)
            throw new InvalidDataException($"Session ID '{id}' is already reserved.");
        IdentitySlot slot;
        lock (lifecycle)
        {
            RequireIdentityAction([id]);
            RequireAgentCreation(SessionIdentity.Agent(id));
            if (deletionClaims.ContainsKey(id))
                throw new SessionDeletionException(
                    "Session ID is claimed for deletion.",
                    "SESSION_DELETE_IN_PROGRESS"
                );
            if (sessions.ContainsKey(id) || identities.ContainsKey(id))
                throw new InvalidDataException($"Session ID '{id}' is already reserved.");
            slot = new(true);
            identities.Add(id, slot);
        }
        try
        {
            return await action();
        }
        catch (Exception error)
        {
            FailIdentity(id, slot, error);
            throw;
        }
        finally
        {
            slot.Finished.TrySetResult();
        }
    }

    private sealed class CreationOperation(SessionManager manager, TaskCompletionSource completion)
        : IDisposable
    {
        public void Dispose()
        {
            lock (manager.lifecycle)
            {
                manager.creations.Remove(completion);
                completion.TrySetResult();
            }
        }
    }

    private IDisposable TrackCreation()
    {
        lock (lifecycle)
        {
            if (!accepting)
                throw new InvalidOperationException("Host is shutting down.");
            var completion = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            creations.Add(completion);
            return new CreationOperation(this, completion);
        }
    }

    private SemaphoreSlim CreationKey(string key) => creationKeys.GetOrAdd(key, _ => new(1, 1));

    private async Task DrainPublicationsAsync()
    {
        Task[] pending;
        lock (lifecycle)
        {
            accepting = false;
            pending = identities
                .Values.Select(slot => slot.Finished.Task)
                .Concat(creations.Select(value => value.Task))
                .Concat(deletionOperations.Select(operation => operation.Finished.Task))
                .Concat(
                    mutationAdmissions.Values.SelectMany(set => set).Select(value => value.Task)
                )
                .ToArray();
        }
        admissionStop.Cancel();
        await Task.WhenAll(pending);
    }
}

internal sealed class UnsupportedSessionExecutionEnvironmentException(string message)
    : InvalidOperationException(message);
