using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed record WeixinLoginSettings(
    string ChannelId,
    string BaseUrl,
    string? RouteTag,
    string BotType,
    JsonObject Config
);

internal sealed partial class ModelConfiguration
{
    internal WeixinLoginSettings WeixinSettings(JsonObject? input = null)
    {
        var channels = CurrentChannels();
        var matches = channels
            .Where(pair =>
                pair.Value is JsonObject config
                && (
                    input is null ? Foxwarm.Channels.ManagedChannels.Type(pair.Key, config)
                    : SessionWait.Text(config["type"]) is { Length: > 0 } rawType ? rawType
                    : pair.Key
                ) == "weixin"
            )
            .Select(pair => pair.Key)
            .ToArray();
        // Setup chooses the first configured entry; the shared command prefers the type-named default.
        var requested = SessionWait.Text(input?["channelId"])?.Trim();
        var id = input is not null
            ? (!string.IsNullOrEmpty(requested) ? requested : matches.FirstOrDefault() ?? "weixin")
            : matches.FirstOrDefault(value => value == "weixin")
                ?? matches.FirstOrDefault()
                ?? "weixin";
        var config = channels[id] as JsonObject;
        if (config is null && input is null)
        {
            var startup = (app["channels"] as JsonObject ?? new JsonObject())
                .Where(pair =>
                    pair.Value is JsonObject entry
                    && Foxwarm.Channels.ManagedChannels.Type(pair.Key, entry) == "weixin"
                )
                .ToArray();
            config =
                (
                    startup.FirstOrDefault(pair => pair.Key == "weixin").Value
                    ?? startup.FirstOrDefault().Value
                ) as JsonObject;
        }
        config ??= new JsonObject();
        string? Setting(string key, string configKey, string? fallback = null)
        {
            if (SessionWait.Text(input?[key])?.Trim() is { Length: > 0 } provided)
                return provided;
            var configured = SessionWait.Text(config[configKey]);
            if (string.IsNullOrEmpty(configured))
                configured = fallback;
            return input is null ? configured?.Trim() : configured;
        }
        return new(
            id,
            Setting("baseUrl", "baseUrl", WeixinApi.DefaultBaseUrl)!,
            Setting("routeTag", "routeTag"),
            Setting("botType", "loginBotType", WeixinApi.DefaultBotType)!,
            (JsonObject)config.DeepClone()
        );
    }

    internal Task<JsonObject> SaveWeixinLoginAsync(
        WeixinLoginSettings settings,
        WeixinLoginResult login,
        bool setup
    )
    {
        if (!login.Connected || string.IsNullOrEmpty(login.BotToken))
            throw new InvalidOperationException("Weixin login is not confirmed.");
        byte[] Candidate()
        {
            // Read and merge after earlier installers settle, not from the pre-network login snapshot.
            var channels = CurrentChannels();
            var previous = channels[settings.ChannelId] as JsonObject ?? new JsonObject();
            var next = (JsonObject)previous.DeepClone();
            if (string.IsNullOrEmpty(SessionWait.Text(next["type"])))
            {
                if (settings.ChannelId != "weixin")
                    next["type"] = "weixin";
                else
                    next.Remove("type");
            }
            next["enabled"] = true;
            next["baseUrl"] = login.BaseUrl ?? settings.BaseUrl;
            next["token"] = login.BotToken;
            if (settings.RouteTag is { Length: > 0 })
                next["routeTag"] = settings.RouteTag;
            else
                next.Remove("routeTag");
            if (setup && !string.IsNullOrEmpty(login.UserId))
                next["allowedUsers"] = new JsonArray(
                    SessionWait
                        .Strings(previous["allowedUsers"])
                        .Append(login.UserId)
                        .Distinct(StringComparer.Ordinal)
                        .Select(value => (JsonNode?)JsonValue.Create(value))
                        .ToArray()
                );
            channels[settings.ChannelId] = next;
            return BuildChannelsBytes(channels);
        }
        return setup
            ? InstallAsync("config", _ => Task.FromResult(Candidate()))
            : SaveWeixinCommandLoginAsync(settings.ChannelId, Candidate);
    }

    private async Task<JsonObject> SaveWeixinCommandLoginAsync(
        string channelId,
        Func<byte[]> candidate
    )
    {
        // Source command saves directly, then restarts one instance. It does not wait on a Setup
        // installer that may itself be joining this command's Weixin polling handler.
        // Keep the same configuration validation/atomic writer, without acquiring the Setup apply lane.
        var bytes = candidate();
        var raw = System.Text.Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF');
        await ValidateAppCandidateAsync(raw);
        await ReplaceRawAsync(AppPath, bytes, CancellationToken.None);
        var notApplied = new List<string>();
        if (ManagedChannels is { } runtime)
        {
            try
            {
                await runtime.ChangeAsync("restart", channelId);
            }
            catch (Exception)
            {
                notApplied.Add("channels." + channelId);
            }
        }
        else
            notApplied.Add("channels." + channelId);
        return Installed("config", ["channels"], notApplied, []);
    }
}
