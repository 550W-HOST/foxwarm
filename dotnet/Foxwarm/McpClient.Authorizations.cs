using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class McpClient
{
    internal JsonObject AuthorizationServer(string name)
    {
        var servers = configuration.Snapshot();
        if (servers[name] is not JsonObject config)
            throw new McpOAuthException("configuration", "Choose a configured MCP server.");
        if (SessionWait.Text(config["transport"]) == "stdio")
            throw new McpOAuthException(
                "configuration",
                "OAuth is available only for HTTP MCP servers."
            );
        return config;
    }

    internal JsonObject Authorizations()
    {
        var payload = new JsonObject();
        try
        {
            payload["callbackUrl"] = OAuth.PublicUrl(McpOAuthService.CallbackPath);
        }
        catch (Exception error)
        {
            payload["publicUrlError"] = McpOAuthService.SafeError(error).Message;
        }
        var servers = new JsonArray();
        foreach (var (name, raw) in configuration.Snapshot())
        {
            var config = raw!.AsObject();
            if (SessionWait.Text(config["transport"]) == "stdio")
                continue;
            var status =
                config["oauth"] is JsonObject
                    ? OAuth.Status(name, config)
                    : new JsonObject { ["state"] = "static", ["hasClientSecret"] = false };
            status["name"] = name;
            status["url"] = config["url"]?.DeepClone();
            status["enabled"] = config["enable"]?.GetValue<bool>() != false;
            status["transport"] = config["transport"]?.DeepClone();
            status["authentication"] = config["oauth"] is not null ? "oauth" : "static";
            status["hasStaticAuthorization"] =
                !string.IsNullOrEmpty(SessionWait.Text(config["token"]))
                || config["headers"] is JsonObject headers
                    && headers.Any(pair =>
                        pair.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase)
                    );
            if (config["oauth"]?["scope"] is not null)
                status["scope"] = config["oauth"]!["scope"]!.DeepClone();
            servers.Add(status);
        }
        payload["servers"] = servers;
        return payload;
    }

    internal Task SetAuthorizationAsync(string name, JsonObject body)
    {
        var config = AuthorizationServer(name);
        var patch = new JsonObject();
        switch (SessionWait.Text(body["authentication"]))
        {
            case "static":
                patch["oauth"] = null;
                break;
            case "oauth":
                var oauth = new JsonObject();
                foreach (var key in new[] { "scope", "clientId", "clientSecret" })
                    if (body[key] is not null)
                        oauth[key] = body[key]!.DeepClone();
                if (
                    !body.ContainsKey("clientSecret")
                    && config["oauth"]?["clientSecret"] is not null
                )
                    oauth["clientSecret"] = config["oauth"]!["clientSecret"]!.DeepClone();
                patch["oauth"] = oauth;
                if (body["replaceStaticAuthorization"]?.GetValue<bool>() == true)
                {
                    patch["token"] = null;
                    var headers = config["headers"] is JsonObject current
                        ? (JsonObject)current.DeepClone()
                        : new JsonObject();
                    foreach (var key in headers.Select(pair => pair.Key).ToArray())
                        if (key.Equals("Authorization", StringComparison.OrdinalIgnoreCase))
                            headers.Remove(key);
                    patch["headers"] = headers;
                }
                break;
            default:
                throw new McpOAuthException(
                    "configuration",
                    "Choose Static or OAuth authentication."
                );
        }
        return UpdateConfigurationAsync(name, patch, false);
    }

    private async Task UpdateConfigurationAsync(string name, JsonObject patch, bool enabledOnly)
    {
        void Published(JsonObject? previous, JsonObject next)
        {
            var authorizationChanged =
                (previous?["oauth"] is not null || next["oauth"] is not null)
                && (
                    SessionWait.Text(previous?["url"]) != SessionWait.Text(next["url"])
                    || !JsonNode.DeepEquals(previous?["oauth"], next["oauth"])
                );
            try
            {
                if (
                    authorizationChanged
                    || !JsonNode.DeepEquals(previous?["enable"], next["enable"])
                )
                    OAuth.ConfigurationChanged(name, authorizationChanged);
            }
            finally
            {
                InvalidateServer(name);
            }
        }
        await configuration.UpdateAsync(name, patch, enabledOnly, Published);
    }
}
