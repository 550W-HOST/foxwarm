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
    // Dates and URLs are common in ordinary agent work (logs, versions, links).
    internal static IReadOnlyList<string> DefaultExcludeLabels { get; } =
    ["private_date", "private_url"];

    // Detection labels left in place, trimmed and lowercase. Sorted and distinct, so equal
    // settings share cache entries.
    internal IReadOnlyList<string> ExcludeLabels { get; init; } = DefaultExcludeLabels;

    internal const int MaxConcurrencyLimit = 64;

    // Detection calls in flight to this endpoint at once, shared by every request and Session.
    // It does not change detection results, so it is not part of cache identity.
    internal int MaxConcurrency { get; init; } = 1;

    // Values never replaced, trimmed, distinct ignoring case and sorted. A detected range whose
    // text equals one (ignoring case and surrounding whitespace) is left in place and does not
    // become a known value; known values on the list are not masked either. Part of cache
    // identity, so a changed list applies to the next request. Configured values add to
    // Foxwarm's own vocabulary, which is always kept.
    internal IReadOnlyList<string> KeepValues { get; init; } = [];

    // Names Foxwarm itself writes into model input: its name, the channel platforms in message
    // envelopes, and `foxwarm-*` envelope tag names. The detector can mistake them for personal
    // data in envelope context, and a mistaken value would otherwise be masked everywhere.
    private static readonly HashSet<string> OwnVocabulary = new(
        ["foxwarm", "webui", "telegram", "qqbot", "wework", "weixin", "matrix", "mcp"],
        StringComparer.OrdinalIgnoreCase
    );

    private HashSet<string>? keepSet;

    internal bool Keeps(string original)
    {
        var value = original.Trim();
        if (OwnVocabulary.Contains(value) || IsEnvelopeTagName(value))
            return true;
        return KeepValues.Count > 0
            && (
                keepSet ??= new HashSet<string>(KeepValues, StringComparer.OrdinalIgnoreCase)
            ).Contains(value);
    }

    // `foxwarm-` followed by lowercase letters, digits and hyphens.
    private static bool IsEnvelopeTagName(string value) =>
        value.Length > "foxwarm-".Length
        && value.StartsWith("foxwarm-", StringComparison.OrdinalIgnoreCase)
        && value.All(character =>
            character is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '-'
        );

    internal const int BatchBytesLimit = 262144;

    // Combines uncached slot texts into detection calls of up to this many UTF-8 bytes; 0 sends
    // each slot alone. A combined call lets the detector see neighbouring slots as context, so
    // results can differ slightly from single-slot detection. Cache entries are shared either
    // way, so it is not part of cache identity.
    internal int BatchBytes { get; init; }

    // Labels match case-insensitively and ignore surrounding whitespace.
    internal static string NormalizeLabel(string label) => label.Trim().ToLowerInvariant();

    public bool Equals(TextRedactionOptions? other) =>
        other is not null
        && Endpoint == other.Endpoint
        && ApiKey == other.ApiKey
        && Threshold.Equals(other.Threshold)
        && TimeoutMs == other.TimeoutMs
        && ExcludeLabels.SequenceEqual(other.ExcludeLabels, StringComparer.Ordinal)
        && KeepValues.SequenceEqual(other.KeepValues, StringComparer.Ordinal);

    public override int GetHashCode() =>
        HashCode.Combine(
            Endpoint,
            ApiKey,
            Threshold,
            TimeoutMs,
            string.Join('\n', ExcludeLabels),
            string.Join('\n', KeepValues)
        );

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
                // Lowercase scheme, matching the shared configuration schema.
                "endpoint" => SessionWait.Text(item) is string endpoint
                    && (
                        endpoint.StartsWith("http://", StringComparison.Ordinal)
                        || endpoint.StartsWith("https://", StringComparison.Ordinal)
                    )
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
                "maxConcurrency" => SessionWait.Number(item) is double concurrency
                    && double.IsFinite(concurrency)
                    && concurrency is >= 1 and <= MaxConcurrencyLimit
                    && Math.Floor(concurrency) == concurrency,
                "batchBytes" => SessionWait.Number(item) is double batch
                    && double.IsFinite(batch)
                    && batch is >= 0 and <= BatchBytesLimit
                    && Math.Floor(batch) == batch,
                "keepValues" => item is JsonArray values
                    && values.All(value =>
                        SessionWait.Text(value) is string text && text.Trim().Length > 0
                    ),
                "excludeLabels" => item is JsonArray labels
                    && labels.All(label =>
                        SessionWait.Text(label) is string text && text.Trim().Length > 0
                    ),
                _ => false,
            };
            if (!valid)
                throw new InvalidDataException("Invalid textRedaction." + key + ".");
        }
    }

    // Fields inherit one by one; a lower-level list replaces the inherited list.
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
        )
        {
            MaxConcurrency = HostModels.Positive(
                options["maxConcurrency"],
                1,
                "textRedaction.maxConcurrency"
            ),
            BatchBytes = (int)(SessionWait.Number(options["batchBytes"]) ?? 0),
            ExcludeLabels = options["excludeLabels"] is JsonArray labels
                ? labels
                    .Select(label => NormalizeLabel(SessionWait.Text(label)!))
                    .Distinct(StringComparer.Ordinal)
                    .Order(StringComparer.Ordinal)
                    .ToArray()
                : DefaultExcludeLabels,
            KeepValues = options["keepValues"] is JsonArray values
                ? values
                    .Select(value => SessionWait.Text(value)!.Trim())
                    .GroupBy(value => value, StringComparer.OrdinalIgnoreCase)
                    .Select(group => group.First())
                    .Order(StringComparer.OrdinalIgnoreCase)
                    .ThenBy(value => value, StringComparer.Ordinal)
                    .ToArray()
                : [],
        };
    }

    // Whether a leaf of this provider sends the detector key configured in models defaults.
    // A missing referenced defaults key then fails only those providers.
    internal static bool UsesDefaultApiKey(JsonObject? defaults, JsonObject provider)
    {
        if (
            defaults?["textRedaction"] is not JsonObject inherited
            || !inherited.ContainsKey("apiKey")
        )
            return false;
        if (provider["textRedaction"] is JsonObject own && own.ContainsKey("apiKey"))
            return false;
        JsonNode?[] listed;
        try
        {
            listed = HostModels.Members(provider);
        }
        catch (InvalidDataException)
        {
            // Catalog parsing reports invalid model lists.
            return false;
        }
        JsonObject?[] members =
            listed.Length > 0 ? listed.Select(member => member as JsonObject).ToArray() : [null];
        foreach (var model in members)
        {
            if (model?["textRedaction"] is JsonObject leaf && leaf.ContainsKey("apiKey"))
                continue;
            try
            {
                if (FromResolved(Resolve(defaults, provider, model)) is not null)
                    return true;
            }
            catch (InvalidDataException)
            {
                // Catalog parsing reports invalid settings.
            }
        }
        return false;
    }
}
