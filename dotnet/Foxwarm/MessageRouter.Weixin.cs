using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task HandleWeixinCommandAsync(UserCommand user)
    {
        var source = user.Source;
        var configuration =
            runtime.Manager.Models.ConfigurationOwner
            ?? throw new InvalidOperationException("Configuration is unavailable.");
        var settings = configuration.WeixinSettings();
        var api = runtime.Manager.ManagedChannels!.Weixin;
        switch (user.Verb)
        {
            case "weixin-status":
                var config = settings.Config;
                var status = runtime
                    .Manager.ManagedChannels.Statuses()
                    .OfType<JsonObject>()
                    .FirstOrDefault(row =>
                        SessionWait.Text(row["channelId"]) == settings.ChannelId
                    );
                await source.Reply(
                    string.Join(
                        "\n",
                        new[]
                        {
                            "*Weixin channel MVP status*",
                            $"- channelId: `{settings.ChannelId}`",
                            ConfigLine(configuration),
                            $"- enabled: `{(config["enabled"]?.GetValue<bool>() == false ? "false" : "true/auto")}`",
                            $"- baseUrl: `{settings.BaseUrl}`",
                            $"- token: `{(string.IsNullOrWhiteSpace(SessionWait.Text(config["token"])) ? "missing" : "configured")}`",
                            $"- routeTag: `{settings.RouteTag ?? "unset"}`",
                            "- allow: `"
                                + (
                                    SessionCatalog.Flag(config["allowAllUsers"]) ? "all users"
                                    : string.Join(", ", SessionWait.Strings(config["allowedUsers"]))
                                        is { Length: > 0 } users
                                        ? users
                                    : "none"
                                )
                                + "`",
                            $"- runtime: `{(SessionCatalog.Flag(status?["running"]) ? "running" : "stopped")}`",
                            "",
                            "Usage:",
                            "- `/channel weixin-login`",
                            "- `/channel weixin-wait <session-key>`",
                            $"- `/channel start {settings.ChannelId}`",
                        }.OfType<string>()
                    )
                );
                return;
            case "weixin-login":
                try
                {
                    var result = await api.StartLoginAsync(
                        settings.BaseUrl,
                        settings.BotType,
                        settings.RouteTag
                    );
                    var key = SessionWait.Text(result["sessionKey"]);
                    await source.Reply(
                        $"✅ Weixin QR login started.\n- sessionKey: `{key}`\n- qrcodeUrl: {SessionWait.Text(result["qrcodeUrl"]) ?? "(none)"}\n\nAfter scanning, run:\n`/channel weixin-wait {key}`"
                    );
                }
                catch (Exception error)
                {
                    await source.Reply(
                        "❌ Failed to start Weixin login: " + configuration.SafeAppError(error)
                    );
                }
                return;
            case "weixin-wait":
                var sessionKey = user.Text("sessionKey")?.Trim();
                if (string.IsNullOrEmpty(sessionKey))
                {
                    await source.Reply("Usage: /channel weixin-wait <session-key>");
                    return;
                }
                try
                {
                    var login = await api.WaitLoginAsync(
                        sessionKey,
                        settings.BaseUrl,
                        settings.RouteTag
                    );
                    if (!login.Connected || string.IsNullOrEmpty(login.BotToken))
                    {
                        await source.Reply("⏳ " + login.Message);
                        return;
                    }
                    await configuration.SaveWeixinLoginAsync(settings, login, setup: false);
                    var running = runtime
                        .Manager.ManagedChannels.Statuses()
                        .OfType<JsonObject>()
                        .FirstOrDefault(row =>
                            SessionWait.Text(row["channelId"]) == settings.ChannelId
                        );
                    var note = SessionCatalog.Flag(running?["running"])
                        ? "Weixin channel started immediately; no foxwarm restart needed."
                        : "Weixin config updated, but runtime start failed: "
                            + (SessionWait.Text(running?["lastError"]) ?? "channel is stopped.");
                    await source.Reply(
                        string.Join(
                            "\n",
                            new[]
                            {
                                runtime.Manager.Capabilities.MasterNode
                                    ? "✅ Weixin login completed and config file updated."
                                    : "✅ Weixin login completed and configuration updated.",
                                ConfigLine(configuration),
                                $"- channelId: `{settings.ChannelId}`",
                                $"- baseUrl: `{login.BaseUrl ?? settings.BaseUrl}`",
                                login.UserId is not null
                                    ? $"- ownerUserId: `{login.UserId}`"
                                    : null,
                                "- runtime: " + note,
                                "",
                                $"You can also inspect runtime state with `/channel status {settings.ChannelId}`.",
                            }.OfType<string>()
                        )
                    );
                }
                catch (Exception error)
                {
                    await source.Reply(
                        "❌ Failed while waiting for Weixin login: "
                            + configuration.SafeAppError(error)
                    );
                }
                return;
        }
    }

    // The app configuration file, when it is one on the Main server's machine; a hosted tenant's
    // configuration is a document edited in Setup, so there is no path to show.
    private string? ConfigLine(Foxwarm.Models.ModelConfiguration configuration) =>
        runtime.Manager.Capabilities.MasterNode ? $"- config: `{configuration.AppPath}`" : null;
}
