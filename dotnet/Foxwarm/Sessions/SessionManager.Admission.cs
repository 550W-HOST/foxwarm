using System.Collections.Concurrent;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private sealed class IdentitySlot(bool creating)
    {
        internal readonly bool Creating = creating;
        internal bool CatalogCreated;
        internal bool Retired, Retiring;
        internal readonly TaskCompletionSource<SessionOwner> Owner = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly TaskCompletionSource Finished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    private readonly Dictionary<string, IdentitySlot> identities = new(StringComparer.Ordinal);
    private readonly HashSet<TaskCompletionSource> creations = [];
    private readonly ConcurrentDictionary<string, SemaphoreSlim> creationKeys = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource admissionStop = new();
    private volatile bool servicesReady;
    private readonly AsyncLocal<CancellationToken?> semanticCaller = new();
    internal Func<string, CancellationToken, Task>? BeforeAdmissionRead { get; set; }
    internal Action<string>? AdmissionReadObserved { get; set; }

    internal async Task<SessionOwner?> GetExistingAsync(string requestedId, CancellationToken cancellationToken = default, bool forDeletion = false)
    {
        await archiveIdentities.InitializeAsync(Catalog);
        if (!cancellationToken.CanBeCanceled) cancellationToken = semanticCaller.Value ?? default;
        IdentitySlot? slot;
        lock (lifecycle)
        {
            if (!accepting) throw new InvalidOperationException("Host is shutting down.");
            identities.TryGetValue(requestedId, out slot);
        }
        if (slot is not null)
        {
            if (slot.Retired || slot.Retiring) throw new SessionDeletionException("Session authority is retired pending deletion cleanup.", "SESSION_STATE_UNAVAILABLE");
            return await slot.Owner.Task.WaitAsync(cancellationToken);
        }
        // Main identity resolution may read SQLite. It never runs under the owner registry gate.
        var canonical = SessionCatalog.Text(Catalog.Resolve(requestedId)["sessionId"]);
        string id; bool start = false;
        lock (lifecycle)
        {
            if (!accepting) throw new InvalidOperationException("Host is shutting down.");
            if (identities.TryGetValue(requestedId, out slot)) id = requestedId;
            else
            {
                if (canonical is null) return null;
                id = canonical;
                if (deletionClaims.ContainsKey(id) && !forDeletion) throw new SessionDeletionException("Session is being deleted.", "SESSION_DELETE_IN_PROGRESS");
                if (!identities.TryGetValue(id, out slot)) { slot = new(false); identities.Add(id, slot); start = true; }
            }
        }
        if (start) _ = LoadOwnerAsync(id, slot);
        return await slot.Owner.Task.WaitAsync(cancellationToken);
    }

    internal async Task<SessionOwner> RequiredAsync(string id, CancellationToken cancellationToken = default)
        => await GetExistingAsync(id, cancellationToken) ?? throw new InvalidDataException($"Session `{id}` not found.");

    private async Task LoadOwnerAsync(string id, IdentitySlot slot)
    {
        try
        {
            var token = admissionStop.Token;
            token.ThrowIfCancellationRequested();
            if (BeforeAdmissionRead is { } before) await before(id, token);
            await AdmissionBarrierAsync(id, token);
            AdmissionReadObserved?.Invoke(id); ObserveAdmission("read", id);
            var row = Catalog.Get(id) ?? throw new InvalidDataException("Cataloged Session membership disappeared during admission.");
            var agent = SessionCatalog.Text(row["agent"])!;
            if (!SessionIdentity.IsValid(id) || !agents.Exists(agent)) throw new InvalidDataException("Catalog Session binding is unsupported or its Agent is missing.");
            var store = MakeStore(id, agent);
            var snapshot = await store.LoadAsync(id) ?? throw new InvalidDataException("Cataloged Session authority is missing.");
            AgentMemory.NormalizePersistedSelection(snapshot.AuthorityEnvelope);
            ValidateExecutionEnvironment(snapshot.AuthorityEnvelope, agents.AgentDirectory(agent), Directory.GetCurrentDirectory());
            if (snapshot.Busy || snapshot.Stopping) throw new InvalidDataException("Non-idle Session cannot be resumed automatically by the experiment host.");
            token.ThrowIfCancellationRequested();
            var owner = MakeSession(id, agent, store); owner.Registry.Add(id, snapshot);
            BindMutations(owner);
            PublishOwner(owner, slot);
            if (servicesReady && !IsDeletionClaimed(owner.Id)) WaitTransition(owner.Id);
        }
        catch (Exception error) { FailIdentity(id, slot, error); }
        finally { slot.Finished.TrySetResult(); }
    }

    internal static void ValidateExecutionEnvironment(JsonObject envelope, string workspace, string processCwd)
    {
        var node = SessionGoal.Trim(SessionWait.Text(envelope["currentNode"]) ?? "");
        if (node.Length > 0 && node != "master")
            throw new UnsupportedSessionExecutionEnvironmentException($"The .NET host does not support this Session's execution environment: currentNode '{node}' is not master.");
        var cwd = SessionGoal.Trim(SessionWait.Text(envelope["cwd"]) ?? "");
        if (cwd.Length == 0) return;
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var expanded = cwd == "~" ? home : cwd.StartsWith("~/", StringComparison.Ordinal) || cwd.StartsWith("~\\", StringComparison.Ordinal) ? Path.Combine(home, cwd[2..]) : cwd;
        try
        {
            // Source file defaults resolve Session cwd directly. Source exec's default resolves
            // base=Session cwd and candidate=Session cwd; relative values can combine twice.
            var fileDefault = Path.GetFullPath(expanded, processCwd);
            var execDefault = Path.GetFullPath(Path.IsPathRooted(expanded) ? expanded : Path.Combine(expanded, expanded), processCwd);
            var configured = Path.TrimEndingDirectorySeparator(Path.GetFullPath(workspace));
            if (Path.TrimEndingDirectorySeparator(fileDefault) == configured && Path.TrimEndingDirectorySeparator(execDefault) == configured) return;
        }
        catch (ArgumentException) { } catch (NotSupportedException) { }
        throw new UnsupportedSessionExecutionEnvironmentException("The .NET host does not support this Session's execution environment: its cwd changes the configured Agent workspace defaults.");
    }

    private readonly object admissionObservationGate = new();
    private void ObserveAdmission(string stage, string id)
    {
        var marker = Path.Combine(root, "state", "experiment-faults", "record-admissions");
        if (!File.Exists(marker)) return;
        try { lock (admissionObservationGate) File.AppendAllText(marker + ".events", stage + " " + id + "\n"); }
        catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
    private async Task AdmissionBarrierAsync(string id, CancellationToken token)
    {
        var marker = Path.Combine(root, "state", "experiment-faults", SessionIdentity.ExecDirectorySegment(id) + ".admission-hold");
        if (!File.Exists(marker)) return;
        await File.WriteAllTextAsync(marker + ".reached", "reached", token);
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (File.Exists(marker) && DateTime.UtcNow < deadline) await Task.Delay(2, token);
        if (File.Exists(marker)) throw new TimeoutException("Experimental admission barrier expired.");
    }

    private async Task CreationPublicationBarrierAsync(string id)
    {
        var marker = Path.Combine(root, "state", "experiment-faults", SessionIdentity.ExecDirectorySegment(id) + ".creation-publication-hold");
        if (!File.Exists(marker)) return;
        await File.WriteAllTextAsync(marker + ".reached", "reached"); var deadline = DateTime.UtcNow.AddSeconds(15);
        while (File.Exists(marker) && DateTime.UtcNow < deadline) await Task.Delay(2);
        if (File.Exists(marker)) throw new TimeoutException("Experimental creation publication barrier expired.");
    }
    private void PublishOwner(SessionOwner owner, IdentitySlot slot)
    {
        lock (lifecycle)
        {
            if (!slot.Creating) admissionStop.Token.ThrowIfCancellationRequested();
            if (!identities.TryGetValue(owner.Id, out var current) || current != slot
                || !sessions.TryAdd(owner.Id, owner)) throw new InvalidOperationException("Session identity collision after validation.");
        }
        owner.EnableCommittedNotifications();
        try { NotifyCreated(owner); }
        finally { ObserveAdmission(slot.Creating ? "created" : "admitted", owner.Id); slot.Owner.TrySetResult(owner); }
    }

    private void FailIdentity(string id, IdentitySlot slot, Exception error)
    {
        lock (lifecycle)
        {
            if (!sessions.ContainsKey(id) && identities.TryGetValue(id, out var current) && current == slot) identities.Remove(id);
            slot.Owner.TrySetException(error);
        }
        _ = slot.Owner.Task.Exception; // A failed creator can have no joining caller.
    }

    private async Task<SessionOwner> WithCreationIdentityAsync(string id, Func<Task<SessionOwner>> action)
    {
        if (Catalog.Get(id) is not null) throw new InvalidDataException($"Session ID '{id}' is already reserved.");
        IdentitySlot slot;
        lock (lifecycle)
        {
            if (deletionClaims.ContainsKey(id)) throw new SessionDeletionException("Session ID is claimed for deletion.", "SESSION_DELETE_IN_PROGRESS");
            if (sessions.ContainsKey(id) || identities.ContainsKey(id))
                throw new InvalidDataException($"Session ID '{id}' is already reserved.");
            slot = new(true); identities.Add(id, slot);
        }
        try { return await action(); }
        catch (Exception error) { FailIdentity(id, slot, error); throw; }
        finally { slot.Finished.TrySetResult(); }
    }

    private sealed class CreationOperation(SessionManager manager, TaskCompletionSource completion) : IDisposable
    {
        public void Dispose() { lock (manager.lifecycle) { manager.creations.Remove(completion); completion.TrySetResult(); } }
    }
    private IDisposable TrackCreation()
    {
        lock (lifecycle)
        {
            if (!accepting) throw new InvalidOperationException("Host is shutting down.");
            var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            creations.Add(completion); return new CreationOperation(this, completion);
        }
    }
    private SemaphoreSlim CreationKey(string key) => creationKeys.GetOrAdd(key, _ => new(1, 1));
    private async Task DrainPublicationsAsync()
    {
        Task[] pending;
        lock (lifecycle)
        {
            accepting = false;
            pending = identities.Values.Select(slot => slot.Finished.Task).Concat(creations.Select(value => value.Task))
                .Concat(deletionOperations.Select(operation => operation.Finished.Task)).ToArray();
        }
        admissionStop.Cancel();
        await Task.WhenAll(pending);
    }
}

internal sealed class UnsupportedSessionExecutionEnvironmentException(string message) : InvalidOperationException(message);
