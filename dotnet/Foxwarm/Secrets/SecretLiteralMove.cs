using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace Foxwarm.Secrets;

// Moves a credential literal from configuration sink fields into the store: each field's
// scalar is replaced by a reference to the new secret and nothing else in the document
// changes. The destination of the value stays the same, so a move is not a secret fact.
internal static class SecretLiteralMove
{
    internal sealed record Location(string Target, IReadOnlyList<string> Path)
    {
        internal string Display => Target + ":" + SecretReferences.Display(Path);
    }

    internal static string Reference(string name) => "${secret:" + name + "}";

    // `fromConfig` entries: {target: models|config|mcp, path: [keys and list indexes]}. An MCP
    // path starts with the server name.
    internal static IReadOnlyList<Location> Parse(JsonNode? node)
    {
        if (node is not JsonArray items || items.Count is < 1 or > 16)
            throw new InvalidDataException("fromConfig requires 1-16 locations.");
        var locations = new List<Location>();
        foreach (var item in items)
        {
            if (item is not JsonObject entry)
                throw new InvalidDataException("Each fromConfig location must be an object.");
            ToolRegistry.Keys(entry, ["target", "path"]);
            var target = SessionWait.Text(entry["target"]);
            if (target is not ("models" or "config" or "mcp"))
                throw new InvalidDataException("fromConfig target must be models, config or mcp.");
            if (entry["path"] is not JsonArray raw || raw.Count is < 1 or > 16)
                throw new InvalidDataException("fromConfig path must list 1-16 keys.");
            var path = new List<string>();
            foreach (var segment in raw)
            {
                if (segment is JsonValue value && value.TryGetValue<string>(out var key))
                    path.Add(key);
                else if (
                    segment is JsonValue number
                    && number.TryGetValue<double>(out var index)
                    && index >= 0
                    && index == Math.Floor(index)
                    && index < 10000
                )
                    path.Add("[" + (int)index + "]");
                else
                    throw new InvalidDataException(
                        "fromConfig path entries are keys or list indexes."
                    );
            }
            if (target == "mcp" && path.Count < 2)
                throw new InvalidDataException("An mcp path names the server and then the field.");
            var location = new Location(target, path);
            if (locations.Any(other => other.Display == location.Display))
                throw new InvalidDataException("fromConfig lists a location twice.");
            locations.Add(location);
        }
        return locations;
    }

    // The literal a sink field holds: nonempty text that is not already a reference.
    private static string Literal(JsonNode? value, Location location)
    {
        if (value is not JsonValue text || !text.TryGetValue<string>(out var literal))
            throw new InvalidDataException($"{location.Display} does not hold text.");
        if (literal.Length == 0)
            throw new InvalidDataException($"{location.Display} is empty.");
        if (SecretReferences.Contains(literal))
            throw new InvalidDataException($"{location.Display} already uses a stored secret.");
        return literal;
    }

    private static JsonNode? At(JsonNode? root, IReadOnlyList<string> path)
    {
        var node = root;
        foreach (var segment in path)
            node = segment.StartsWith('[')
                ? node is JsonArray array
                && int.Parse(segment[1..^1]) is var index
                && index < array.Count
                    ? array[index]
                    : null
                : (node as JsonObject)?[segment];
        return node;
    }

    // The literal held by every location of one YAML document, which must be the same.
    internal static string ReadYaml(
        string text,
        IReadOnlyList<Location> locations,
        SecretSinks sinks,
        string label
    )
    {
        var root = ConfigurationYaml.Parse(text, label);
        string? literal = null;
        foreach (var location in locations)
        {
            if (sinks.Match(location.Path) is null)
                throw new InvalidDataException(
                    $"{location.Display} is not a credential field that can use a stored secret."
                );
            var value = Literal(At(root, location.Path), location);
            if (literal is not null && literal != value)
                throw new InvalidDataException("The listed fields hold different values.");
            literal = value;
        }
        return literal!;
    }

    // Replaces the scalar at each location with the reference. Only the scalars change: the
    // rest of the document keeps its bytes, comments and layout. A value reached through an
    // anchor, alias or merge key, or written as a block scalar, is not moved.
    internal static string RewriteYaml(
        string text,
        IReadOnlyList<Location> locations,
        string literal,
        string reference,
        string label
    )
    {
        var stream = new YamlStream();
        try
        {
            stream.Load(new Parser(new StringReader(text)));
        }
        catch (YamlException)
        {
            throw new InvalidDataException($"The {label} file is not valid YAML.");
        }
        if (stream.Documents.Count != 1)
            throw new InvalidDataException($"The {label} file must hold one YAML document.");
        var ranges = new List<(int Start, int End)>();
        foreach (var location in locations)
        {
            YamlNode node = stream.Documents[0].RootNode;
            foreach (var segment in location.Path)
            {
                if (!node.Anchor.IsEmpty)
                    throw new InvalidDataException(
                        $"{location.Display} is shared through a YAML anchor; edit it in Setup or the file."
                    );
                node = segment.StartsWith('[')
                    ? node is YamlSequenceNode sequence
                    && int.Parse(segment[1..^1]) is var index
                    && index < sequence.Children.Count
                        ? sequence.Children[index]
                        : throw NotFound(location)
                    : node is YamlMappingNode map
                    && map
                        .Children.Where(pair =>
                            pair.Key is YamlScalarNode key && key.Value == segment
                        )
                        .ToArray()
                        is [var single]
                        ? single.Value
                        : throw NotFound(location);
            }
            if (
                node is not YamlScalarNode scalar
                || !scalar.Anchor.IsEmpty
                || scalar.Style is ScalarStyle.Literal or ScalarStyle.Folded
                || scalar.Value != literal
            )
                throw new InvalidDataException(
                    $"{location.Display} is not a single-line value written directly in the file; edit it in Setup or the file."
                );
            ranges.Add(((int)scalar.Start.Index, (int)scalar.End.Index));
        }
        var rewritten = text;
        foreach (var (start, end) in ranges.OrderByDescending(range => range.Start))
            rewritten = rewritten[..start] + "\"" + reference + "\"" + rewritten[end..];
        // Exactly the listed fields changed, as the configuration reader sees the document.
        var expected = ConfigurationYaml.Parse(text, label);
        foreach (var location in locations)
            Set(expected, location.Path, JsonValue.Create(reference));
        if (!JsonNode.DeepEquals(expected, ConfigurationYaml.Parse(rewritten, label)))
            throw new InvalidDataException(
                $"The {label} file could not be rewritten safely; edit it in Setup or the file."
            );
        return rewritten;
    }

    private static InvalidDataException NotFound(Location location) =>
        new($"{location.Display} was not found as a field written directly in the file.");

    private static void Set(JsonNode root, IReadOnlyList<string> path, JsonNode value)
    {
        var parent = At(root, path.Take(path.Count - 1).ToArray());
        var last = path[^1];
        if (last.StartsWith('[') && parent is JsonArray array)
            array[int.Parse(last[1..^1])] = value;
        else if (parent is JsonObject map)
            map[last] = value;
    }

    // The literal held by the listed fields of MCP servers, and per server the patch that
    // replaces them, built from the given snapshot of the server map.
    internal static (string Literal, Dictionary<string, JsonObject> Patches) Mcp(
        JsonObject servers,
        IReadOnlyList<Location> locations,
        string reference
    )
    {
        string? literal = null;
        var patches = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var location in locations)
        {
            var server = location.Path[0];
            var field = location.Path.Skip(1).ToArray();
            if (servers[server] is not JsonObject definition)
                throw new InvalidDataException("MCP server not found: " + server);
            if (SecretSinks.McpServer.Match(field) is null)
                throw new InvalidDataException(
                    $"{location.Display} is not a credential field that can use a stored secret."
                );
            if (field[0] == "url" && definition["oauth"] is not null)
                throw new InvalidDataException(
                    $"{location.Display} identifies the server's OAuth sign-in; edit it in Setup."
                );
            var value = Literal(At(definition, field), location);
            if (literal is not null && literal != value)
                throw new InvalidDataException("The listed fields hold different values.");
            literal = value;
            if (!patches.TryGetValue(server, out var patch))
                patches[server] = patch = new JsonObject();
            // mcp_config replaces a top-level field as a whole.
            var top = field[0];
            if (!patch.ContainsKey(top))
                patch[top] = definition[top]?.DeepClone();
            if (field.Length == 1)
                patch[top] = JsonValue.Create(reference);
            else
                Set(patch[top]!, field.Skip(1).ToArray(), JsonValue.Create(reference));
        }
        return (literal!, patches);
    }
}
