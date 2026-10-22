using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Channels;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> channelCreation = new(
        StringComparer.Ordinal
    );
    internal ManagedChannels? ManagedChannels { get; private set; }
    internal ChannelAuthorizationOwner? ChannelAuthorization { get; private set; }
    internal ChannelProgress ChannelProgress { get; } = new();

    internal void InitializeChannels(
        MessageRouter router,
        Models.ModelConfiguration configuration,
        ChannelTransportDependencies? dependencies = null
    )
    {
        ChannelAuthorization = new(configuration, this);
        ManagedChannels = new(this, router, configuration, dependencies);
        configuration.ManagedChannels = ManagedChannels;
    }

    internal JsonObject ChannelBindings() =>
        deletionChannels.ReadForDelivery()["channels"]!.AsObject();

    internal JsonObject? ChannelBinding(string target) => deletionChannels.Binding(target);

    internal void AttachConfiguredChannel(string target, string id) =>
        deletionChannels.Bind(target, id, durable: false);

    internal void AttachChannel(
        string target,
        SessionOwner owner,
        bool durable = true,
        JsonObject? updates = null
    )
    {
        _ = ChannelRegistry.Parse(target);
        using var admission = BeginOwnerMutation(owner);
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException("Attachment Session is no longer current.");
        deletionChannels.Bind(target, owner.Id, updates, durable);
    }

    internal void SetChannelBinding(string target, string field, JsonNode? value)
    {
        var id = SessionWait.Text(ChannelBinding(target)?["sessionId"]);
        using var admission = id is null ? null : BeginMutation([id]);
        deletionChannels.MutateBinding(target, field, value);
    }

    internal void DetachChannel(string target) => deletionChannels.MutateBinding(target);

    internal async Task<SessionOwner> ResolveChannelAsync(
        string target,
        Func<Task<SessionOwner>>? create = null,
        JsonObject? updates = null
    )
    {
        var gate = channelCreation.GetOrAdd(target, _ => new(1));
        await gate.WaitAsync();
        try
        {
            if (SessionWait.Text(ChannelBinding(target)?["sessionId"]) is { } bound)
                return await GetExistingAsync(bound)
                    ?? throw new InvalidOperationException(
                        $"Attached channel target session \"{bound}\" is unavailable. Rebind this conversation to an existing session."
                    );
            var owner = create is null ? await CreateAsync() : await create();
            if (SessionWait.Text(ChannelBinding(target)?["sessionId"]) is { } concurrent)
            {
                await RollbackChannelCreationAsync(owner);
                return await RequiredAsync(concurrent);
            }
            try
            {
                AttachChannel(target, owner, updates: updates);
                return owner;
            }
            catch
            {
                await RollbackChannelCreationAsync(owner);
                throw;
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task RollbackChannelCreationAsync(SessionOwner owner)
    {
        var branch = owner.Archive.ReadBranch();
        await DeleteAsync(owner.Id);
        await CompensateCreatedBranchAsync(owner.AuthorityStore, branch);
    }

    internal async Task<SessionOwner?> ProvisionChannelGuestAsync(ExternalChannelContext source)
    {
        if (ChannelBinding(source.Target) is not null)
            return null;
        var config =
            models.ConfigurationOwner?.CurrentChannels()[source.Instance]?["guestAgent"]
            as JsonObject;
        var agent = SessionWait.Text(config?["agentId"])?.Trim();
        if (string.IsNullOrEmpty(agent))
            return null;
        async Task<SessionOwner> Create()
        {
            if (!agents.Exists(agent))
                throw new InvalidDataException("Guest agent source does not exist: " + agent);
            var isolated = config!["isolated"]?.GetValue<bool>() != false;
            var node = SessionWait.Text(config["node"])?.Trim();
            if (isolated && string.IsNullOrEmpty(node))
                throw new InvalidDataException("Guest isolated Agent requires a Node.");
            if (SessionWait.Text(config["mode"]) != "inherited")
            {
                if (
                    AgentIsolated(agent) != isolated
                    || isolated && RecordedIsolationNode(agent) != node
                )
                    throw new InvalidDataException(
                        "Guest single-mode Agent isolation/Node does not match its configuration."
                    );
                return await CreateNamedAsync(agent, null, null, null);
            }
            for (var attempt = 0; attempt < 32; attempt++)
            {
                var name = agent + "_" + Guid.NewGuid().ToString("N")[..6];
                if (agents.Exists(name))
                    continue;
                var created = await CreateAgentAsync(
                    name,
                    inherit: agent,
                    isolatedNode: isolated ? node : null
                );
                return await RequiredAsync(created.MainSessionId!);
            }
            throw new InvalidOperationException("Unable to allocate a guest Agent.");
        }
        var result = await ResolveChannelAsync(
            source.Target,
            Create,
            new JsonObject { ["dangerouslyAllowAllUsers"] = true }
        );
        return SessionCatalog.Flag(ChannelBinding(source.Target)?["dangerouslyAllowAllUsers"])
            ? result
            : null;
    }

    internal void RecordLastChannel(SessionOwner owner, ExternalChannelContext source)
    {
        using var admission = BeginOwnerMutation(owner);
        Catalog.SetLastChannel(
            owner.Id,
            new JsonObject
            {
                ["channelId"] = source.Instance,
                ["channelType"] = source.Type,
                ["channelUserId"] = source.Conversation,
                ["conversationId"] = source.Conversation,
            }
        );
    }

    internal string? BestChannel(SessionOwner owner)
    {
        var attachments = deletionChannels.ReadForDelivery()["channels"]!
            .AsObject()
            .Where(pair => SessionWait.Text(pair.Value?["sessionId"]) == owner.Id)
            .Select(pair => pair.Key)
            .ToArray();
        var last = Catalog.Get(owner.Id)?["meta"]?["lastChannel"];
        var target =
            (SessionWait.Text(last?["channelId"]) ?? SessionWait.Text(last?["platform"]))
            + ":"
            + (
                SessionWait.Text(last?["conversationId"])
                ?? SessionWait.Text(last?["channelUserId"])
            );
        if (attachments.Contains(target, StringComparer.Ordinal))
            return target;
        foreach (
            var message in owner
                .History()
                .Reverse()
                .Where(row => SessionWait.Text(row["role"]) == "user")
        )
        foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
        {
            target = ParseSourceChannel(SessionWait.Text(part["system"]) ?? "");
            if (target is not null && attachments.Contains(target, StringComparer.Ordinal))
                return target;
        }
        return attachments.FirstOrDefault();
    }

    private static string? ParseSourceChannel(string system)
    {
        var opening = Regex.Match(system, @"^<foxwarm-message\b([^>]*)>");
        if (opening.Success)
        {
            var attrs = Regex
                .Matches(opening.Groups[1].Value, "([a-zA-Z]+)=\"([^\"]*)\"")
                .ToDictionary(
                    match => match.Groups[1].Value,
                    match => System.Net.WebUtility.HtmlDecode(match.Groups[2].Value),
                    StringComparer.Ordinal
                );
            if (attrs.GetValueOrDefault("type") == "channel")
            {
                var instance =
                    attrs.GetValueOrDefault("channelInstanceId")
                    ?? attrs.GetValueOrDefault("channelId")
                    ?? attrs.GetValueOrDefault("channelType");
                var conversation =
                    attrs.GetValueOrDefault("conversationId")
                    ?? attrs.GetValueOrDefault("channelUserId");
                return string.IsNullOrEmpty(instance) || string.IsNullOrEmpty(conversation)
                    ? null
                    : instance + ":" + conversation;
            }
        }
        if (system.StartsWith("FROM: ", StringComparison.Ordinal))
        {
            var raw = system[6..];
            var colon = raw.IndexOf(':');
            if (colon <= 0)
                return null;
            var conversation = Regex.Replace(raw[(colon + 1)..], @"\s\([^)]*\)$", "");
            return conversation.Length == 0 ? null : raw[..colon] + ":" + conversation;
        }
        var channelId = Regex.Match(system, @"channel_(?:instance_)?id:\s*`([^`]+)`");
        if (!channelId.Success)
            return null;
        var conversationId = Regex.Match(system, @"conversation_id:\s*`([^`]+)`");
        if (conversationId.Success)
            return channelId.Groups[1].Value + ":" + conversationId.Groups[1].Value;
        var legacy = channelId.Groups[1].Value;
        var split = legacy.IndexOf(':');
        return split > 0 && split < legacy.Length - 1 ? legacy : null;
    }
}
