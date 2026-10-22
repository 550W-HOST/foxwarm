using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Models;

internal sealed class ModelPreparationException(string message, Exception? inner = null)
    : Exception(message, inner);

internal sealed class ModelAttemptFailure(
    string message,
    string kind,
    bool retryable,
    bool countable,
    string? status = null,
    Exception? inner = null
) : Exception(message, inner)
{
    internal string Kind { get; } = kind;
    internal bool Retryable { get; } = retryable;
    internal bool Countable { get; } = countable;
    internal string? Status { get; } = status;

    internal static ModelAttemptFailure Empty() =>
        new("Selected model disallows an empty completed response.", "response-error", true, true);

    internal static ModelAttemptFailure GeneratedImageFailure(string message) =>
        new(message, "response-error", false, false);

    internal static ModelAttemptFailure Http(int status, string body)
    {
        var (retryable, countable) = ClassifyHttp(status, body);
        var diagnostic = DiagnosticBody(body).Body;
        return new ModelAttemptFailure(
            body.Length == 0
                ? "HTTP " + status
                : Foxwarm.Images.ImageTransport.DiagnosticBody(diagnostic),
            "http-error",
            retryable,
            countable,
            status.ToString(CultureInfo.InvariantCulture)
        );
    }

    // The diagnostic carrier stays bounded; classification consumes the complete
    // provider error, whose structured code may follow a long message.
    internal static (string Body, bool Truncated) DiagnosticBody(string body)
    {
        const int limit = 64 * 1024;
        if (System.Text.Encoding.UTF8.GetByteCount(body) <= limit)
            return (body, false);
        var bytes = System.Text.Encoding.UTF8.GetBytes(body);
        return (System.Text.Encoding.UTF8.GetString(bytes, 0, limit), true);
    }

    internal static (bool Retryable, bool Countable) ClassifyHttp(int status, string body)
    {
        if (ModelNotFound(body))
            return (true, true);
        if (status is 400 or 413 or 422)
            return (false, false);
        if (status is 401 or 403 or 404 or 408 or 429 or 529 || status is >= 500 and <= 599)
            return (true, true);
        return (true, false);
    }

    private static bool ModelNotFound(string body)
    {
        var strings = new List<string>();
        var codes = new List<string>();
        void Collect(JsonNode? node, int depth)
        {
            if (depth > 8 || node is null)
                return;
            if (node is JsonValue value && value.TryGetValue<string>(out var text))
            {
                strings.Add(text);
                var trimmed = OpenAIRequestText.Trim(text);
                if (depth < 8 && (trimmed.StartsWith('{') || trimmed.StartsWith('[')))
                {
                    try
                    {
                        Collect(JsonNode.Parse(trimmed), depth + 1);
                    }
                    catch (System.Text.Json.JsonException) { }
                }
            }
            else if (node is JsonArray array)
                foreach (var item in array)
                    Collect(item, depth + 1);
            else if (node is JsonObject obj)
                foreach (var (key, item) in obj)
                {
                    if (
                        key is "code" or "type"
                        && item is JsonValue scalar
                        && scalar.TryGetValue<string>(out var code)
                    )
                        codes.Add(code);
                    Collect(item, depth + 1);
                }
        }
        Collect(JsonValue.Create(body), 0);
        if (
            codes.Any(code =>
                Regex.IsMatch(
                    Regex.Replace(code.ToLowerInvariant(), "[^a-z0-9]+", "_"),
                    "^(model_(not_found|does_not_exist)(_error)?|unknown_model(_error)?)$",
                    RegexOptions.CultureInvariant
                )
            )
        )
            return true;
        const RegexOptions flags =
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.ECMAScript;
        var all = string.Join('\n', strings);
        if (
            Regex.IsMatch(
                all,
                "\\bmodel([\\s_-]+)not([\\s_-]+)found\\b|\\bno\\s+such\\s+model\\b",
                flags
            )
        )
            return true;
        var name = "(?:\"[^\"]{1,200}\"|'[^']{1,200}'|`[^`]{1,200}`|[^\\s,;:]{1,200})";
        if (
            Regex.IsMatch(
                all,
                "\\b(?:the\\s+|requested\\s+)?model\\s+"
                    + name
                    + "\\s+(?:(?:was\\s+)?not\\s+found|does\\s+not\\s+exist)\\b",
                flags
            )
        )
            return true;
        foreach (var text in strings)
        {
            var match = Regex.Match(text, "\\bunknown\\s+model\\b", flags);
            if (!match.Success)
                continue;
            var suffix = OpenAIRequestText.Trim(text[(match.Index + match.Length)..]);
            if (suffix.Length == 0 || ".:;,\"'`".Contains(suffix[0]))
                return true;
            var token = Regex.Split(suffix, "\\s|[,;]", flags)[0].TrimEnd('.', '!', '?');
            if (Regex.IsMatch(token, "[0-9]|[/_-]|\\.[A-Za-z0-9]", RegexOptions.CultureInvariant))
                return true;
        }
        return false;
    }

    internal static string Summary(string message)
    {
        var text = Regex.Replace(message, "[\\r\\n\\t]+", " ", RegexOptions.CultureInvariant);
        var elements = StringInfo.GetTextElementEnumerator(text);
        var count = 0;
        var end = text.Length;
        while (elements.MoveNext())
            if (++count > 240)
            {
                end = elements.ElementIndex;
                break;
            }
        return end == text.Length ? text : text[..end] + "…";
    }
}

internal sealed record ModelRetryEvent(
    int Attempt,
    int MaxRetries,
    string Kind,
    string Reason,
    string ModelId,
    string? VirtualModelKey,
    string? Status = null,
    int? NextAttempt = null,
    int? DelayMs = null,
    bool Final = false
)
{
    internal JsonObject ToJson() =>
        new()
        {
            ["attempt"] = Attempt,
            ["maxRetries"] = MaxRetries,
            ["kind"] = Kind,
            ["reason"] = Reason,
            ["status"] = Status,
            ["modelId"] = ModelId,
            ["virtualModelKey"] = VirtualModelKey,
            ["nextAttempt"] = NextAttempt,
            ["delayMs"] = DelayMs,
            ["final"] = Final,
        };
}

internal sealed class ModelRequestException(string message, ModelRetryEvent final)
    : Exception(message)
{
    internal ModelRetryEvent Final { get; } = final;
    internal bool TerminalNoticeDelivered { get; set; }
}
