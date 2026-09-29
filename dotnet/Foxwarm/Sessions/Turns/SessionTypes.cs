using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

public enum QueueItemType
{
    User,
    Intersession,
    Background,
    Trigger,
    OnBoot,
    CompactCommit,
    Tools,
    Retry,
    Wait,
    Managed,
    Channel,
}

public sealed record QueueSource(
    string Platform,
    string ChannelUserId,
    string? ChannelId = null,
    string? ChannelType = null,
    string? ConversationId = null,
    string? Username = null,
    string? SenderId = null,
    JsonObject? OpenFields = null);

public sealed record QueueItem(
    QueueItemType Type,
    IReadOnlyList<JsonObject>? Parts = null,
    JsonObject? Message = null,
    QueueSource? Source = null,
    string? ClientMessageId = null,
    string? SourceSessionId = null,
    string? SourceSessionRelation = null,
    JsonObject? OpenFields = null)
{
    public static QueueItem UserText(string text, QueueSource? source = null, string? clientMessageId = null) =>
        new(QueueItemType.User, new[] { new JsonObject { ["text"] = text } }, null, source, clientMessageId);

    public static QueueItem Prebuilt(JsonObject message, QueueSource? source = null) =>
        new(QueueItemType.User, null, (JsonObject)message.DeepClone(), source);

    public QueueItem CloneItem() => this with
    {
        Parts = Parts?.Select(p => (JsonObject)p.DeepClone()).ToArray(),
        Message = Message is null ? null : (JsonObject)Message.DeepClone(),
        Source = Source is null ? null : Source with { OpenFields = Source.OpenFields is null ? null : (JsonObject)Source.OpenFields.DeepClone() },
        OpenFields = OpenFields is null ? null : (JsonObject)OpenFields.DeepClone()
    };
}

public sealed class SessionState
{
    public string Id { get; }
    public List<JsonObject> History { get; } = new();
    public List<QueueItem> Queue { get; } = new();
    public bool Busy { get; internal set; }
    public long? BusyStartedAt { get; internal set; }
    public bool Stopping { get; internal set; }
    public JsonObject Meta { get; } = new();
    public long NextMessageSeq { get; internal set; } = 1;
    public long HistoryVersion { get; internal set; }
    public JsonObject AuthorityEnvelope { get; } = new();

    public SessionState(string id) => Id = id;

    // Invoked only after the staged Archive→JSON rewrite has committed, while
    // SessionEntry owns the short publication gate. Queue/Stop/model metadata
    // are deliberately not replaced by the older compaction snapshot.
    public void PublishCommittedHistoryRewrite(IReadOnlyList<JsonObject> history,
        long expectedHistoryVersion, long expectedNextSeq, long nextSeq, long? nextBlockId = null)
    {
        if (HistoryVersion != expectedHistoryVersion || NextMessageSeq != expectedNextSeq)
            throw new InvalidOperationException("History rewrite publication base changed after authority commit.");
        History.Clear();
        History.AddRange(history.Select(row => (JsonObject)row.DeepClone()));
        NextMessageSeq = nextSeq;
        HistoryVersion++;
        Meta["messageCount"] = History.Count;
        if (nextBlockId is not null) AuthorityEnvelope["nextBlockId"] = nextBlockId.Value;
    }

    internal SessionState Clone()
    {
        var clone = new SessionState(Id)
        {
            Busy = Busy,
            BusyStartedAt = BusyStartedAt,
            Stopping = Stopping,
            NextMessageSeq = NextMessageSeq,
            HistoryVersion = HistoryVersion,
        };
        clone.History.AddRange(History.Select(message => (JsonObject)message.DeepClone()));
        clone.Queue.AddRange(Queue.Select(item => item.CloneItem()));
        foreach (var property in Meta) clone.Meta[property.Key] = property.Value?.DeepClone();
        foreach (var property in AuthorityEnvelope) clone.AuthorityEnvelope[property.Key] = property.Value?.DeepClone();
        return clone;
    }

    public SessionSnapshot Snapshot()
    {
        var clone = Clone();
        return new SessionSnapshot(
            clone.Id,
            clone.History.Select(m => (JsonObject)m.DeepClone()).ToArray(),
            clone.Queue.Select(i => i.CloneItem()).ToArray(),
            clone.Busy,
            clone.BusyStartedAt,
            clone.Stopping,
            (JsonObject)clone.Meta.DeepClone(),
            clone.NextMessageSeq,
            clone.HistoryVersion,
            (JsonObject)clone.AuthorityEnvelope.DeepClone());
    }
}

public sealed record SessionSnapshot(
    string Id,
    IReadOnlyList<JsonObject> History,
    IReadOnlyList<QueueItem> Queue,
    bool Busy,
    long? BusyStartedAt,
    bool Stopping,
    JsonObject Meta,
    long NextMessageSeq,
    long HistoryVersion,
    JsonObject AuthorityEnvelope);

public enum SaveKind
{
    Strict,
    BestEffort,
}

public interface ISessionAuthorityStore
{
    Task CommitAsync(SessionSnapshot snapshot, SaveKind kind, CancellationToken cancellationToken = default);
    Task<SessionSnapshot?> LoadAsync(string sessionId, CancellationToken cancellationToken = default);
}

public interface ICanonicalAppendAuthorityStore
{
    Task CommitCanonicalAppendAsync(
        SessionSnapshot stagedSnapshot,
        IReadOnlyList<JsonObject> appendedMessages,
        CancellationToken cancellationToken = default);
}

public interface ICompactionAuthorityStore
{
    Task CommitCompactionAsync(SessionSnapshot stagedSnapshot, IReadOnlyList<ArchiveBlockRecord> blocks,
        IReadOnlyList<JsonObject> messages, CancellationToken cancellationToken = default);
}

public sealed record CompactionPreparation(SessionSnapshot StagedSnapshot,
    IReadOnlyList<ArchiveBlockRecord> Blocks, IReadOnlyList<JsonObject> ArchivedMessages, Action<SessionState> Publish);

internal sealed record CanonicalAppendPreparation(
    SessionSnapshot StagedSnapshot,
    IReadOnlyList<JsonObject> AppendedMessages,
    Action<SessionState> Publish);

/// <summary>Test-only authority snapshot store. It proves ordering and round-trip cloning only.</summary>
