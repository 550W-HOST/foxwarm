using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// Shared by diagnostics and canonical hosted-image failure evidence. Capture the
// exact attempt's credentials once; later configuration changes cannot affect it.
internal sealed class ModelCredentialRedactor
{
    private readonly string[] secrets;

    internal ModelCredentialRedactor(ResponsesClientOptions options)
    {
        secrets = new[] { options.Token }
            .Concat(
                (options.ExtraHeaders ?? new JsonObject()).Select(pair =>
                    SessionWait.Text(pair.Value) ?? ""
                )
            )
            .Where(value => value.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .SelectMany(value => new[] { value, JsonData.Serialize(value)[1..^1] })
            .Distinct(StringComparer.Ordinal)
            .OrderByDescending(value => value.Length)
            .ToArray();
    }

    internal string TrimCredentialSuffix(string text)
    {
        var open = -1;
        var escaped = false;
        for (var index = 0; index < text.Length; index++)
        {
            if (open < 0)
            {
                if (text[index] == '"')
                    open = index;
            }
            else if (escaped)
                escaped = false;
            else if (text[index] == '\\')
                escaped = true;
            else if (text[index] == '"')
                open = -1;
        }
        // The cutoff may bisect an escaped credential. An incomplete
        // JSON literal cannot be safely decoded for redaction.
        if (open >= 0)
            text = text[..open] + "\"[truncated JSON string omitted]\"";
        return TrimSecretPrefix(text);
    }

    private string TrimSecretPrefix(string text)
    {
        foreach (var secret in secrets)
            for (var length = Math.Min(secret.Length - 1, text.Length); length > 0; length--)
                if (text.EndsWith(secret[..length], StringComparison.Ordinal))
                {
                    text = text[..^length] + "[redacted]";
                    break;
                }
        return text;
    }

    internal string SafeText(string text)
    {
        // Scan quoted lexemes, including an interrupted final literal or
        // one terminated by an illegal raw newline in malformed SSE.
        // Preserve unrelated spelling; only sensitive literals change.
        var result = new StringBuilder();
        var copied = 0;
        for (var start = 0; start < text.Length; start++)
        {
            if (text[start] != '"')
                continue;
            var end = start + 1;
            var escaped = false;
            var closed = false;
            for (; end < text.Length && text[end] is not ('\r' or '\n'); end++)
            {
                if (escaped)
                    escaped = false;
                else if (text[end] == '\\')
                    escaped = true;
                else if (text[end] == '"')
                {
                    closed = true;
                    end++;
                    break;
                }
            }
            var literal = text[start..end];
            string? decoded = null;
            try
            {
                decoded = JsonData.Deserialize<string>(closed ? literal : literal + "\"");
            }
            catch (JsonException) { }
            string? replacement = null;
            if (decoded is not null)
            {
                var safe = ReplaceSecrets(closed ? decoded : TrimSecretPrefix(decoded));
                if (safe != decoded)
                    replacement = JsonData.Serialize(safe);
            }
            // An interrupted escape cannot be decoded safely. Omit
            // only that literal, retaining the surrounding evidence.
            else if (secrets.Length > 0 && literal.Contains('\\'))
                replacement = "\"[malformed escaped string omitted]\"";
            if (replacement is not null)
            {
                result.Append(text.AsSpan(copied, start - copied));
                result.Append(replacement);
                copied = end;
            }
            start = end - 1;
        }
        result.Append(text.AsSpan(copied));
        return ReplaceSecrets(result.ToString());
    }

    private string ReplaceSecrets(string text)
    {
        foreach (var secret in secrets)
            text = text.Replace(secret, "[redacted]", StringComparison.Ordinal);
        return Regex.Replace(
            text,
            @"data:image/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]*",
            "data:image/omitted;base64,[image omitted from diagnostics]"
        );
    }
}
