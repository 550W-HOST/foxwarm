using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Secrets;

// Masks known values in canonical messages and request payloads. Reasoning and
// provider replay data are never rewritten: thinking text under a signature must stay
// byte-identical for replay. A known value found there is only reported.
internal static class SecretMessageRedaction
{
    internal sealed class Findings
    {
        internal List<string> Masked { get; } = new();
        internal List<string> Reasoning { get; } = new();
    }

    // Returns the same instance when nothing changed.
    internal static JsonObject Message(
        SecretRedactor redactor,
        JsonObject message,
        Findings findings
    )
    {
        if (redactor.IsEmpty || !redactor.Contains(message))
            return message;
        var copy = (JsonObject)message.DeepClone();
        var changed = false;
        foreach (var key in copy.Select(pair => pair.Key).ToArray())
        {
            if (key is "__meta" or "providerMeta")
                continue;
            if (key == "parts" && copy[key] is JsonArray parts)
            {
                foreach (var part in parts.OfType<JsonObject>())
                    changed |= Part(redactor, part, findings);
                continue;
            }
            if (key == "content" && copy[key] is JsonArray blocks)
            {
                foreach (var block in blocks.OfType<JsonObject>())
                {
                    if (
                        SessionWait.Text(block["type"])
                        is "thinking"
                            or "redacted_thinking"
                            or "reasoning"
                    )
                    {
                        Report(redactor, block, findings);
                        continue;
                    }
                    changed |= Strings(redactor, block, findings);
                }
                continue;
            }
            changed |= Field(redactor, copy, key, findings);
        }
        return changed ? copy : message;
    }

    private static bool Part(SecretRedactor redactor, JsonObject part, Findings findings)
    {
        if (part.ContainsKey("thinking") || IsReasoningMeta(part["providerMeta"]))
        {
            Report(redactor, part, findings);
            return false;
        }
        var changed = false;
        foreach (var key in part.Select(pair => pair.Key).ToArray())
        {
            if (key is "providerMeta" or "inlineData" or "inlineDataRef" or "__meta")
                continue;
            changed |= Field(redactor, part, key, findings);
        }
        return changed;
    }

    private static bool IsReasoningMeta(JsonNode? meta) =>
        meta is JsonObject value
        && (
            value.ContainsKey("signature")
            || value.ContainsKey("encryptedThinking")
            || value.ContainsKey("redactedThinking")
            || value.ContainsKey("thinkingSummaries")
            || SessionWait.Text(value["openaiResponses"]?["outputItem"]?["type"]) == "reasoning"
        );

    private static bool Field(
        SecretRedactor redactor,
        JsonObject owner,
        string key,
        Findings findings
    )
    {
        var node = owner[key];
        if (node is JsonValue && SessionWait.Text(node) is string text)
        {
            var redacted = redactor.Redact(text, findings.Masked);
            if (ReferenceEquals(redacted, text))
                return false;
            owner[key] = redacted;
            return true;
        }
        if (node is JsonObject or JsonArray)
        {
            var redacted = redactor.Redact(node, findings.Masked);
            if (ReferenceEquals(redacted, node))
                return false;
            owner[key] = redacted;
            return true;
        }
        return false;
    }

    private static bool Strings(SecretRedactor redactor, JsonObject owner, Findings findings)
    {
        var changed = false;
        foreach (var key in owner.Select(pair => pair.Key).ToArray())
            changed |= Field(redactor, owner, key, findings);
        return changed;
    }

    private static void Report(SecretRedactor redactor, JsonNode node, Findings findings)
    {
        var hits = new List<string>();
        _ = redactor.Redact(node, hits);
        foreach (var hit in hits)
            if (!findings.Reasoning.Contains(hit))
                findings.Reasoning.Add(hit);
    }
}
