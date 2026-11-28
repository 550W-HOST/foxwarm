using System.Text.Json.Nodes;
using Foxwarm.Secrets;
using Foxwarm.Sessions;

namespace Foxwarm.Telemetry;

internal sealed record TraceContent(
    bool SystemPrompt,
    bool InputMessages,
    bool OutputMessages,
    bool ToolDefinitions,
    bool ToolArguments,
    bool ToolResults,
    bool Reasoning
);

internal sealed record OtlpConfiguration(
    bool Enabled,
    Uri? Endpoint,
    IReadOnlyDictionary<string, string> Headers,
    TraceContent Content
)
{
    internal static OtlpConfiguration? Capture(JsonObject app)
    {
        if (!app.ContainsKey("otlp"))
            return null;
        if (
            app["otlp"] is not JsonObject config
            || config.Any(item =>
                item.Key is not ("enabled" or "endpoint" or "headers" or "captureContent")
            )
        )
            throw new InvalidDataException(
                "otlp accepts enabled, endpoint, headers and captureContent."
            );
        var enabled = Flag(config, "enabled", true);
        Uri? endpoint = null;
        if (
            config.ContainsKey("endpoint")
            && (
                !Uri.TryCreate(SessionWait.Text(config["endpoint"]), UriKind.Absolute, out endpoint)
                || endpoint.Scheme is not ("https" or "http")
                || endpoint.UserInfo.Length != 0
                || endpoint.Fragment.Length != 0
            )
        )
            throw new InvalidDataException(
                "otlp.endpoint must be an absolute HTTP(S) traces URL without user info or a fragment."
            );
        if (enabled && endpoint is null)
            throw new InvalidDataException("otlp.endpoint is required when export is enabled.");
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (config.ContainsKey("headers"))
        {
            if (config["headers"] is not JsonObject values)
                throw new InvalidDataException(
                    "otlp.headers must be a mapping of HTTP headers to secret references."
                );
            using var request = new HttpRequestMessage();
            foreach (var (name, value) in values)
                if (
                    SessionWait.Text(value) is not { } text
                    || !SecretReferences.Contains(text)
                    || !request.Headers.TryAddWithoutValidation(name, text)
                    || name.Equals("Host", StringComparison.OrdinalIgnoreCase)
                    || !headers.TryAdd(name, text)
                )
                    throw new InvalidDataException(
                        "otlp.headers requires unique HTTP request headers with secret references."
                    );
        }
        JsonObject content = new();
        if (config.ContainsKey("captureContent"))
        {
            if (
                config["captureContent"] is not JsonObject fields
                || fields.Any(item =>
                    item.Key
                        is not (
                            "systemPrompt"
                            or "inputMessages"
                            or "outputMessages"
                            or "toolDefinitions"
                            or "toolArguments"
                            or "toolResults"
                            or "reasoning"
                        )
                )
            )
                throw new InvalidDataException(
                    "otlp.captureContent accepts systemPrompt, inputMessages, outputMessages, toolDefinitions, toolArguments, toolResults and reasoning."
                );
            content = fields;
        }
        return new(
            enabled,
            endpoint,
            headers,
            new(
                Flag(content, "systemPrompt", false),
                Flag(content, "inputMessages", false),
                Flag(content, "outputMessages", false),
                Flag(content, "toolDefinitions", false),
                Flag(content, "toolArguments", false),
                Flag(content, "toolResults", false),
                Flag(content, "reasoning", false)
            )
        );
    }

    private static bool Flag(JsonObject config, string name, bool fallback) =>
        !config.ContainsKey(name) ? fallback
        : config[name] is JsonValue value && value.TryGetValue<bool>(out var enabled) ? enabled
        : throw new InvalidDataException($"OTLP setting {name} must be a boolean.");
}
