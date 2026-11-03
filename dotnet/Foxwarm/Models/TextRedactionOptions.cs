using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed record TextRedactionOptions(
    Uri Endpoint,
    string? ApiKey,
    double Threshold,
    int TimeoutMs
)
{
    internal static void Validate(JsonNode? value)
    {
        if (value is JsonValue flag && flag.TryGetValue<bool>(out _))
            return;
        if (value is not JsonObject options)
            throw new InvalidDataException("textRedaction must be boolean or an options object.");
        foreach (var (key, item) in options)
        {
            var valid = key switch
            {
                "enabled" => item is JsonValue enabled && enabled.TryGetValue<bool>(out _),
                "endpoint" => SessionWait.Text(item) is string endpoint
                    && Uri.TryCreate(endpoint, UriKind.Absolute, out var uri)
                    && uri.Scheme is "http" or "https"
                    && uri.UserInfo.Length == 0
                    && uri.Fragment.Length == 0,
                "apiKey" => SessionWait.Text(item) is not null,
                "threshold" => SessionWait.Number(item) is double threshold
                    && double.IsFinite(threshold)
                    && threshold is >= 0 and <= 1,
                "timeoutMs" => SessionWait.Number(item) is double timeout
                    && double.IsFinite(timeout)
                    && timeout is > 0 and <= int.MaxValue
                    && Math.Floor(timeout) == timeout,
                _ => false,
            };
            if (!valid)
                throw new InvalidDataException("Invalid textRedaction." + key + ".");
        }
    }

    internal static JsonObject Resolve(params JsonObject?[] scopes)
    {
        var result = new JsonObject { ["enabled"] = false };
        foreach (var scope in scopes)
        {
            if (scope?.ContainsKey("textRedaction") != true)
                continue;
            var value = scope["textRedaction"];
            Validate(value);
            if (value is JsonObject options)
            {
                foreach (var (key, item) in options)
                    result[key] = item?.DeepClone();
            }
            else
                result["enabled"] = value!.DeepClone();
        }
        _ = FromResolved(result);
        return result;
    }

    internal static TextRedactionOptions? FromResolved(JsonObject? options)
    {
        if (options?["enabled"]?.GetValue<bool>() != true)
            return null;
        if (SessionWait.Text(options["endpoint"]) is not string endpoint)
            throw new InvalidDataException("Enabled textRedaction requires an endpoint.");
        return new(
            new Uri(endpoint, UriKind.Absolute),
            SessionWait.Text(options["apiKey"]),
            SessionWait.Number(options["threshold"]) ?? 0.5,
            HostModels.Positive(options["timeoutMs"], 30000, "textRedaction.timeoutMs")
        );
    }
}
