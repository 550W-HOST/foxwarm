using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Secrets;

// How a literal (non-reference) value in a sink field feeds the redactor.
internal enum SecretSinkKind
{
    // The whole value is a credential.
    Credential,

    // A URL whose user info and query values may carry credentials.
    Url,

    // A process environment value: a credential only under a credential-like name.
    Environment,

    // A command argument: references resolve, literals are not treated as credentials.
    Argument,
}

internal sealed record SecretSinkField(string Path, string Value, SecretSinkKind Kind);

// Fields of one configuration document that may hold `${secret:NAME}` references.
// A reference anywhere else is a validation error, so stored values can only reach
// Main-owned credential consumers, never text that is displayed or sent to a model.
internal sealed class SecretSinks
{
    private readonly (string[] Pattern, SecretSinkKind Kind)[] patterns;

    private SecretSinks(params (string Pattern, SecretSinkKind Kind)[] patterns) =>
        this.patterns = patterns.Select(item => (item.Pattern.Split('.'), item.Kind)).ToArray();

    // models.yaml. `models` is the legacy alias of the providers map.
    internal static SecretSinks Models { get; } =
        new(
            ("providers.*.apiKey", SecretSinkKind.Credential),
            ("providers.*.extraHeaders.*", SecretSinkKind.Credential),
            ("providers.*.models.[].extraHeaders.*", SecretSinkKind.Credential),
            ("models.*.apiKey", SecretSinkKind.Credential),
            ("models.*.extraHeaders.*", SecretSinkKind.Credential),
            ("models.*.models.[].extraHeaders.*", SecretSinkKind.Credential)
        );

    // config.yaml credential fields consumed by Main-owned clients.
    internal static SecretSinks App { get; } =
        new(
            ("llm.openaiApiKey", SecretSinkKind.Credential),
            ("llm.anthropicApiKey", SecretSinkKind.Credential),
            ("asrService.key", SecretSinkKind.Credential),
            ("channels.*.botToken", SecretSinkKind.Credential),
            ("channels.*.accessToken", SecretSinkKind.Credential),
            ("channels.*.token", SecretSinkKind.Credential),
            ("channels.*.clientSecret", SecretSinkKind.Credential),
            ("channels.*.encodingAESKey", SecretSinkKind.Credential),
            ("channels.*.webhookUrl", SecretSinkKind.Url),
            ("channels.*.aibot.websocket.secret", SecretSinkKind.Credential)
        );

    // One mcp.json server definition (relative to the server object).
    internal static SecretSinks McpServer { get; } =
        new(
            ("token", SecretSinkKind.Credential),
            ("headers.*", SecretSinkKind.Credential),
            ("env.*", SecretSinkKind.Environment),
            ("args.[]", SecretSinkKind.Argument),
            ("url", SecretSinkKind.Url),
            ("oauth.clientSecret", SecretSinkKind.Credential)
        );

    internal SecretSinkKind? Match(IReadOnlyList<string> path)
    {
        foreach (var (pattern, kind) in patterns)
        {
            if (pattern.Length != path.Count)
                continue;
            var matched = true;
            for (var index = 0; index < pattern.Length && matched; index++)
                matched =
                    pattern[index] == "*" && !path[index].StartsWith('[')
                    || pattern[index] == "[]" && path[index].StartsWith('[')
                    || pattern[index] == path[index];
            if (matched)
                return kind;
        }
        return null;
    }

    // Every string in a sink field, with its display path.
    internal IEnumerable<SecretSinkField> Fields(JsonNode? root)
    {
        var found = new List<SecretSinkField>();
        Walk(
            root,
            [],
            (path, text) =>
            {
                if (Match(path) is { } kind)
                    found.Add(new(SecretReferences.Display(path), text, kind));
            }
        );
        return found;
    }

    internal static void Walk(JsonNode? node, List<string> path, Action<List<string>, string> visit)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var (key, child) in obj)
                {
                    path.Add(key);
                    Walk(child, path, visit);
                    path.RemoveAt(path.Count - 1);
                }
                break;
            case JsonArray array:
                for (var index = 0; index < array.Count; index++)
                {
                    path.Add("[" + index + "]");
                    Walk(array[index], path, visit);
                    path.RemoveAt(path.Count - 1);
                }
                break;
            case JsonValue value when SessionWait.Text(value) is string text:
                visit(path, text);
                break;
        }
    }
}

// Safe to show and log: the message names the consumer and secret names only.
internal sealed class SecretUnavailableException(string message)
    : InvalidOperationException(message)
{
    internal static SecretUnavailableException For(string consumer, IEnumerable<string> names) =>
        new(
            consumer
                + " references secret "
                + string.Join(", ", names.Select(name => "`" + name + "`"))
                + ", which is not available. Check Setup > Secrets."
        );
}

internal static partial class SecretReferences
{
    internal const string Prefix = "${secret:";

    [GeneratedRegex(@"\$\{secret:([^}]*)\}", RegexOptions.CultureInvariant)]
    private static partial Regex Reference();

    internal static bool Contains(string? text) =>
        text is not null && text.Contains(Prefix, StringComparison.Ordinal);

    internal static string Format(string name) => Prefix + name + "}";

    internal static string Display(IReadOnlyList<string> path)
    {
        var builder = new System.Text.StringBuilder();
        foreach (var segment in path)
        {
            if (builder.Length > 0 && !segment.StartsWith('['))
                builder.Append('.');
            builder.Append(segment);
        }
        return builder.ToString();
    }

    // Referenced names in order of appearance. Malformed references are errors.
    internal static IReadOnlyList<string> Names(string text)
    {
        if (!Contains(text))
            return [];
        var names = new List<string>();
        var matches = Reference().Matches(text);
        var covered = 0;
        foreach (Match match in matches)
        {
            var name = match.Groups[1].Value;
            if (!SecretStore.NamePattern().IsMatch(name))
                throw new InvalidDataException(
                    "Invalid secret reference name: " + Quote(name) + "."
                );
            names.Add(name);
            covered++;
        }
        var occurrences = 0;
        for (
            var index = text.IndexOf(Prefix, StringComparison.Ordinal);
            index >= 0;
            index = text.IndexOf(Prefix, index + Prefix.Length, StringComparison.Ordinal)
        )
            occurrences++;
        if (occurrences != covered)
            throw new InvalidDataException("A secret reference is missing its closing brace.");
        return names;
    }

    internal static string Resolve(
        string text,
        Func<string, string?> lookup,
        ICollection<string> missing
    )
    {
        _ = Names(text);
        return Reference()
            .Replace(
                text,
                match =>
                {
                    var name = match.Groups[1].Value;
                    var value = lookup(name);
                    if (value is null)
                    {
                        if (!missing.Contains(name))
                            missing.Add(name);
                        return "";
                    }
                    return value;
                }
            );
    }

    // Rejects references outside sink fields and malformed references in sink fields.
    internal static void Validate(JsonNode? document, SecretSinks sinks, string label)
    {
        SecretSinks.Walk(
            document,
            [],
            (path, text) =>
            {
                if (!Contains(text))
                    return;
                if (sinks.Match(path) is null)
                    throw new InvalidDataException(
                        label + " field " + Display(path) + " cannot use a secret reference."
                    );
                _ = Names(text);
            }
        );
    }

    // A copy with sink references replaced by stored values. Missing names are collected
    // and resolve to empty text; callers decide how a missing credential fails.
    internal static T Resolve<T>(
        T document,
        SecretSinks sinks,
        string label,
        Func<string, string?> lookup,
        ICollection<string> missing
    )
        where T : JsonNode
    {
        Validate(document, sinks, label);
        var copy = (T)document.DeepClone();
        Replace(copy, [], sinks, lookup, missing);
        return copy;
    }

    internal static IReadOnlyList<string> ReferencedNames(JsonNode? document)
    {
        var names = new List<string>();
        SecretSinks.Walk(
            document,
            [],
            (_, text) =>
            {
                if (!Contains(text))
                    return;
                try
                {
                    foreach (var name in Names(text))
                        if (!names.Contains(name))
                            names.Add(name);
                }
                catch (InvalidDataException) { }
            }
        );
        return names;
    }

    private static void Replace(
        JsonNode node,
        List<string> path,
        SecretSinks sinks,
        Func<string, string?> lookup,
        ICollection<string> missing
    )
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var key in obj.Select(pair => pair.Key).ToArray())
                {
                    path.Add(key);
                    if (obj[key] is JsonValue value && SessionWait.Text(value) is string text)
                    {
                        if (Contains(text) && sinks.Match(path) is not null)
                            obj[key] = Resolve(text, lookup, missing);
                    }
                    else if (obj[key] is { } child)
                        Replace(child, path, sinks, lookup, missing);
                    path.RemoveAt(path.Count - 1);
                }
                break;
            case JsonArray array:
                for (var index = 0; index < array.Count; index++)
                {
                    path.Add("[" + index + "]");
                    if (array[index] is JsonValue value && SessionWait.Text(value) is string text)
                    {
                        if (Contains(text) && sinks.Match(path) is not null)
                            array[index] = Resolve(text, lookup, missing);
                    }
                    else if (array[index] is { } child)
                        Replace(child, path, sinks, lookup, missing);
                    path.RemoveAt(path.Count - 1);
                }
                break;
        }
    }

    private static string Quote(string name) => name.Length > 70 ? name[..70] + "…" : name;
}

// Masked reads must not be written back: a marker would replace the real value. Only
// markers for currently known labels are rejected, so source and documentation that
// mention the marker format stay writable.
internal static partial class SecretMarkerGuard
{
    internal const string Message =
        "This input contains a secret marker ([[FW_SECRET:…]]), which stands in for a hidden value. Writing it would replace the real value with the marker text. Use a ${secret:NAME} reference in a configuration field that accepts one, or ask the user to make the change.";

    [GeneratedRegex(@"\[\[FW_SECRET:([A-Za-z0-9._:/-]+)\]\]", RegexOptions.CultureInvariant)]
    private static partial Regex Marker();

    internal static bool Contains(string text, Func<string, bool> known)
    {
        if (!text.Contains(SecretRedactor.MarkerPrefix, StringComparison.Ordinal))
            return false;
        foreach (Match match in Marker().Matches(text))
            if (known(match.Groups[1].Value))
                return true;
        return false;
    }

    internal static bool Contains(JsonNode? node, Func<string, bool> known)
    {
        var found = false;
        SecretSinks.Walk(node, [], (_, text) => found = found || Contains(text, known));
        return found;
    }

    internal static void Require(JsonNode? node, Func<string, bool> known)
    {
        if (Contains(node, known))
            throw new InvalidDataException(Message);
    }

    internal static void Require(string text, Func<string, bool> known)
    {
        if (Contains(text, known))
            throw new InvalidDataException(Message);
    }
}
