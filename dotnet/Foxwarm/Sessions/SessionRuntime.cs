using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal enum SessionEventKind
{
    MessageCommitted,
    StateChanged,
    ModelStream,
    RequestProgress,
    DraftChanged,
    ProcessingError,
    CommandReply,
    Deleted,
}

internal sealed record SessionRuntimeEvent(string SessionId, SessionEventKind Kind, JsonNode? Data);

internal sealed record SessionMetadata(
    string Id,
    string Agent,
    string? ParentSessionId,
    string? DisplayName,
    bool Busy,
    bool Stopping,
    long? BusyStartedAt,
    int QueueLength,
    int MessageCount,
    long NextMessageSeq,
    long HistoryVersion,
    double LastMessageTime,
    bool Archived,
    bool Pinned,
    double? SidebarOrder,
    string? Model,
    string? Effort,
    double CachedTokens,
    double InputTokens,
    double OutputTokens,
    JsonObject? Wait = null,
    string? ChildModel = null,
    string? ChildEffort = null,
    double? CompactThreshold = null
);

/// <summary>Session-semantic in-process API. Channels receive cloned projections, never mutable owners.</summary>
internal sealed class SessionRuntime(SessionManager manager)
{
    internal SessionManager Manager => manager;
    internal Action<string>? SemanticOwnerLookupObserved { get; set; }

    public SessionOwner? Owner(string id)
    {
        SemanticOwnerLookupObserved?.Invoke(id);
        return manager.Find(id);
    }

    public Task<SessionOwner?> GetOwnerAsync(
        string id,
        CancellationToken cancellationToken = default
    ) => manager.GetExistingAsync(id, cancellationToken);

    public JsonObject? GetSession(string id) => Owner(id)?.BuildDto();

    public JsonObject[] ListSessions() => manager.ListPresentations();

    internal (long Total, JsonObject[] Page) ListPage(int start, int count) =>
        manager.CatalogMetadataOffset(start, count);

    internal SessionCatalog Catalog => manager.Catalog;
    internal string PresentationRevision => manager.PresentationRevision;

    internal JsonObject[] LocalProjections() => manager.LocalProjections();

    internal JsonObject[] Projections(string[] ids, bool includeLocal = false) =>
        manager.CatalogPresentations(ids, includeLocal);

    internal JsonObject? Projection(string id) => Projections([id]).FirstOrDefault();

    public event Action<SessionRuntimeEvent> Changed
    {
        add => manager.Changed += value;
        remove => manager.Changed -= value;
    }
    public event Action TopologyChanged
    {
        add => manager.TopologyChanged += value;
        remove => manager.TopologyChanged -= value;
    }

    internal async Task QueueTriggerAsync(string id, string text)
    {
        var owner = await manager.RequiredAsync(id);
        await SubmitExternalAsync(
            owner,
            new QueueItem(
                QueueItemType.Trigger,
                [new JsonObject { ["system"] = SessionBoundary.SessionEvent("trigger", text) }]
            ),
            () =>
            {
                if (!manager.Accepting)
                    throw new InvalidOperationException("Host is shutting down.");
            }
        );
    }

    public async Task ContinueAsync(string id) =>
        await (await manager.RequiredAsync(id)).StartProcessing(retry: true);

    public async Task SubmitAndRunAsync(string id, QueueItem item)
    {
        var owner = await manager.RequiredAsync(id);
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, item);
    }

    internal async Task SubmitAndRunAsync(
        SessionOwner owner,
        QueueItem item,
        Action? beforeAdmission = null
    )
    {
        await manager.WaitForIdentityMutationAsync(owner.Id);
        manager.RequireFileIngressOwner(owner);
        if (beforeAdmission is null)
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, item);
        else
            await owner.Registry.Ingress.EnqueueCheckedAsync(owner.Id, item, beforeAdmission);
    }

    internal async Task SubmitExternalAsync(
        SessionOwner owner,
        QueueItem item,
        Action beforeAdmission
    )
    {
        await manager.WaitForIdentityMutationAsync(owner.Id);
        // Text-only external admission has no attachment/Node materialization dependency.
        owner.Entry.RequireIdentityAuthority();
        if (!ReferenceEquals(manager.Find(owner.Id), owner))
            throw new InvalidOperationException(
                "External input Session owner is no longer current."
            );
        await owner.Registry.Ingress.EnqueueExternalAsync(owner.Id, item, beforeAdmission);
    }

    public async Task<JsonObject> UpdateSettingsAsync(string id, JsonObject settings) =>
        await (await manager.RequiredAsync(id)).UpdateModelAsync(settings);

    internal PresentationChange ChangePresentation(
        Func<SessionCatalog, PresentationChange> action
    ) => manager.ChangePresentation(action);

    internal void ReplyToCommand(string id, string text) => manager.ReplyToCommand(id, text);

    internal Task<JsonObject> MoveIdentityAsync(SessionOwner caller, JsonObject args) =>
        manager.MoveIdentityAsync(caller, args);

    internal Task<JsonObject> DeleteAsync(
        string id,
        bool recursive = false,
        SessionOwner? source = null
    ) => manager.DeleteAsync(id, recursive, source);

    public Task UpdateDisplayNameAsync(string id, string? name) => manager.RenameAsync(id, name);

    public async Task<string> RefreshSnapshotAsync(string id) =>
        await manager.RefreshSnapshotAsync(await manager.RequiredAsync(id));

    public async Task<StopResult> StopAsync(string id)
    {
        var owner = await manager.RequiredAsync(id);
        if (owner.Compactor.Standalone)
            return new(false, false);
        var result = await owner.Registry.Control.StopAsync(owner.Id);
        await owner.DrainForegroundAsync();
        return result;
    }

    public async Task<ClearHistoryResult> ClearHistoryAsync(string id) =>
        await manager.ClearAsync(await manager.RequiredAsync(id));

    public async Task<SessionOwner> ForkAsync(string id, string? suffix = null) =>
        await manager.ForkAsync(await manager.RequiredAsync(id), suffix);

    public async Task<SessionOwner> ForkCommandAsync(string id, string suffix, string? message)
    {
        var parent = await manager.RequiredAsync(id);
        var child = await manager.ForkAsync(parent, suffix, childMode: true);
        var delivered = false;
        if (message is not null)
        {
            try
            {
                await SubmitAndRunAsync(child, QueueItem.UserText(message));
                delivered = true;
            }
            catch (Exception error)
            {
                throw new CommittedSessionCreationException(
                    child.Id,
                    $"Forked Session '{child.Id}' was committed but its initial message delivery failed.",
                    error,
                    error is AuthorityCommittedException
                );
            }
        }
        try
        {
            await manager.NotifyManualForkAsync(parent, child, message);
        }
        catch (Exception error)
        {
            throw new CommittedSessionCreationException(
                child.Id,
                $"Forked Session '{child.Id}' was committed but the parent notice failed.",
                error,
                delivered,
                error is AuthorityCommittedException
            );
        }
        return child;
    }

    public async Task<DequeueResult> DequeueAsync(string id)
    {
        var owner = await manager.RequiredAsync(id);
        return await owner.Registry.Control.DequeueAsync(owner.Id);
    }
}

internal sealed partial class SessionOwner
{
    internal Func<SessionMetadata, SessionMetadata>? MainMetadata { get; init; }
    internal Func<string, string?>? ResolveBoundNode { get; init; }

    internal string ExecutionNode(JsonObject authority) =>
        SessionManager.ResolveExecutionNode(authority, ResolveBoundNode?.Invoke(Agent));

    public SessionMetadata Metadata()
    {
        var result = Entry.WithState(state =>
        {
            var envelope = state.AuthorityEnvelope;
            static string? Text(JsonNode? node) =>
                node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
            static double Number(JsonNode? node) => SessionWait.Number(node) ?? 0;
            static bool Flag(JsonNode? node) =>
                node is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
            return new SessionMetadata(
                Id,
                Agent,
                Text(envelope["parentSessionId"]),
                Text(envelope["displayName"]),
                state.Busy,
                state.Stopping,
                state.BusyStartedAt,
                state.Queue.Count(SessionCompactor.Ordinary),
                state.History.Count,
                state.NextMessageSeq,
                state.HistoryVersion,
                Number(state.Meta["lastMessageTime"]),
                Flag(envelope["archived"]),
                Flag(envelope["pinned"]),
                envelope["sidebarOrder"] is JsonValue order
                && order.TryGetValue<double>(out var rawOrder)
                    ? rawOrder
                    : null,
                Text(envelope["model"]),
                Text(envelope["effort"]),
                Number(envelope["stats"]?["totalCachedTokens"]),
                Number(envelope["stats"]?["totalInputTokens"]),
                Number(envelope["stats"]?["totalOutputTokens"]),
                SessionRuntimeState.WaitProjection(state.Meta),
                Text(envelope["childModelDefault"]),
                Text(envelope["childEffortDefault"]),
                SessionWait.Number(envelope["compactThresholdTokens"])
            );
        });
        return MainMetadata?.Invoke(result) ?? result;
    }

    public JsonObject BuildDto() => BuildDto(Metadata());

    public JsonObject BuildDto(SessionMetadata meta)
    {
        var dto = SessionPresentation.Build(meta, models, ResolveAncestry, ToolActive, Compacting);
        dto["runtimeState"] = RuntimeSnapshot(meta);
        Entry.WithState(state =>
        {
            dto["currentNode"] = ExecutionNode(state.AuthorityEnvelope);
            dto["cwd"] = state.AuthorityEnvelope["cwd"]?.DeepClone();
        });
        return dto;
    }
}
