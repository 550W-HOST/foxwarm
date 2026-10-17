using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

/// <summary>
/// Bounded C2 adapter: active JSON remains authoritative while Archive rows are immutable audit records.
/// All calls are expected to be serialized by one SessionSaveLane.
/// </summary>
public sealed class PersistentSessionAuthorityStore
    : ISessionAuthorityStore,
        ICanonicalAppendAuthorityStore,
        ICompactionAuthorityStore
{
    private string sessionId;
    private string agent;
    private LinuxAtomicJsonFile authorityFile;
    private SqliteArchiveMessageStore archive;
    private readonly string root;
    internal Foxwarm.Images.ImageBlobStore Images { get; }
    private readonly Action<AtomicJsonWriteStage>? authorityStageHook;
    private readonly Func<int, CancellationToken, Task>? canonicalCommitBarrier;
    private int canonicalCommitCount;
    private readonly Action<SessionSnapshot>? publishProjection;
    private readonly Func<JsonObject?>? mainFields;
    private readonly Action? checkLifetime;
    private volatile bool retired;
    private Exception? identityUnavailable;

    internal void MarkIdentityUnavailable(Exception error) =>
        Volatile.Write(ref identityUnavailable, error);

    internal void Retire() => retired = true;

    private void CheckWrite()
    {
        if (Volatile.Read(ref identityUnavailable) is { } error)
            throw error;
        if (retired)
            throw new InvalidOperationException("Session authority owner has retired.");
        checkLifetime?.Invoke();
    }

    public PersistentSessionAuthorityStore(
        string root,
        string sessionId,
        string agent = "main",
        Action<AtomicJsonWriteStage>? authorityStageHook = null,
        Func<int, CancellationToken, Task>? canonicalCommitBarrier = null,
        Action<SessionSnapshot>? publishProjection = null,
        Func<JsonObject?>? mainFields = null,
        Action? checkLifetime = null
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(agent);
        this.root = root;
        Images = new(root);
        this.authorityStageHook = authorityStageHook;
        this.sessionId = sessionId;
        this.agent = agent;
        this.canonicalCommitBarrier = canonicalCommitBarrier;
        this.publishProjection = publishProjection;
        this.mainFields = mainFields;
        this.checkLifetime = checkLifetime;
        authorityFile = new LinuxAtomicJsonFile(
            root,
            $"state/sessions/{sessionId}.json",
            authorityStageHook
        );
        archive = new SqliteArchiveMessageStore(
            Path.Combine(root, "state", "archive-store.sqlite"),
            sessionId
        );
        archive.Initialize();
    }

    internal string SessionId => sessionId;
    internal string Agent => agent;

    internal void RebindIdentity(string id, string targetAgent)
    {
        // Caller owns the ordered lane; no old-bound commit can overlap replacement.
        var next = new SqliteArchiveMessageStore(ArchivePath, id);
        next.Initialize();
        sessionId = id;
        agent = targetAgent;
        archive = next;
        authorityFile = new LinuxAtomicJsonFile(
            root,
            $"state/sessions/{id}.json",
            authorityStageHook
        );
    }

    public string AuthorityPath => authorityFile.FilePath;
    public string ArchivePath => archive.DatabasePath;
    public DirectorySyncResult LastDirectorySyncResult => authorityFile.LastDirectorySyncResult;
    public SqliteArchiveMessageStore Archive => archive;

    internal bool IsIdentitySnapshotCommit { get; private set; }

    internal Task PersistIdentitySnapshotAsync(SessionSnapshot snapshot)
    {
        ValidateBoundSnapshot(snapshot);
        IsIdentitySnapshotCommit = true;
        try
        {
            authorityFile.Write(ToAuthority(snapshot));
            return Task.CompletedTask;
        }
        finally
        {
            IsIdentitySnapshotCommit = false;
        }
    }

    public Task CommitAsync(
        SessionSnapshot snapshot,
        SaveKind kind,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateBoundSnapshot(snapshot);
        authorityFile.Write(ToAuthority(snapshot));
        PublishProjection(snapshot);
        return Task.CompletedTask;
    }

    public async Task CommitCanonicalAppendAsync(
        SessionSnapshot stagedSnapshot,
        IReadOnlyList<JsonObject> appendedMessages,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateBoundSnapshot(stagedSnapshot);
        var records = appendedMessages.Select(ToArchiveRecord).ToArray();
        var receipt = await archive.EnqueueMessagesAsync(records).ConfigureAwait(false);
        IReadOnlyList<ArchiveMessageRecord> inserted = [];
        try
        {
            // Build, validate and serialize the owned snapshot while Archive persistence is pending.
            var payload = ToAuthority(stagedSnapshot).ToJson(indented: true);
            if (canonicalCommitBarrier is not null)
                await canonicalCommitBarrier(
                        Interlocked.Increment(ref canonicalCommitCount),
                        cancellationToken
                    )
                    .ConfigureAwait(false);
            inserted = await receipt.Completion.ConfigureAwait(false);
            authorityFile.WriteTextPayload(payload, default);
        }
        catch (AuthorityCommittedException)
        {
            throw;
        }
        catch (Exception writeError)
        {
            try
            {
                // Preparation can fail before the receipt settles. Resolve it before exact compensation.
                inserted = await receipt.Completion.ConfigureAwait(false);
                archive.RollbackInsertedMessages(inserted);
            }
            catch (Exception rollbackError)
            {
                if (ReferenceEquals(writeError, rollbackError))
                    throw;
                throw new AggregateException(
                    "Authority precommit failed and exact Archive rollback also failed.",
                    writeError,
                    rollbackError
                );
            }
            throw;
        }
        PublishProjection(stagedSnapshot);
    }

    public async Task CommitCompactionAsync(
        SessionSnapshot stagedSnapshot,
        IReadOnlyList<ArchiveBlockRecord> blocks,
        IReadOnlyList<JsonObject> messages,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateBoundSnapshot(stagedSnapshot);
        var receipt = await archive
            .EnqueueCompactionAsync(blocks, messages.Select(ToArchiveRecord).ToArray())
            .ConfigureAwait(false);
        IReadOnlyList<ArchiveBlockRecord> newBlocks = [];
        IReadOnlyList<ArchiveMessageRecord> newMessages = [];
        try
        {
            var payload = ToAuthority(stagedSnapshot).ToJson(indented: true);
            (newBlocks, newMessages) = await receipt.Completion.ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            authorityFile.WriteTextPayload(payload, cancellationToken);
        }
        catch (AuthorityCommittedException)
        {
            throw;
        }
        catch (Exception error)
        {
            try
            {
                (newBlocks, newMessages) = await receipt.Completion.ConfigureAwait(false);
                archive.RollbackInsertedMessages(newMessages);
                archive.RollbackInsertedBlocks(newBlocks);
            }
            catch (Exception rollback)
            {
                if (ReferenceEquals(error, rollback))
                    throw;
                throw new AggregateException("Compact precommit rollback failed.", error, rollback);
            }
            throw;
        }
        PublishProjection(stagedSnapshot);
    }

    private void PublishProjection(SessionSnapshot snapshot)
    {
        try
        {
            publishProjection?.Invoke(snapshot);
        }
        catch (Exception error)
        {
            throw new AuthorityCommittedException(
                "Session authority committed, but its Main catalog projection failed.",
                error
            );
        }
    }

    public async Task<SessionSnapshot?> LoadAsync(
        string requestedSessionId,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (requestedSessionId != sessionId)
            throw new InvalidOperationException(
                $"Persistent store is bound to Session '{sessionId}', not '{requestedSessionId}'."
            );
        if (!File.Exists(authorityFile.FilePath))
        {
            if (archive.ReadMessages().Count > 0)
                throw new InvalidDataException(
                    "Active Session authority is missing while Archive rows exist; Archive cannot rebuild active history."
                );
            return null;
        }
        JsonObject raw;
        try
        {
            raw =
                JsonNode.Parse(File.ReadAllText(authorityFile.FilePath)) as JsonObject
                ?? throw new InvalidDataException("Session authority must be an object.");
        }
        catch (System.Text.Json.JsonException error)
        {
            throw new InvalidDataException("Session authority is malformed JSON.", error);
        }
        var normalized = SessionCatalog.NormalizeAuthority(raw, sessionId, agent);
        if (mainFields?.Invoke() is { } main)
            SessionCatalog.OverlayAuthorityContext(normalized, main);
        SessionAuthorityDocument.Validate(normalized, sessionId, agent);
        foreach (var message in ((JsonArray)normalized["history"]!).OfType<JsonObject>())
            await Images.ExternalizeMessageAsync(message, strict: false, cancellationToken);
        var loaded = FromAuthority(normalized);
        foreach (var item in loaded.Queue)
        {
            if (item.Message is not null)
                await Images.ExternalizeMessageAsync(
                    item.Message,
                    strict: false,
                    cancellationToken
                );
            if (item.Parts is not null)
            {
                var wrapper = new JsonObject
                {
                    ["parts"] = new JsonArray(
                        item.Parts.Select(part => (JsonNode)part.DeepClone()).ToArray()
                    ),
                };
                await Images.ExternalizeMessageAsync(wrapper, strict: false, cancellationToken);
                foreach (var (part, index) in item.Parts.Select((part, index) => (part, index)))
                    if (wrapper["parts"] is JsonArray parts && parts.Count == item.Parts.Count)
                    {
                        part.Clear();
                        foreach (var pair in parts[index]!.AsObject())
                            part[pair.Key] = pair.Value?.DeepClone();
                    }
            }
        }
        await Images.ExternalizeTreeAsync(loaded.Meta, strict: false, cancellationToken);
        return loaded;
    }

    private void ValidateBoundSnapshot(SessionSnapshot snapshot)
    {
        CheckWrite();
        if (snapshot.Id != sessionId)
            throw new InvalidOperationException(
                $"Persistent store is bound to Session '{sessionId}', not '{snapshot.Id}'."
            );
    }

    private ArchiveMessageRecord ToArchiveRecord(JsonObject message)
    {
        var meta =
            message["__meta"] as JsonObject
            ?? throw new InvalidDataException("Canonical appended message requires __meta.");
        var seq = ReadInteger(meta["seq"], "message seq");
        var timestamp = ReadNumber(meta["timestamp"], "message timestamp");
        return ArchiveMessageRecord.Create(sessionId, agent, seq, timestamp, message);
    }

    private SessionAuthorityDocument ToAuthority(SessionSnapshot snapshot)
    {
        var root = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
        if (mainFields?.Invoke() is { } main)
            SessionCatalog.OverlayAuthorityContext(root, main);
        foreach (var field in new[] { "archived", "pinned", "sidebarOrder" })
            root.Remove(field);
        root["sessionStateVersion"] = 1;
        if (root["goalState"] is JsonObject goal)
            goal.Remove("remindOnTurnEnd");
        root["agent"] = agent;
        root["history"] = new JsonArray(
            snapshot.History.Select(message => (JsonNode)message.ToJson()).ToArray()
        );
        root["persistentMemorySnapshot"] ??= "";
        root["queue"] = new JsonArray(
            snapshot.Queue.Select(ToQueueJson).Cast<JsonNode>().ToArray()
        );
        root["stats"] ??= new JsonObject
        {
            ["totalCachedTokens"] = 0,
            ["totalInputTokens"] = 0,
            ["totalOutputTokens"] = 0,
            ["lastUsage"] = null,
        };
        var meta = (JsonObject)snapshot.Meta.DeepClone();
        meta.Remove("lastChannel");
        meta["lastMessageTime"] ??= 0;
        meta["messageCount"] = snapshot.History.Count;
        root["meta"] = meta;
        root["busy"] = snapshot.Busy;
        root["busyStartedAt"] = snapshot.BusyStartedAt;
        root["stopping"] = snapshot.Stopping;
        root["historyVersion"] = snapshot.HistoryVersion;
        root["lastAppliedMailboxId"] = 0;
        root["nextMessageSeq"] = snapshot.NextMessageSeq;
        root["nextBlockId"] ??= 1;
        return SessionAuthorityDocument.FromOwned(root, sessionId, agent);
    }

    private SessionSnapshot FromAuthority(JsonObject root)
    {
        var history = SessionHistory.FromJson(((JsonArray)root["history"]!).OfType<JsonObject>());
        var envelope = new JsonObject();
        foreach (var property in root)
            if (property.Key is not ("history" or "queue" or "meta"))
                envelope[property.Key] = property.Value?.DeepClone();
        var queue = ((JsonArray)root["queue"]!)
            .Select(node => FromQueueJson((JsonObject)node!))
            .ToArray();
        var busy = root["busy"]!.GetValue<bool>();
        long? busyStartedAt = root["busyStartedAt"] is JsonValue busyNode
            ? ReadInteger(busyNode, "busyStartedAt")
            : null;
        var stopping = root["stopping"]?.GetValue<bool>() ?? false;
        return new SessionSnapshot(
            sessionId,
            history,
            queue,
            busy,
            busyStartedAt,
            stopping,
            (JsonObject)root["meta"]!.DeepClone(),
            ReadInteger(root["nextMessageSeq"], "nextMessageSeq"),
            ReadInteger(root["historyVersion"], "historyVersion"),
            envelope
        );
    }

    internal static JsonObject ToQueueJson(QueueItem item)
    {
        if (item.Type == QueueItemType.CompactCommit)
            return new JsonObject { ["type"] = "compact-commit" };
        var result = item.OpenFields is null
            ? new JsonObject()
            : (JsonObject)item.OpenFields.DeepClone();
        result.Remove("queuedInput");
        if (item.QueuedInput)
            result["queuedInput"] = true;
        result.Remove("trigger");
        if (!item.Trigger)
            result["trigger"] = false;
        result["type"] = item.Type switch
        {
            QueueItemType.User => "user",
            QueueItemType.Intersession => "intersession",
            QueueItemType.Background => "background",
            QueueItemType.Trigger => "trigger",
            QueueItemType.OnBoot => "onboot",
            _ => throw new UnsupportedSessionTurnException($"persisted queue type {item.Type}"),
        };
        if (item.Source is null)
            result.Remove("source");
        else
        {
            var source = item.Source.OpenFields is null
                ? new JsonObject()
                : (JsonObject)item.Source.OpenFields.DeepClone();
            source["platform"] = item.Source.Platform;
            source["channelUserId"] = item.Source.ChannelUserId;
            SetOptional(source, "channelId", item.Source.ChannelId);
            SetOptional(source, "channelType", item.Source.ChannelType);
            SetOptional(source, "conversationId", item.Source.ConversationId);
            SetOptional(source, "username", item.Source.Username);
            SetOptional(source, "senderId", item.Source.SenderId);
            result["source"] = source;
        }
        SetOptional(result, "clientMessageId", item.ClientMessageId);
        SetOptional(result, "sourceSessionId", item.SourceSessionId);
        SetOptional(result, "sourceSessionRelation", item.SourceSessionRelation);
        if (item.Parts is null)
            result.Remove("parts");
        else
            result["parts"] = new JsonArray(
                item.Parts.Select(part => (JsonNode)part.DeepClone()).ToArray()
            );
        if (item.Message is null)
            result.Remove("message");
        else
            result["message"] = item.Message.DeepClone();
        return result;
    }

    internal static QueueItem FromQueueJson(JsonObject value)
    {
        var type = value["type"]!.GetValue<string>() switch
        {
            "user" => QueueItemType.User,
            "intersession" => QueueItemType.Intersession,
            "background" => QueueItemType.Background,
            "trigger" => QueueItemType.Trigger,
            "onboot" => QueueItemType.OnBoot,
            "compact-commit" => QueueItemType.CompactCommit,
            var unsupported => throw new UnsupportedSessionTurnException(
                $"persisted queue type {unsupported}"
            ),
        };
        QueueSource? source = null;
        if (value["source"] is JsonObject sourceJson)
            source = new QueueSource(
                sourceJson["platform"]!.GetValue<string>(),
                sourceJson["channelUserId"]!.GetValue<string>(),
                OptionalString(sourceJson, "channelId"),
                OptionalString(sourceJson, "channelType"),
                OptionalString(sourceJson, "conversationId"),
                OptionalString(sourceJson, "username"),
                OptionalString(sourceJson, "senderId"),
                (JsonObject)sourceJson.DeepClone()
            );
        var parts = value["parts"] is JsonArray partArray
            ? partArray.Select(node => (JsonObject)node!.DeepClone()).ToArray()
            : null;
        return new QueueItem(
            type,
            parts,
            value["message"] is JsonObject message ? (JsonObject)message.DeepClone() : null,
            source,
            OptionalString(value, "clientMessageId"),
            OptionalString(value, "sourceSessionId"),
            OptionalString(value, "sourceSessionRelation"),
            (JsonObject)value.DeepClone(),
            value["trigger"] is JsonValue trigger
            && trigger.TryGetValue<bool>(out var shouldTrigger)
                ? shouldTrigger
                : true
        )
        {
            QueuedInput =
                value["queuedInput"] is JsonValue queued
                && queued.TryGetValue<bool>(out var observed)
                && observed,
        };
    }

    private static void SetOptional(JsonObject value, string property, string? content)
    {
        if (content is null)
            value.Remove(property);
        else
            value[property] = content;
    }

    private static string? OptionalString(JsonObject value, string property) =>
        value[property] is JsonValue node && node.TryGetValue<string>(out var result)
            ? result
            : null;

    private static long ReadInteger(JsonNode? node, string label)
    {
        var number = ReadNumber(node, label);
        if (number != Math.Truncate(number) || number < long.MinValue || number > long.MaxValue)
            throw new InvalidDataException($"{label} must be an integer.");
        return checked((long)number);
    }

    private static double ReadNumber(JsonNode? node, string label)
    {
        if (node is not JsonValue value)
            throw new InvalidDataException($"{label} must be numeric.");
        double number;
        if (value.TryGetValue<double>(out var direct))
            number = direct;
        else if (value.TryGetValue<long>(out var signed))
            number = signed;
        else if (value.TryGetValue<int>(out var integer))
            number = integer;
        else
            throw new InvalidDataException($"{label} must be numeric.");
        if (!double.IsFinite(number))
            throw new InvalidDataException($"{label} must be finite.");
        return number;
    }
}
