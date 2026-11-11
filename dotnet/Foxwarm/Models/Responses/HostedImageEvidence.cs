using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// A bounded, non-replayable projection. Never copy the provider item/error tree:
// prompts, image results, preview bytes and arbitrary error extensions stay out.
internal static class HostedImageEvidence
{
    internal const int MaxCalls = 32;
    internal const int MaxText = 400;

    internal static Func<string, string> Redactor(ResponsesClientOptions options)
    {
        var secrets = new[] { options.Token }
            .Concat(
                (options.ExtraHeaders ?? new JsonObject()).Select(pair =>
                    SessionWait.Text(pair.Value) ?? ""
                )
            )
            .Where(value => value.Length > 0)
            .SelectMany(value => new[] { value, JsonData.Serialize(value)[1..^1] })
            .Distinct(StringComparer.Ordinal)
            .OrderByDescending(value => value.Length)
            .ToArray();
        return text =>
        {
            foreach (var secret in secrets)
                text = text.Replace(secret, "[redacted]", StringComparison.Ordinal);
            return text;
        };
    }

    internal static JsonObject Summary(
        JsonObject item,
        string? responseId = null,
        Func<string, string>? redact = null
    )
    {
        var result = new JsonObject { ["type"] = "image_generation_call" };
        AddIdentifier(result, "id", SessionWait.Text(item["id"]), redact);
        AddIdentifier(
            result,
            "responseId",
            responseId ?? SessionWait.Text(item["responseId"]),
            redact
        );
        result["status"] = SessionWait.Text(item["status"]) switch
        {
            "completed" => "completed",
            "failed" => "failed",
            "incomplete" => "incomplete",
            "generating" => "generating",
            "in_progress" => "in_progress",
            _ => "unknown",
        };
        result["hasResult"] =
            SessionWait.Text(item["result"]) is { Length: > 0 }
            || item["hasResult"] is JsonValue hasResult
                && hasResult.TryGetValue<bool>(out var present)
                && present;
        if (item["error"] is JsonObject error)
        {
            var safe = new JsonObject();
            AddIdentifier(safe, "code", SessionWait.Text(error["code"]), redact);
            AddIdentifier(safe, "type", SessionWait.Text(error["type"]), redact);
            if (SafeText(SessionWait.Text(error["message"]), item, redact) is string message)
                safe["message"] = message;
            if (safe.Count > 0)
                result["error"] = safe;
        }
        return result;
    }

    internal static string? SafeText(
        string? value,
        JsonObject? item = null,
        Func<string, string>? redact = null
    )
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;
        // Omit rather than slice an unbounded value through a credential/base64 token.
        if (value.Length > 4096)
            return "[oversized error message omitted]";
        value = redact?.Invoke(value) ?? value;
        foreach (
            var key in new[]
            {
                "prompt",
                "revised_prompt",
                "result",
                "partial_image_b64",
                "b64_json",
            }
        )
            if (SessionWait.Text(item?[key]) is { Length: > 0 } sensitive)
                value = value.Replace(
                    sensitive,
                    "[image content omitted]",
                    StringComparison.Ordinal
                );
        // JSON/error-body dumps may contain arbitrary prompt or image fields.
        if (value.Contains('{') || value.Contains("\"prompt\"", StringComparison.OrdinalIgnoreCase))
            return "[structured error message omitted]";
        value = Regex.Replace(value, @"data:image/[^\s\""'<>]*", "[image data omitted]");
        value = Regex.Replace(value, @"[A-Za-z0-9+/_=-]{80,}", "[encoded data omitted]");
        value = new string(
            value.Select(character => char.IsControl(character) ? ' ' : character).ToArray()
        ).Trim();
        return value.Length > MaxText ? value[..MaxText] + "…" : value;
    }

    private static void AddIdentifier(
        JsonObject target,
        string key,
        string? value,
        Func<string, string>? redact
    )
    {
        if (string.IsNullOrEmpty(value))
            return;
        if (value.Length > 128)
        {
            target[key] = "[identifier omitted]";
            return;
        }
        value = redact?.Invoke(value) ?? value;
        target[key] =
            value == "[redacted]"
            || value.All(character =>
                char.IsAsciiLetterOrDigit(character) || character is '_' or '-' or '.' or ':'
            )
                ? value
                : "[identifier omitted]";
    }

    internal static JsonObject FailurePart(
        JsonObject summary,
        string imageId,
        string reason,
        string model
    )
    {
        var details = (JsonObject)summary.DeepClone();
        details["reason"] = reason;
        var error = details["error"] as JsonObject;
        var description = string.Join(
            "; ",
            new[]
            {
                reason,
                SessionWait.Text(error?["code"]),
                SessionWait.Text(error?["type"]),
                SessionWait.Text(error?["message"]),
            }.Where(value => !string.IsNullOrEmpty(value))
        );
        return new JsonObject
        {
            ["text"] =
                "[image generation did not produce a usable image: "
                + imageId
                + ": "
                + description
                + "]",
            ["providerMeta"] = new JsonObject
            {
                ["openaiResponses"] = new JsonObject
                {
                    ["sourceModelId"] = model,
                    ["imageGenerationFailure"] = details,
                },
            },
        };
    }
}
