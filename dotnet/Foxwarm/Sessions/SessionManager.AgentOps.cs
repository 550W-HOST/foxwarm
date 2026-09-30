using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed class CommittedSessionCreationException(string? sessionId, string message, Exception inner,
    bool? initialDeliveryCommitted = null)
    : IOException(message, inner)
{
    public string? SessionId { get; } = sessionId;
    public bool? InitialDeliveryCommitted { get; } = initialDeliveryCommitted;
}

internal sealed partial class SessionManager
{
    private readonly SemaphoreSlim identityGate = new(1, 1);

    public string[] Agents() => agents.List();
    public string AgentDirectory(string name) => agents.AgentDirectory(name);

    public async Task<(string AgentName, string? MainSessionId)> CreateAgentAsync(string agentName,
        bool createMainSession = true, string? initialMemory = null, string? inherit = null)
    {
        if (!accepting) throw new InvalidOperationException("Host is shutting down.");
        inherit = string.IsNullOrWhiteSpace(inherit) ? null : inherit.Trim();
        await identityGate.WaitAsync();
        try
        {
            try { await agents.CreateAsync(agentName, initialMemory, inherit); }
            catch (AuthorityCommittedException error)
            {
                throw new CommittedSessionCreationException(null,
                    $"Agent '{agentName}' catalog was committed, but its final durability step failed; no main Session was created.", error);
            }
            if (!createMainSession) return (agentName, null);
            try
            {
                var session = await CreateNamedLockedAsync(agentName, "main", null, null, null, null);
                return (agentName, session.Id);
            }
            catch (Exception error)
            {
                throw new CommittedSessionCreationException((error as CommittedSessionCreationException)?.SessionId,
                    $"Agent '{agentName}' was created, but its main Session creation did not complete: {error.Message}", error);
            }
        }
        finally { identityGate.Release(); }
    }

    public async Task<SessionOwner> CreateNamedAsync(string agentName, string sessionName, string? displayName,
        JsonObject? forceModel)
    {
        await identityGate.WaitAsync();
        try { return await CreateNamedLockedAsync(agentName, sessionName, null, displayName, null, forceModel); }
        finally { identityGate.Release(); }
    }

    public async Task<(SessionOwner Child, bool Delivered)> CreateChildAsync(SessionOwner parent, string suffix,
        string? targetAgent, string? displayName, string? initialMessage, JsonObject? forceModel)
    {
        if (string.IsNullOrEmpty(suffix) || !System.Text.RegularExpressions.Regex.IsMatch(suffix, "^[a-zA-Z0-9_-]+$"))
            throw new InvalidDataException("Child suffix must use only letters, numbers, hyphens and underscores.");
        targetAgent ??= parent.Agent;
        AgentCatalog.ValidateName(targetAgent);
        if (!agents.Exists(targetAgent)) throw new InvalidDataException("Target Agent does not exist.");
        await identityGate.WaitAsync();
        SessionOwner child;
        try
        {
            var parentId = parent.Id;
            var baseId = targetAgent != parent.Agent ? SessionIdentity.Build(targetAgent, suffix)
                : parentId.Split('/').Last() == "main"
                    ? SessionIdentity.Build(targetAgent, suffix)
                    : parentId + "_" + suffix;
            var candidate = baseId;
            for (var serial = 2; await IdReservedAsync(candidate); serial++)
                candidate = baseId + "_" + serial.ToString(CultureInfo.InvariantCulture);
            var parentEnvelope = parent.Entry.Snapshot().AuthorityEnvelope;
            var childRawModel = forceModel?["modelId"]?.GetValue<string>()
                ?? parentEnvelope["childModelDefault"]?.GetValue<string>()
                ?? parentEnvelope["model"]?.GetValue<string>();
            var childRawEffort = forceModel?["effort"]?.GetValue<string>()
                ?? parentEnvelope["childEffortDefault"]?.GetValue<string>()
                ?? parentEnvelope["effort"]?.GetValue<string>();
            child = await CreateNamedLockedAsync(targetAgent, candidate[(candidate.IndexOf('/') + 1)..], parentId,
                displayName, (childRawModel, childRawEffort), forceModel, candidate);
            try
            {
                var time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var system = $"<foxwarm-system kind=\"session-boundary\" event=\"new-child\" parentSessionId=\"{Escape(parentId)}\" currentSessionId=\"{Escape(child.Id)}\" />\n"
                    + "You are a child session (new, empty context). Report completed work to your parent using send_to_session({sessionId: \"<parent>\", message: \"...\", afterSend: \"finish\"}).";
                await child.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
                {
                    var message = new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(new JsonObject { ["system"] = system }),
                        ["__meta"] = new JsonObject { ["timestamp"] = time, ["seq"] = state.NextMessageSeq }
                    };
                    var snapshot = state.Snapshot();
                    var meta = (JsonObject)snapshot.Meta.DeepClone();
                    meta["messageCount"] = snapshot.History.Count + 1;
                    return new CanonicalAppendPreparation(snapshot with
                    {
                        History = snapshot.History.Append(message).ToArray(),
                        NextMessageSeq = snapshot.NextMessageSeq + 1,
                        Meta = meta
                    }, [message], live =>
                    {
                        live.History.Add((JsonObject)message.DeepClone());
                        live.NextMessageSeq++;
                        live.Meta["messageCount"] = live.History.Count;
                    });
                });
                child.Entry.InvokeCommitted(child.Entry.Snapshot());
            }
            catch (Exception error)
            {
                throw new CommittedSessionCreationException(child.Id,
                    $"Child Session '{child.Id}' was committed but its boundary message failed: {error.Message}", error);
            }
        }
        finally { identityGate.Release(); }
        if (string.IsNullOrEmpty(initialMessage)) return (child, false);
        try { await SendAsync(parent, child.Id, initialMessage); }
        catch (Exception error)
        {
            var committed = error is AuthorityCommittedException;
            throw new CommittedSessionCreationException(child.Id,
                committed
                    ? $"Child Session '{child.Id}' and its initial message were committed, but delivery durability failed: {error.Message}"
                    : $"Child Session '{child.Id}' was committed but its initial message was not delivered: {error.Message}",
                error, committed);
        }
        return (child, true);
    }

    public async Task<string> SendAsync(SessionOwner source, string requestedTarget, string message)
    {
        var targetId = requestedTarget switch
        {
            "<parent>" => source.Entry.Snapshot().AuthorityEnvelope["parentSessionId"]?.GetValue<string>()
                is { Length: > 0 } parent ? parent : throw new InvalidDataException("This Session has no parent."),
            "<main>" => SessionIdentity.Build(source.Agent, "main"),
            _ => requestedTarget
        };
        var target = Find(targetId) ?? throw new InvalidDataException($"Target Session '{requestedTarget}' not found.");
        if (source.Id == target.Id) throw new InvalidDataException("A Session cannot send to itself.");
        if (!accepting) throw new InvalidOperationException("Host is shutting down.");
        var relation = source.Entry.Snapshot().AuthorityEnvelope["parentSessionId"]?.GetValue<string>() == target.Id
            ? "direct-child"
            : target.Entry.Snapshot().AuthorityEnvelope["parentSessionId"]?.GetValue<string>() == source.Id ? "parent" : "other";
        var now = DateTimeOffset.Now;
        var offset = now.ToString("zzz", CultureInfo.InvariantCulture).Replace(":", "", StringComparison.Ordinal);
        var time = now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + offset;
        var wrapper = $"<foxwarm-message type=\"inter-agent\" sourceSessionId=\"{Escape(source.Id)}\" "
            + $"replyTargetSessionId=\"{Escape(source.Id)}\" replyVia=\"send_to_session\" time=\"{Escape(time)}\" "
            + "hint=\"inter-agent message from another session, not direct end-user input\">\n"
            + message + "\n</foxwarm-message>";
        var item = new QueueItem(QueueItemType.Intersession, [new JsonObject { ["system"] = wrapper }],
            SourceSessionId: source.Id, SourceSessionRelation: relation);
        try { await target.Entry.SaveLane.CommitInterSessionAsync(item); }
        catch (AuthorityCommittedException)
        {
            if (Accepting && target.Entry.WithState(state => !state.Busy && !state.Stopping && state.Queue.Count > 0)) target.Registry.Trigger(target.Id);
            throw;
        }
        if (Accepting && target.Entry.WithState(state => !state.Busy && !state.Stopping && state.Queue.Count > 0)) target.Registry.Trigger(target.Id);
        return target.Id;
    }

    public async Task<string> RefreshSnapshotAsync(SessionOwner session)
    {
        var snapshot = session.Entry.Snapshot();
        var modelId = ConditionalMemory.ReadCurrentModelSnapshotId(
            snapshot.AuthorityEnvelope["persistentMemorySnapshot"]?.GetValue<string>() ?? "")
            ?? models.Select(snapshot).Model.Key;
        var value = await memory.BuildAsync(session.Agent, session.Id, modelId);
        await session.Entry.SaveLane.CommitMemorySnapshotAsync(value);
        return modelId;
    }

    private async Task<SessionOwner> CreateNamedLockedAsync(string agentName, string sessionName, string? parentId,
        string? displayName, (string? Model, string? Effort)? inherited, JsonObject? forceModel, string? exactId = null)
    {
        if (!accepting) throw new InvalidOperationException("Host is shutting down.");
        if (!agents.Exists(agentName)) throw new InvalidDataException($"Agent '{agentName}' does not exist.");
        var id = exactId ?? SessionIdentity.Build(agentName, sessionName);
        if (!SessionIdentity.IsValid(id) || SessionIdentity.Agent(id) != agentName)
            throw new InvalidDataException("Invalid Session identity.");
        if (await IdReservedAsync(id)) throw new InvalidDataException($"Session ID '{id}' is already reserved.");
        if (parentId is not null && Find(parentId) is null)
            throw new InvalidDataException("Parent Session does not exist.");
        var (model, effort) = ValidateModelSettings(inherited, forceModel);
        var concreteModel = models.Resolve(model);
        var snapshotText = await memory.BuildAsync(agentName, id, concreteModel.Key);
        var store = MakeStore(id, agentName);
        var hosted = MakeSession(id, agentName, store);
        var entry = hosted.Registry.Add(id);
        entry.WithState(state =>
        {
            state.Meta["lastMessageTime"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            state.AuthorityEnvelope["agent"] = agentName;
            if (parentId is not null) state.AuthorityEnvelope["parentSessionId"] = parentId;
            if (displayName is not null) state.AuthorityEnvelope["displayName"] = displayName;
            if (model is not null) state.AuthorityEnvelope["model"] = model;
            if (effort is not null) state.AuthorityEnvelope["effort"] = effort;
            state.AuthorityEnvelope["persistentMemorySnapshot"] = snapshotText;
            state.AuthorityEnvelope["promptCacheKey"] = Guid.NewGuid().ToString("N");
        });
        try { await entry.SaveLane.SaveStrictAsync(); }
        catch (AuthorityCommittedException error)
        {
            PublishCreated(hosted);
            throw new CommittedSessionCreationException(id,
                $"Session '{id}' was committed but the final durability step failed.", error);
        }
        PublishCreated(hosted);
        return hosted;
    }

    private void PublishCreated(SessionOwner session)
    {
        if (!sessions.TryAdd(session.Id, session)) throw new InvalidOperationException("Session identity collision after persistence.");
        session.EnableCommittedNotifications();
        NotifyCreated(session);
    }

    private (string? Model, string? Effort) ValidateModelSettings((string? Model, string? Effort)? inherited,
        JsonObject? forceModel)
    {
        if (forceModel is not null && (forceModel.Count > 2 || forceModel.Any(pair => pair.Key is not ("modelId" or "effort"))))
            throw new InvalidDataException("forceModel accepts only modelId and effort.");
        if (forceModel?.ContainsKey("modelId") == true && forceModel["modelId"] is not JsonValue
            || forceModel?.ContainsKey("effort") == true && forceModel["effort"] is not JsonValue)
            throw new InvalidDataException("forceModel values must be concrete model and effort strings.");
        var model = forceModel?["modelId"] is JsonNode modelValue
            ? modelValue is JsonValue m && m.TryGetValue<string>(out var id) && models.Contains(id)
                ? id : throw new InvalidDataException("Unsupported requested concrete model.")
            : inherited?.Model;
        if (model is not null && !models.Contains(model)) model = null;
        var leaf = models.Resolve(model);
        var effort = forceModel?["effort"] is JsonNode effortValue
            ? effortValue is JsonValue e && e.TryGetValue<string>(out var raw) && leaf.AllowedEfforts.Contains(raw, StringComparer.Ordinal)
                ? raw : throw new InvalidDataException("Requested model effort is not allowed.")
            : inherited?.Effort;
        if (effort is not null && !leaf.AllowedEfforts.Contains(effort, StringComparer.Ordinal)) effort = null;
        return (model, effort);
    }

    private async Task<bool> IdReservedAsync(string id)
    {
        if (Find(id) is not null || File.Exists(Path.Combine(root, "state", "sessions", id + ".json"))) return true;
        var archive = Path.Combine(root, "state", "archive-store.sqlite");
        if (!File.Exists(archive)) return false;
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = archive, Mode = SqliteOpenMode.ReadOnly }.ToString());
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT 1 FROM archive_messages WHERE session_id=$id UNION SELECT 1 FROM archive_blocks WHERE session_id=$id LIMIT 1";
        command.Parameters.AddWithValue("$id", id);
        return await command.ExecuteScalarAsync() is not null;
    }

    private PersistentSessionAuthorityStore MakeStore(string id, string agent)
    {
        var marker = Path.Combine(root, "state", "experiment-faults", SessionIdentity.ExecDirectorySegment(id) + ".snapshot-before-rename");
        var legacyCreateMarker = Path.Combine(root, "state", "experiment-faults", "legacy-create-after-rename");
        return new PersistentSessionAuthorityStore(root, id, agent, stage =>
        {
            if (SessionSaveLane.IsSettingsCommit)
            {
                var suffix = stage == AtomicJsonWriteStage.BeforeRename ? ".settings-before-rename" : stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync ? ".settings-after-rename" : null;
                if (suffix is not null)
                {
                    var settingsMarker = Path.Combine(root, "state", "experiment-faults", SessionIdentity.ExecDirectorySegment(id) + suffix);
                    if (File.Exists(settingsMarker)) { File.Delete(settingsMarker); throw new IOException("Injected experimental settings commit failure."); }
                }
            }
            if (SessionSaveLane.IsGoalCommit)
            {
                var suffix = stage == AtomicJsonWriteStage.BeforeRename ? ".goal-before-rename"
                    : stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync ? ".goal-after-rename" : null;
                if (suffix is not null)
                {
                    var goalMarker = Path.Combine(root, "state", "experiment-faults", SessionIdentity.ExecDirectorySegment(id) + suffix);
                    if (File.Exists(goalMarker)) { File.Delete(goalMarker); throw new IOException("Injected experimental goal commit failure."); }
                }
            }
            if (SessionSaveLane.IsWaitCommit)
            {
                var suffix = stage == AtomicJsonWriteStage.BeforeRename ? ".wait-before-rename"
                    : stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync ? ".wait-after-rename" : null;
                if (suffix is not null)
                {
                    var waitMarker = Path.Combine(root, "state", "experiment-faults", SessionIdentity.ExecDirectorySegment(id) + suffix);
                    if (File.Exists(waitMarker)) { File.Delete(waitMarker); throw new IOException("Injected experimental wait commit failure."); }
                }
            }
            if (stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync && SessionIdentity.IsLegacyGenerated(id)
                && Find(id) is null && File.Exists(legacyCreateMarker))
            {
                File.Delete(legacyCreateMarker);
                throw new IOException("Injected experimental legacy Session post-rename failure.");
            }
            if (stage != AtomicJsonWriteStage.BeforeRename || !SessionSaveLane.IsSnapshotCommit || !File.Exists(marker)) return;
            File.Delete(marker);
            throw new IOException("Injected experimental memory snapshot pre-rename failure.");
        });
    }

    private void ValidateParentGraph()
    {
        foreach (var session in sessions.Values)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal) { session.Id };
            var parent = session.Entry.Snapshot().AuthorityEnvelope["parentSessionId"]?.GetValue<string>();
            while (!string.IsNullOrEmpty(parent))
            {
                if (!seen.Add(parent) || Find(parent) is not { } ancestor)
                    throw new InvalidDataException("Session parent relation is missing or cyclic.");
                parent = ancestor.Entry.Snapshot().AuthorityEnvelope["parentSessionId"]?.GetValue<string>();
            }
        }
    }

    private static string Escape(string text) => text.Replace("&", "&amp;", StringComparison.Ordinal)
        .Replace("<", "&lt;", StringComparison.Ordinal).Replace(">", "&gt;", StringComparison.Ordinal)
        .Replace("\"", "&quot;", StringComparison.Ordinal).Replace("'", "&apos;", StringComparison.Ordinal);
}
