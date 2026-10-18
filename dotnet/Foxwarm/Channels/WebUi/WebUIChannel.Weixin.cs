using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private static void RegisterWeixinSetupRoutes(WebApplication app, ModelConfiguration configuration)
    {
        app.MapPost("/api/setup/weixin/login/start", async (HttpRequest request) =>
        {
            try
            {
                var input = await JsonNode.ParseAsync(request.Body) as JsonObject ?? new JsonObject();
                var settings = configuration.WeixinSettings(input);
                var api = configuration.ManagedChannels?.Weixin ?? throw new InvalidOperationException("Channel runtime is unavailable.");
                var result = await api.StartLoginAsync(settings.BaseUrl, settings.BotType, settings.RouteTag, force: SessionCatalog.Flag(input["force"]));
                result["success"] = true;
                result["channelId"] = settings.ChannelId;
                result["baseUrl"] = settings.BaseUrl;
                result["routeTag"] = settings.RouteTag;
                result["botType"] = settings.BotType;
                return Results.Ok(result);
            }
            catch (Exception error) { return Results.BadRequest(new { error = configuration.SafeAppError(error) }); }
        });
        app.MapPost("/api/setup/weixin/login/wait", async (HttpRequest request) =>
        {
            try
            {
                var input = await JsonNode.ParseAsync(request.Body) as JsonObject ?? new JsonObject();
                var key = SessionWait.Text(input["sessionKey"])?.Trim();
                if (string.IsNullOrEmpty(key)) throw new InvalidDataException("sessionKey is required.");
                var settings = configuration.WeixinSettings(input);
                var api = configuration.ManagedChannels?.Weixin ?? throw new InvalidOperationException("Channel runtime is unavailable.");
                var login = await api.WaitLoginAsync(key, settings.BaseUrl, settings.RouteTag, 5000);
                var result = login.Connected && !string.IsNullOrEmpty(login.BotToken)
                    ? await configuration.SaveWeixinLoginAsync(settings, login, setup: true) : new JsonObject();
                result["success"] = true;
                result["channelId"] = settings.ChannelId;
                result["connected"] = login.Connected;
                result["message"] = login.Message;
                if (login.Connected) result["userId"] = login.UserId;
                return Results.Ok(result);
            }
            catch (Exception error) { return Results.BadRequest(new { error = configuration.SafeAppError(error) }); }
        });
    }
}
