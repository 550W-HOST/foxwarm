using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class McpClient
{
    internal string[] ExternalServers() => configuration.Snapshot()
        .Where(pair => pair.Value is JsonObject config && !(config["enable"] is JsonValue enabled && enabled.TryGetValue<bool>(out var flag) && !flag))
        .Select(pair => pair.Key).ToArray();

    private string[] ExternalCredentials(params JsonObject[] captured)
    {
        var credentials = new HashSet<string>(OAuth.Credentials(), StringComparer.Ordinal);
        foreach (var config in configuration.Snapshot().Select(pair => pair.Value).OfType<JsonObject>().Concat(captured))
        {
            foreach (var value in new[] { SessionWait.Text(config["token"]), SessionWait.Text(config["oauth"]?["clientSecret"]) })
                if (!string.IsNullOrEmpty(value)) credentials.Add(value);
            foreach (var (key, value) in config["headers"] as JsonObject ?? new JsonObject())
            {
                if (!new[] { "authorization", "proxy-authorization", "x-api-key", "api-key", "x-auth-token" }
                    .Contains(key, StringComparer.OrdinalIgnoreCase)) continue;
                if (SessionWait.Text(value) is not { Length: > 0 } header) continue;
                credentials.Add(header);
                var match = System.Text.RegularExpressions.Regex.Match(header, @"^Bearer\s+(\S+)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (match.Success) credentials.Add(match.Groups[1].Value);
            }
        }
        return credentials.ToArray();
    }

    private static bool EchoesCredential(JsonNode? value, string[] credentials, int depth = 0)
    {
        if (credentials.Length == 0) return false;
        if (SessionWait.Text(value) is string text)
            return credentials.Any(secret => text.Contains(secret, StringComparison.Ordinal));
        if (value is not (JsonArray or JsonObject)) return false;
        if (depth > 32) return true;
        if (value is JsonArray array)
            return array.Any(item => EchoesCredential(item, credentials, depth + 1));
        var obj = value!.AsObject();
        var binary = SessionWait.Text(obj["type"]) is "image" or "audio";
        return obj.Any(pair => !(binary && pair.Key is "data" or "blob")
            && (credentials.Any(secret => pair.Key.Contains(secret, StringComparison.Ordinal))
                || EchoesCredential(pair.Value, credentials, depth + 1)));
    }

    // Run inside the existing OAuth operation scope, while refreshed/retired credentials are retained.
    // Internal callers keep the original whole-result guard; external descriptors are omitted whole
    // and raw external media is not inspected as credential text.
    private T ValidateExternalResult<T>(T value, string[] oauth, params JsonObject[] captured)
    {
        var credentials = oauth.Concat(ExternalCredentials(captured)).Distinct(StringComparer.Ordinal).ToArray();
        if (value is IReadOnlyList<JsonObject> tools)
            return (T)(object)tools.Where(tool => !EchoesCredential(tool, credentials)).ToArray();
        if (value is JsonNode result && EchoesCredential(result, credentials))
            throw new McpInboundSafeException("Tool may have completed; remote output echoed a configured credential and was withheld. Do not retry automatically.");
        return value;
    }

    internal async Task<IReadOnlyList<JsonObject>> ListExternalToolsAsync(
        McpExternalContext context, McpExternalAuthorization authorization, string server, CancellationToken token)
    {
        context.Require();
        var before = ExternalCredentials();
        var tools = await ListToolsAsync(server, token, external: context);
        context.Require();
        var credentials = before.Concat(ExternalCredentials()).Distinct(StringComparer.Ordinal).ToArray();
        return tools.Where(tool => SessionWait.Text(tool["name"]) is string name
            && !EchoesCredential(tool, credentials)
            && authorization.Visible(context, authorization.Request(context, "mcp", name, new(), server)))
            .ToArray();
    }

    internal async Task<JsonObject> CallExternalAsync(McpExternalContext context,
        McpExternalAuthorization authorization, string server, string name, JsonObject args, CancellationToken token)
    {
        var permission = authorization.Request(context, "mcp", name, args, server);
        await authorization.RequireAsync(context, permission, token);
        var before = ExternalCredentials();
        IReadOnlyList<JsonObject> tools;
        try { tools = await ListToolsAsync(server, token, external: context); }
        catch { throw new McpInboundSafeException("Tool lookup failed before invocation; no call was sent."); }
        var credentials = before.Concat(ExternalCredentials()).Distinct(StringComparer.Ordinal).ToArray();
        if (!tools.Any(tool => SessionWait.Text(tool["name"]) == name && !EchoesCredential(tool, credentials)))
            throw new McpInboundSafeException("Tool is not available on the configured server.");
        JsonNode? result;
        try
        {
            result = await CallAsync(server, name, args, token, external: context, raw: true,
                beforeSend: () => authorization.Require(context, permission));
        }
        catch (McpInboundSafeException) { throw; }
        catch { throw new McpInboundSafeException("MCP call failed. Its outcome may be unknown; do not retry automatically."); }
        context.Require();
        try { credentials = credentials.Concat(ExternalCredentials()).Distinct(StringComparer.Ordinal).ToArray(); }
        catch { throw new McpInboundSafeException("Tool may have completed; its output cannot be safely returned. Do not retry automatically."); }
        if (EchoesCredential(result, credentials))
            throw new McpInboundSafeException("Tool may have completed; remote output echoed a configured credential and was withheld. Do not retry automatically.");
        return result as JsonObject ?? throw new McpInboundSafeException("Tool may have completed; remote output was invalid. Do not retry automatically.");
    }
}
