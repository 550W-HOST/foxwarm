using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed record ChannelAuthorization(
    string EffectiveId,
    bool Authorized,
    bool Direct,
    bool Wildcard,
    bool Override,
    string[] Allowed
)
{
    internal string Describe(ExternalChannelContext source, bool unauthorized = false)
    {
        var lines = new List<string>
        {
            unauthorized ? "❌ Unauthorized." : "Channel authorization diagnostics",
            "",
            $"- channelId: `{source.Instance}`",
            $"- channelType: `{source.Type}`",
            $"- conversationId: `{source.Conversation}`",
            $"- senderId: `{source.Sender ?? "(none)"}`",
            $"- effectiveAuthId: `{EffectiveId}`",
        };
        if (!unauthorized)
            lines.AddRange([
                $"- authorized: `{(Authorized ? "yes" : "no")}`",
                $"- directAllowlistMatch: `{(Direct ? "yes" : "no")}`",
                $"- dangerouslyAllowAllUsers: `{(Override ? "yes" : "no")}`",
                "- configuredAllowlist: "
                    + string.Join(", ", Allowed.Select(value => "`" + value + "`")),
            ]);
        if (EffectiveId.Length > 0)
            lines.AddRange([
                "",
                "Authorize this user by adding it to config.yaml:",
                "```yaml",
                "channels:",
                "  " + System.Text.Json.JsonSerializer.Serialize(source.Instance) + ":",
                "    allowedUsers:",
                "      - " + System.Text.Json.JsonSerializer.Serialize(EffectiveId),
                "```",
            ]);
        return string.Join("\n", lines);
    }
}

internal sealed class ChannelAuthorizationOwner(
    ModelConfiguration configuration,
    SessionManager sessions
)
{
    private readonly HashSet<string> startup = Capture(configuration);

    private static HashSet<string> Capture(ModelConfiguration configuration)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (id, node) in configuration.CurrentChannels())
        {
            var config = node as JsonObject ?? new JsonObject();
            var type = ManagedChannels.Type(id, config);
            var users = Users(type, config);
            foreach (var user in users)
                result.Add(id + ":" + user);
            if (SessionCatalog.Flag(config["allowAllUsers"]))
                result.Add(id + ":*");
        }
        return result;
    }

    private static string[] Users(string type, JsonObject config) =>
        (config["allowedUsers"] as JsonArray ?? [])
            .Select(SessionWait.Text)
            .Append(
                type == "telegram" ? SessionWait.Text(config["mainAttachUser"])
                : type == "matrix" ? SessionWait.Text(config["botUserId"])
                : null
            )
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value!.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    internal ChannelAuthorization Inspect(ExternalChannelContext source)
    {
        var config =
            configuration.CurrentChannels()[source.Instance] as JsonObject ?? new JsonObject();
        var id = (string.IsNullOrEmpty(source.Sender) ? source.Conversation : source.Sender).Trim();
        var allowed = Users(source.Type, config);
        var wildcard =
            startup.Contains(source.Instance + ":*")
            || startup.Contains(source.Type + ":*")
            || source.Type is not ("telegram" or "matrix" or "wework")
                && SessionCatalog.Flag(config["allowAllUsers"]);
        var direct =
            startup.Contains(source.Instance + ":" + id)
            || startup.Contains(source.Type + ":" + id)
            || allowed.Contains(id, StringComparer.Ordinal);
        var channelOverride = SessionCatalog.Flag(
            sessions.ChannelBinding(source.Target)?["dangerouslyAllowAllUsers"]
        );
        return new(
            id,
            direct || wildcard || channelOverride || source.Type is "webui" or "tui" or "internal",
            direct,
            wildcard,
            channelOverride,
            allowed
        );
    }
}
