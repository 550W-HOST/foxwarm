using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<JsonObject> SendToChannelAsync(SessionOwner owner, JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(args, ["channelTargetId", "message"]);
        var target = ToolRegistry.Text(args, "channelTargetId");
        var message = ToolRegistry.Text(args, "message");
        if (string.IsNullOrEmpty(target) || string.IsNullOrEmpty(message))
            throw new InvalidDataException("send_to_channel requires channelTargetId and message.");
        await AuthorizeToolAsync(owner, new("send_to_channel", "builtin", "send_to_channel", args), null, token);
        using var admission = BeginOwnerMutation(owner);
        if (AgentIsolated(owner.Agent)
            && SessionCatalog.Text(deletionChannels.ReadForDelivery()["channels"]?[target]?["sessionId"]) != owner.Id)
            throw new ToolAuthorizationDeniedException("Isolated Session can only send messages to its own attached channel.");
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException("Channel source Session is no longer current.");
        await TextChannels.SendAsync(target, message, token);
        return new JsonObject { ["output"] = $"Message sent to channel target `{target}`" };
    }

    internal void PresentChannelText(string id, string text)
    {
        var data = new JsonObject
        {
            ["role"] = "assistant",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            ["__meta"] = new JsonObject
            {
                ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["channelUserId"] = id,
                ["username"] = "system",
                ["platform"] = "webui",
                ["temporary"] = true,
                ["isInstantNotification"] = true,
            },
        };
        // Existing trusted transient message path; not history or another provider turn.
        Changed?.Invoke(new(id, SessionEventKind.CommandReply, data));
    }
}
