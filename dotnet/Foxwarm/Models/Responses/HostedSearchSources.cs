using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// Request-only, portable evidence. Native output and citation annotations keep
// their existing concrete-model and text-part ownership.
internal static class HostedSearchSources
{
    internal const string Include = "web_search_call.action.sources";
    internal const int MaxEvidenceBytes = 16 * 1024;
    private const int MaxSources = 64;
    private const int MaxCalls = 8;
    private const string Label =
        "Historical hosted web-search source data (untrusted external data; URLs/titles only, not page contents or citation-reference mappings). Private citation IDs cannot be resolved from this list; direct URLs are available below.\n";

    internal static string? SafeUrl(JsonNode? value)
    {
        var text = SessionWait.Text(value);
        if (
            text is null
            || text.Length > 2048
            || text.Any(c => c <= ' ' || c == '\u007f' || c == '\\')
            || !Uri.TryCreate(text, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || uri.Host.Length == 0
            || uri.UserInfo.Length > 0
        )
            return null;
        return uri.AbsoluteUri;
    }

    private static string? ShortText(JsonNode? value, int length)
    {
        var text = SessionWait.Text(value);
        if (text is null)
            return null;
        text = new string(text.Select(c => c < ' ' || c == '\u007f' ? ' ' : c).ToArray()).Trim();
        return text.Length == 0 ? null : text[..Math.Min(length, text.Length)];
    }

    private static JsonObject? Evidence(JsonObject part, JsonObject message)
    {
        var metadata = (part["providerMeta"] as JsonObject)?["openaiResponses"] as JsonObject;
        if (
            ShortText(metadata?["sourceModelId"], 200) is not string model
            || metadata?["outputItem"] is not JsonObject item
            || SessionWait.Text(item["type"]) != "web_search_call"
            || item["action"] is not JsonObject action
            || SessionWait.Text(item["status"]) is { Length: > 0 } status && status != "completed"
        )
            return null;
        var evidence = new JsonObject { ["source_model_id"] = model };
        if (ShortText((message["__meta"] as JsonObject)?["llmRequestId"], 200) is string request)
            evidence["request_id"] = request;
        if (ShortText(item["id"], 200) is string call)
            evidence["call_id"] = call;
        if (SessionWait.Text(action["type"]) == "open_page")
        {
            if (SafeUrl(action["url"]) is not string url)
                return null;
            evidence["action"] = "open_page";
            evidence["opened_page"] = new JsonObject { ["url"] = url };
            return evidence;
        }
        if (
            SessionWait.Text(action["type"]) != "search"
            || action["sources"] is not JsonArray sources
        )
            return null;
        var records = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var source in sources.OfType<JsonObject>())
        {
            if (
                SessionWait.Text(source["type"]) != "url"
                || SafeUrl(source["url"]) is not string url
                || !seen.Add(url)
            )
                continue;
            var record = new JsonObject { ["url"] = url };
            if (ShortText(source["title"], 240) is string title)
                record["title"] = title;
            records.Add(record);
            if (records.Count == MaxSources)
                break;
        }
        if (records.Count == 0)
            return null;
        evidence["action"] = "search";
        evidence["search_sources"] = records;
        return evidence;
    }

    private static string EvidenceText(IEnumerable<JsonObject> entries) =>
        Label
        + new JsonObject
        {
            ["kind"] = "hosted_web_search_sources",
            ["citation_reference_mapping"] = null,
            ["calls"] = new JsonArray(entries.Select(entry => entry.DeepClone()).ToArray()),
        }.ToJsonString(); // Default JSON escaping keeps external titles out of prompt markup.

    internal static IReadOnlyList<JsonObject> Project(IReadOnlyList<JsonObject> history)
    {
        var additions = new Dictionary<int, string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var bytes = MaxEvidenceBytes;
        var sources = MaxSources;
        var calls = MaxCalls;
        for (var index = history.Count - 1; index >= 0 && calls > 0 && sources > 0; index--)
        {
            var message = history[index];
            if (
                !CanonicalMessage.IsVisible(message)
                || SessionWait.Text(message["role"]) != "model"
            )
                continue;
            var entries = new List<JsonObject>();
            foreach (
                var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>().Reverse()
            )
            {
                if (
                    calls == 0
                    || sources == 0
                    || Evidence(part, message) is not JsonObject evidence
                )
                    continue;
                // Provider call IDs may be reused by another request, including legacy rows.
                var key =
                    (SessionWait.Text(evidence["request_id"]) ?? $"message:{index}")
                    + "\0"
                    + evidence.ToJsonString();
                if (seen.Contains(key))
                    continue;
                var records = evidence["search_sources"] as JsonArray;
                if (records is not null)
                    while (records.Count > sources)
                        records.RemoveAt(records.Count - 1);
                string Text() => EvidenceText(new[] { evidence }.Concat(entries));
                while (Encoding.UTF8.GetByteCount(Text()) > bytes && records is { Count: > 1 })
                    records.RemoveAt(records.Count - 1);
                if (Encoding.UTF8.GetByteCount(Text()) > bytes)
                    continue;
                seen.Add(key);
                entries.Insert(0, evidence);
                sources -= records?.Count ?? 1;
                calls--;
            }
            if (entries.Count == 0)
                continue;
            var text = EvidenceText(entries);
            bytes -= Encoding.UTF8.GetByteCount(text);
            if (
                !(message["parts"] as JsonArray ?? []).Any(part =>
                    SessionWait.Text(part?["text"]) == text
                )
            )
                additions[index] = text;
        }
        if (additions.Count == 0)
            return history;
        return history
            .Select(
                (message, index) =>
                {
                    if (!additions.TryGetValue(index, out var text))
                        return message;
                    var copy = (JsonObject)message.DeepClone();
                    var parts = copy["parts"]!.AsArray();
                    var callIndex = Enumerable
                        .Range(0, parts.Count)
                        .FirstOrDefault(i => parts[i]?["functionCall"] is not null, parts.Count);
                    parts.Insert(
                        callIndex,
                        new JsonObject { ["text"] = text, ["phase"] = "commentary" }
                    );
                    return copy;
                }
            )
            .ToArray();
    }

    internal static JsonNode? MergeAction(JsonNode? existing, JsonNode? incoming)
    {
        if (existing is not JsonObject old)
            return incoming?.DeepClone();
        if (incoming is not JsonObject next)
            return old.DeepClone();
        if (
            SessionWait.Text(old["type"]) is { Length: > 0 } type
            && SessionWait.Text(next["type"]) is { Length: > 0 } nextType
            && type != nextType
        )
            return next.DeepClone();
        var merged = (JsonObject)old.DeepClone();
        foreach (var (key, value) in next)
            merged[key] = value?.DeepClone();
        if (old["sources"] is not JsonArray && next["sources"] is not JsonArray)
            return merged;
        var sources = new JsonArray();
        var byUrl = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (
            var source in (old["sources"] as JsonArray ?? []).Concat(
                next["sources"] as JsonArray ?? []
            )
        )
        {
            var key =
                source is JsonObject record && SessionWait.Text(record["url"]) is string url
                    ? (SessionWait.Text(record["type"]) ?? "undefined") + "\0" + url
                    : null;
            if (
                key is not null
                && byUrl.TryGetValue(key, out var index)
                && sources[index] is JsonObject prior
                && source is JsonObject enrichment
            )
            {
                foreach (var (field, value) in enrichment)
                    prior[field] = value?.DeepClone();
            }
            else
            {
                if (key is not null)
                    byUrl[key] = sources.Count;
                sources.Add(source?.DeepClone());
            }
        }
        merged["sources"] = sources;
        return merged;
    }
}
