using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task RegisterRemoteExecBackgroundAsync(string node, JsonObject message)
    {
        var original = SessionWait.Text(message["sessionId"]);
        var id = SessionWait.Text(message["execId"]);
        var grant = SessionWait.Text(message["completionCapability"]);
        if (original is null || id is null || grant is null)
            throw new InvalidDataException("Invalid remote_exec_background message.");
        var owner = await RequiredAsync(original);
        using var admission = BeginOwnerMutation(owner);
        if (!Nodes.ExecClaims.Activate(node, original, id, grant, owner))
            throw new InvalidDataException("Remote background exec requires an exact Main reservation for this Session lifetime.");
    }

    internal async Task AdmitNodeSessionEventAsync(string node, JsonObject message)
    {
        var original = SessionWait.Text(message["sessionId"]);
        var text = SessionWait.Text(message["message"]);
        if (string.IsNullOrEmpty(original) || text is null)
            throw new InvalidDataException("session_event requires sessionId and message.");
        var type = SessionWait.Text(message["eventType"]);
        var queueType = type switch
        {
            "trigger" => QueueItemType.Trigger,
            "onboot" => QueueItemType.OnBoot,
            _ => QueueItemType.Background,
        };
        var hasCompletion = new[] { "eventId", "execId", "completionCapability", "eventTimestamp" }.Any(key => message[key] is not null);
        var execId = SessionWait.Text(message["execId"]);
        var grant = SessionWait.Text(message["completionCapability"]);
        var receipt = SessionWait.Text(message["eventId"]);
        if (hasCompletion && (queueType != QueueItemType.Background || string.IsNullOrEmpty(execId) || grant is null
            || receipt != "remote-exec-completion:" + execId || !Nodes.ExecClaims.Verify(node, original, execId, grant)))
            throw new InvalidDataException("Invalid remote exec completion capability.");
        // Lookup never creates an absent Session. Rename aliases identify the original lifetime.
        var owner = await RequiredAsync(original);
        using var admission = BeginOwnerMutation(owner);
        var claim = hasCompletion ? Nodes.ExecClaims.Exact(node, original, execId!, grant!) : null;
        if (hasCompletion)
        {
            var durableDuplicate = owner.Entry.WithState(state => SessionWait.Strings(state.Meta["acceptedExternalEventIds"]).Contains(receipt!, StringComparer.Ordinal));
            if (!(claim is not null && ReferenceEquals(claim.Owner, owner)) && !durableDuplicate)
                throw new InvalidDataException("Remote exec completion has no start-time authority in this host lifetime and no durable duplicate receipt.");
        }
        else if (CurrentNode(owner) != node && BoundNode(owner.Agent) != node)
            throw new InvalidDataException("Authenticated Node does not own this Session's event placement.");
        bool admitted;
        try
        {
            admitted = hasCompletion
                ? await owner.Entry.SaveLane.CommitRemoteExecCompletionAsync(execId!, text, receipt!)
                : await owner.Entry.SaveLane.AdmitAsync(new QueueItem(queueType, [new JsonObject { ["system"] = text }]), SaveKind.Strict);
        }
        catch (AuthorityCommittedException)
        {
            WakeNodeEventOwner(owner);
            throw; // No success ACK until strict admission/duplicate proof succeeds.
        }
        if (claim is not null)
            Nodes.ExecClaims.Complete(claim);
        if (admitted)
            WakeNodeEventOwner(owner);
    }

    private void WakeNodeEventOwner(SessionOwner owner)
    {
        if (Accepting && !owner.Entry.WithState(state => state.Busy || state.Stopping) && owner.Registry.HasRunnableWork(owner.Entry))
            owner.Registry.Trigger(owner.Id);
    }
}
