using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal enum SessionEventKind
{
    MessageCommitted,
    QueueHistoryAppended,
    StateChanged,
    ModelStream,
    RequestProgress,
    DraftChanged,
    ProcessingError,
    CommandReply,
    Deleted,
}

internal sealed record SessionRuntimeEvent(
    string SessionId,
    SessionEventKind Kind,
    JsonNode? Data,
    SessionSnapshot? Snapshot = null
);

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
    double? CompactThreshold = null,
    double? Cost = null,
    bool LlmFailed = false,
    string Runtime = "foxwarm",
    JsonObject? ExternalRuntime = null,
    JsonObject? Questions = null
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

    internal Task<JsonObject[]> ListSessionsAsync() => manager.CatalogPresentationsAsync(null, includeLocal: true);

    internal (long Total, JsonObject[] Page) ListPage(int start, int count) =>
        manager.CatalogMetadataOffset(start, count);

    internal ISessionCatalogStore Catalog => manager.Catalog;
    internal string PresentationRevision => manager.PresentationRevision;

    internal JsonObject[] LocalProjections() => manager.LocalProjections();

    internal JsonObject[] Projections(string[] ids, bool includeLocal = false) =>
        manager.CatalogPresentations(ids, includeLocal);

    internal Task<JsonObject[]> ProjectionsAsync(string[] ids, bool includeLocal = false) =>
        manager.CatalogPresentationsAsync(ids, includeLocal);

    internal JsonObject? Projection(string id) => Projections([id]).FirstOrDefault();

    public event Action<SessionRuntimeEvent> Changed
    {
        add => manager.Changed += value;
        remove => manager.Changed -= value;
    }
    internal void QueueBindingCheck(Func<Task> check) => manager.QueueBindingCheck(check);

    public event Action TopologyChanged
    {
        add => manager.TopologyChanged += value;
        remove => manager.TopologyChanged -= value;
    }

    public async Task ContinueAsync(string id)
    {
        using var use = await manager.UseRequiredAsync(id);
        await use.Owner.StartProcessing(retry: true);
    }

    public async Task SubmitAndRunAsync(string id, QueueItem item)
    {
        using var use = await manager.UseRequiredAsync(id);
        var owner = use.Owner;
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

    internal async Task SubmitChannelAsync(SessionOwner owner, QueueItem item, bool polled = false, string? receipt = null)
    {
        await manager.WaitForIdentityMutationAsync(owner.Id);
        owner.Entry.RequireIdentityAuthority();
        if (!ReferenceEquals(manager.Find(owner.Id), owner))
            throw new InvalidOperationException(
                "Channel input Session owner is no longer current."
            );
        if (polled)
            await owner.Registry.Ingress.EnqueuePolledInputAsync(owner.Id, item, receipt, () =>
            {
                if (!manager.Accepting) throw new OperationCanceledException();
            });
        else
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, item);
    }

    internal async Task SubmitExternalAsync(
        SessionOwner owner,
        QueueItem item,
        Action beforeAdmission
    )
    {
        await RequireExternalOwnerAsync(owner);
        await owner.Registry.Ingress.EnqueueExternalAsync(owner.Id, item, beforeAdmission);
    }

    /// <summary>
    /// Strictly admits one verified webhook delivery to an existing Session. Returns false when
    /// the same delivery receipt was already accepted or <paramref name="shape"/> declined it;
    /// a missing target is never created.
    /// </summary>
    internal async Task<bool> SubmitWebhookAsync(
        string id,
        QueueItem item,
        string? receipt,
        bool wake = true,
        Func<IReadOnlyList<QueueItem>, QueueItem, QueueItem?>? shape = null
    )
    {
        using var use = await manager.UseRequiredAsync(id);
        var owner = use.Owner;
        await RequireExternalOwnerAsync(owner);
        return await owner.Registry.Ingress.EnqueueWebhookAsync(
            owner.Id,
            item,
            receipt,
            () =>
            {
                if (!manager.Accepting)
                    throw new InvalidOperationException("Host is shutting down.");
            },
            wake,
            shape
        );
    }

    /// <summary>Runs a webhook handler as an unattended ToolScript owned by the target Session.</summary>
    internal Task<JsonObject?> RunWebhookScriptAsync(
        string id,
        JsonObject script,
        string? webhookId = null
    ) => manager.RunWebhookScriptAsync(id, script, webhookId);

    internal Task<JsonObject> ReadScriptRunAsync(
        string runId,
        string ownerId,
        CancellationToken token
    ) => manager.ToolScript.ReadOwnedRunAsync(runId, ownerId, token);

    internal WebhookActivity Webhooks => manager.Webhooks;

    internal bool Accepting => manager.Accepting;

    private async Task RequireExternalOwnerAsync(SessionOwner owner)
    {
        await manager.WaitForIdentityMutationAsync(owner.Id);
        // Text-only external admission has no attachment/Node materialization dependency.
        owner.Entry.RequireIdentityAuthority();
        if (!ReferenceEquals(manager.Find(owner.Id), owner))
            throw new InvalidOperationException(
                "External input Session owner is no longer current."
            );
    }

    public async Task<JsonObject> UpdateSettingsAsync(string id, JsonObject settings)
    {
        using var use = await manager.UseRequiredAsync(id);
        return await use.Owner.UpdateModelAsync(settings);
    }

    internal Task<PresentationChange> ChangePresentationAsync(
        Func<ISessionCatalogStore, Task<PresentationChange>> action
    ) => manager.ChangePresentationAsync(action);

    internal void ReplyToCommand(string id, string text) => manager.ReplyToCommand(id, text);

    internal Task<JsonObject> MoveIdentityAsync(SessionOwner caller, JsonObject args) =>
        manager.MoveIdentityAsync(caller, args);

    internal Task<JsonObject> DeleteAsync(
        string id,
        bool recursive = false,
        SessionOwner? source = null
    ) => manager.DeleteAsync(id, recursive, source);

    public Task UpdateDisplayNameAsync(string id, string? name) => manager.RenameAsync(id, name);

    public async Task<string?> RefreshSnapshotAsync(string id)
    {
        using var use = await manager.UseRequiredAsync(id);
        return await manager.RefreshSnapshotAsync(use.Owner);
    }

    public async Task<StopResult> StopAsync(string id)
    {
        using var use = await manager.UseRequiredAsync(id);
        var owner = use.Owner;
        if (owner.Compactor.Standalone)
            return new(false, false);
        var result = await owner.Registry.Control.StopAsync(owner.Id);
        await owner.DrainForegroundAsync();
        return result;
    }

    public async Task<ClearHistoryResult> ClearHistoryAsync(string id)
    {
        using var use = await manager.UseRequiredAsync(id);
        return await manager.ClearAsync(use.Owner);
    }

    public async Task<SessionOwner> ForkAsync(string id, string? suffix = null)
    {
        using var use = await manager.UseRequiredAsync(id);
        return await manager.ForkAsync(use.Owner, suffix);
    }

    public async Task<SessionOwner> ForkCommandAsync(string id, string suffix, string? message)
    {
        using var use = await manager.UseRequiredAsync(id);
        var parent = use.Owner;
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
        using var use = await manager.UseRequiredAsync(id);
        var owner = use.Owner;
        return await owner.Registry.Control.DequeueAsync(owner.Id);
    }
}

internal sealed partial class SessionOwner
{
    internal Func<SessionMetadata, SessionMetadata>? MainMetadata { get; init; }

    internal string ExecutionNode(JsonObject authority) =>
        SessionManager.ResolveExecutionNode(authority);

    // False when the runtime has no master Node (RuntimeCapabilities.MasterNode).
    internal bool MasterNode { get; init; } = true;

    // The current Node as Session presentation reports it: null for none.
    internal string? PresentedNode(JsonObject authority) =>
        SessionManager.PresentedNode(ExecutionNode(authority), MasterNode);

    public SessionMetadata Metadata()
    {
        var value = AuthorityMetadata();
        return MainMetadata?.Invoke(value) ?? value;
    }

    internal SessionMetadata AuthorityMetadata() => Entry.WithState(state =>
        {
            var envelope = state.AuthorityEnvelope;
            static string? Text(JsonNode? node) =>
                node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
            static double Number(JsonNode? node) => SessionWait.Number(node) ?? 0;
            static bool Flag(JsonNode? node) =>
                node is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
            var external = envelope["externalRuntime"]?.DeepClone() as JsonObject;
            if (external is not null)
                external["canContinue"] = ClaudeRuntimeState.CanContinue(
                    envelope,
                    state.Queue.Any(SessionCompactor.Ordinary)
                );
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
                ClaudeRuntimeState.IsExternal(envelope)
                    ? Text(envelope["externalRuntime"]?["model"])
                    : Text(envelope["model"]),
                Text(envelope["effort"]),
                Number(envelope["stats"]?["totalCachedTokens"]),
                Number(envelope["stats"]?["totalInputTokens"]),
                Number(envelope["stats"]?["totalOutputTokens"]),
                SessionRuntimeState.WaitProjection(state.Meta),
                Text(envelope["childModelDefault"]),
                Text(envelope["childEffortDefault"]),
                SessionWait.Number(envelope["compactThresholdTokens"]),
                Cost: SessionWait.Number(envelope["stats"]?["totalCost"]),
                LlmFailed: Flag(state.Meta["llmFailed"]),
                Runtime: Text(envelope["runtime"]) ?? "foxwarm",
                ExternalRuntime: external,
                Questions: SessionQuestions.Projection(state.Meta)
            );
        });

    internal Func<int>? RunningExecCount { get; set; }

    public JsonObject BuildDto() => BuildDto(Metadata());

    public JsonObject BuildDto(SessionMetadata meta)
    {
        var dto = SessionPresentation.Build(meta, models.Capture(), ResolveAncestry, ToolActive, Compacting);
        dto["runtimeState"] = RuntimeSnapshot(meta);
        // Background commands still tracked for this Session; the WebUI lists them on request.
        dto["runningExecs"] = RunningExecCount?.Invoke() ?? 0;
        Entry.WithState(state =>
        {
            dto["currentNode"] = PresentedNode(state.AuthorityEnvelope);
            dto["cwd"] = state.AuthorityEnvelope["cwd"]?.DeepClone();
        });
        return dto;
    }
}
