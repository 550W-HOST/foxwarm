using Foxwarm.Limits;
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
        internal bool CreatedCold;
        internal bool Retired,
            Retiring;
        internal readonly TaskCompletionSource<SessionOwner> Owner = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly TaskCompletionSource Finished = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );

        // The latest semantic admission (monotonic milliseconds) and a count of admissions,
        // which orders admissions within one clock tick; both change under lifecycle.
        internal long LastUse = Environment.TickCount64;
        internal long Uses;
        internal int ActiveUses;

        // When the owner was published (monotonic milliseconds): the start of its publication
        // grace against memory pressure, which lookups don't renew.
        internal long Published;

        internal void Touch()
        {
            LastUse = Environment.TickCount64;
            Uses++;
        }
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

    // Observes a cold load starting to read its history, after its owner admission.
    internal Action<SessionOwner>? OwnerLookupReturned { get; set; }
    internal Action<string>? HistoryReadStarting { get; set; }

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
                if (slot is not null)
                    slot.Touch();
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
                        SessionDeletionException.RetiredMessage,
                        "SESSION_STATE_UNAVAILABLE"
                    );
                var owner = await slot.Owner.Task.WaitAsync(cancellationToken);
                await WaitForIdentityMutationAsync(owner.Id, cancellationToken);
                owner.Entry.RequireIdentityAuthority();
                OwnerLookupReturned?.Invoke(owner);
                return owner;
            }
            // Main identity resolution may read SQLite. It never runs under the owner registry gate.
            var canonical = await Catalog.QueryAsync(() => SessionCatalog.Text(Catalog.Resolve(requestedId)["sessionId"]));
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
                    if (slot is not null)
                        slot.Touch();
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
            OwnerLookupReturned?.Invoke(admitted);
            return admitted;
        }
    }

    internal async Task<SessionOwner> RequiredAsync(
        string id,
        CancellationToken cancellationToken = default
    ) =>
        await GetExistingAsync(id, cancellationToken)
        ?? throw new InvalidDataException($"Session `{id}` not found.");

    // A short-lived use prevents idle retirement across lookup and effect. Deletion, identity
    // moves and shutdown retain their own admission rules; none wait for this residency lease.
    internal sealed class OwnerUse(SessionOwner owner, Action release) : IDisposable
    {
        private Action? end = release;
        internal SessionOwner Owner => owner;
        public void Dispose() => Interlocked.Exchange(ref end, null)?.Invoke();
    }

    internal OwnerUse? TryUseOwner(SessionOwner owner)
    {
        lock (lifecycle)
        {
            if (!IsCurrentOwner(owner) || !identities.TryGetValue(owner.Id, out var slot))
                return null;
            slot.ActiveUses++;
            return new(owner, () =>
            {
                bool lastUse;
                lock (lifecycle)
                    lastUse = --slot.ActiveUses == 0;
                if (lastUse)
                    admission?.HotOwners.OwnerMayBeIdle();
            });
        }
    }

    internal async Task<OwnerUse?> UseExistingAsync(string id, CancellationToken token = default,
        bool acceptedTimer = false)
    {
        while (await GetExistingAsync(id, token, acceptedTimer: acceptedTimer) is { } owner)
        {
            token.ThrowIfCancellationRequested();
            if (TryUseOwner(owner) is { } use)
                return use;
        }
        return null;
    }

    internal async Task<OwnerUse> UseRequiredAsync(string id, CancellationToken token = default) =>
        await UseExistingAsync(id, token) ?? throw new InvalidDataException($"Session `{id}` not found.");

    private async Task LoadOwnerAsync(string id, IdentitySlot slot, bool acceptedTimer = false)
    {
        HotOwnerBudget.Charge? charge = null;
        IDisposable? hydration = null;
        try
        {
            // A delivery accepted before a normal stop may finish its cold load. A failed
            // hosted startup cancels that generation's load even when no other caller waits.
            var token = acceptedTimer ? producers?.StartupAborted ?? CancellationToken.None : admissionStop.Token;
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
            // Owner admission before the history is read: room in the tenant's and the
            // replica's hot-owner budgets for the persisted history, then one of the tenant's
            // hydration slots, so waiting loads hold no history.
            if (Admission is { } limits)
            {
                charge = await ReserveHotOwnerAsync(
                    await store.PersistedHistoryBytesAsync(token) ?? 0,
                    token
                );
                hydration = await limits.Hydrations.EnterAsync(token);
            }
            HistoryReadStarting?.Invoke(id);
            var snapshot =
                await store.LoadAsync(id)
                ?? throw new SessionAuthorityUnavailableException(
                    id,
                    new(null, SessionAuthorityErrors.CatalogedMissingReason)
                );
            AgentMemory.NormalizePersistedSelection(snapshot.AuthorityEnvelope);
            var recoveringBusy = snapshot.Busy;
            // A pending approval belonged to a waiter of the previous process; nothing replays it.
            JsonObject[] expired = [];
            if (SessionApprovals.Pending(snapshot.Meta).Length > 0)
            {
                var meta = (JsonObject)snapshot.Meta.DeepClone();
                expired = SessionApprovals.ExpireStale(meta);
                snapshot = snapshot with { Meta = meta };
            }
            snapshot = recoveringBusy
                ? RecoverBusySnapshot(snapshot, ExpiredApprovalText(expired))
                : snapshot;
            token.ThrowIfCancellationRequested();
            // The loaded history's own estimate; growth beyond the reservation doesn't wait.
            charge?.Resize(HotOwnerBudget.Estimate(HistoryJsonBytes(snapshot.History)));
            var owner = MakeSession(id, agent, store);
            owner.Registry.Add(id, snapshot);
            BindMutations(owner);
            if (recoveringBusy || expired.Length > 0)
                await owner.Entry.SaveLane.SaveStrictAsync(token);
            // The charge becomes the resident owner's at its registry insertion.
            PublishOwner(owner, slot, acceptedTimer, charge);
            charge = null;
            if (servicesReady && !IsDeletionClaimed(owner.Id))
                WaitTransition(owner.Id);
        }
        catch (Exception error)
        {
            FailIdentity(id, slot, error);
        }
        finally
        {
            // A charge not taken over by a resident owner returns.
            if (charge is not null && !OwnsHotCharge(charge))
                charge.Dispose();
            hydration?.Dispose();
            slot.Finished.TrySetResult();
        }
    }

    private static SessionSnapshot RecoverBusySnapshot(
        SessionSnapshot snapshot,
        string? expiredApprovals = null
    )
    {
        if (ClaudeRuntimeState.IsExternal(snapshot.AuthorityEnvelope))
        {
            var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
            if (SessionWait.Text(envelope["externalRuntime"]?["status"]) != "new")
                envelope["externalRuntime"]!["status"] = "interrupted";
            return snapshot with
            {
                Busy = false,
                BusyStartedAt = null,
                Stopping = false,
                AuthorityEnvelope = envelope,
            };
        }
        var queue = snapshot.Queue.Select(item => item.CloneItem()).ToList();
        if (
            queue.LastOrDefault() is not { } last
            || !HasTrailingResumeEvent(last)
            || expiredApprovals is not null
        )
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
                                    + (expiredApprovals is null ? "" : " " + expiredApprovals)
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

    private void PublishOwner(
        SessionOwner owner,
        IdentitySlot slot,
        bool acceptedTimer = false,
        HotOwnerBudget.Charge? charge = null
    )
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
            // The resident owner holds its hot-owner charge from here on, whatever happens next.
            RecordHotCharge(owner, charge);
            slot.Touch();
            slot.Published = slot.LastUse;
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
            var owner = await action();
            if (!slot.CreatedCold) return owner;
            // The catalog and authority are durable. Drop this creation claim and share
            // ordinary cold admission with concurrent lookups, including existing joiners.
            owner = null!;
            lock (lifecycle) identities.Remove(id);
            slot.Finished.TrySetResult();
            try
            {
                var loaded = await RequiredAsync(id);
                slot.Owner.TrySetResult(loaded);
                return loaded;
            }
            catch (Exception error)
            {
                slot.Owner.TrySetException(error); // Ordinary lookup waiters receive the cold-load failure.
                throw new CommittedSessionCreationException(id, $"Session '{id}' was created, but it couldn't be opened yet. Open it again in a moment.", error);
            }
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
