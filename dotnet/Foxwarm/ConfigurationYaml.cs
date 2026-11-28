using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using YamlDotNet.Core.Events;
using System.Text.RegularExpressions;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace Foxwarm;

internal static class ConfigurationYaml
{
    internal static JsonObject Parse(string text, string label, int nodes = 100_000, int scalarBytes = 8 * 1024 * 1024, int depth = 64, int mergeWork = 100_000)
    {
        try
        {
            var stream = new YamlStream();
            stream.Load(new CheckedParser(new Parser(new StringReader(text)), depth));
            var budget = new Expansion(nodes, scalarBytes, depth, mergeWork);
            if (stream.Documents.Count > 1)
                throw new InvalidDataException(label + " must contain one YAML document.");
            var root =
                stream.Documents.Count == 0
                    ? null
                    : Convert(
                        stream.Documents[0].RootNode,
                        budget
                    );
            return root is null
                ? new JsonObject()
                : root as JsonObject
                    ?? throw new InvalidDataException(label + " must be a YAML object.");
        }
        catch (YamlException error)
        {
            throw new InvalidDataException(
                $"Invalid {label} YAML at line {error.Start.Line + 1}, column {error.Start.Column + 1}."
            );
        }
    }

    private static InvalidDataException TooLarge() => new("Configuration YAML exceeds its expansion limit.");

    // YamlStream constructs the source graph recursively and hashes mapping keys before
    // conversion. Enforce physical depth and scalar keys before handing it each event.
    private sealed class CheckedParser(IParser source, int maxDepth) : IParser
    {
        private readonly Stack<(bool Map, bool Key)> frames = new();
        private readonly HashSet<AnchorName> scalarAnchors = [];
        private int events;
        public ParsingEvent? Current => source.Current;

        public bool MoveNext()
        {
            if (!source.MoveNext()) return false;
            var item = source.Current!;
            if (++events > 100_000) throw TooLarge(); // old MergingParser source-event ceiling
            if (item is MappingEnd or SequenceEnd) frames.Pop();
            if (item is not (NodeEvent or AnchorAlias)) return true;
            if (frames.TryPop(out var parent))
            {
                if (parent.Map && parent.Key && item is not YamlDotNet.Core.Events.Scalar
                    && !(item is AnchorAlias a && scalarAnchors.Contains(a.Value)))
                    throw new InvalidDataException("Configuration mapping keys must be scalar values.");
                frames.Push((parent.Map, !parent.Key));
            }
            if (item is NodeEvent node && !node.Anchor.IsEmpty)
            {
                if (item is YamlDotNet.Core.Events.Scalar) scalarAnchors.Add(node.Anchor);
                else scalarAnchors.Remove(node.Anchor);
            }
            if (item is MappingStart or SequenceStart)
            {
                if (frames.Count >= maxDepth) throw TooLarge();
                frames.Push((item is MappingStart, true));
            }
            return true;
        }
    }

    private sealed class Expansion(int nodes, int scalarBytes, int depth, int mergeWork)
    {
        internal readonly HashSet<YamlNode> Active = new(ReferenceEqualityComparer.Instance);

        internal void Charge(YamlNode node)
        {
            if (--nodes < 0 || Active.Count >= depth) throw TooLarge();
            if (node is YamlScalarNode { Value: { } value })
            {
                scalarBytes -= Encoding.UTF8.GetByteCount(value);
                if (scalarBytes < 0) throw TooLarge();
            }
        }

        internal void MergeStep() { if (--mergeWork < 0) throw TooLarge(); }
    }

    private static JsonNode? Convert(YamlNode node, Expansion budget)
    {
        budget.Charge(node);
        if (!budget.Active.Add(node))
            throw new InvalidDataException("YAML aliases must not form a cycle.");
        try
        {
            if (node is YamlScalarNode scalar) return Scalar(scalar);
            if (node is YamlSequenceNode sequence)
            {
                var result = new JsonArray();
                foreach (var child in sequence.Children) result.Add(Convert(child, budget));
                return result;
            }
            if (node is YamlMappingNode map)
            {
                var result = new JsonObject();
                foreach (var (key, value) in map.Children)
                {
                    var name = (YamlScalarNode)key;
                    budget.Charge(name);
                    if (name.Value == "<<") Merge(result, value, budget);
                    else result.Add(name.Value ?? "null", Convert(value, budget));
                }
                return result;
            }
            throw new InvalidDataException("Unsupported YAML configuration node.");
        }
        finally { budget.Active.Remove(node); }
    }

    private static void Merge(JsonObject result, YamlNode source, Expansion budget)
    {
        void AddMapping(YamlNode node)
        {
            budget.MergeStep();
            if (node is not YamlMappingNode) throw new InvalidDataException("Invalid YAML merge source.");
            var values = (JsonObject)Convert(node, budget)!;
            // Detach once before inserting: JsonNode values cannot have two parents.
            var entries = values.ToArray();
            values.Clear();
            foreach (var (key, value) in entries)
            {
                budget.MergeStep();
                if (!result.TryAdd(key, value)) throw new InvalidDataException("Duplicate configuration mapping key.");
            }
        }
        if (source is YamlSequenceNode list)
        {
            budget.Charge(list);
            foreach (var node in list.Children.Reverse()) AddMapping(node);
        }
        else AddMapping(source);
    }

    private static JsonNode? Scalar(YamlScalarNode scalar)
    {
        var value = scalar.Value ?? "";
        var tag = scalar.Tag.IsEmpty ? "" : scalar.Tag.Value;
        if (
            tag == "tag:yaml.org,2002:str"
            || scalar.Style is not (ScalarStyle.Plain or ScalarStyle.Any)
        )
            return JsonValue.Create(value);
        if (value is "" or "~" or "null" or "Null" or "NULL")
            return null;
        if (value is "true" or "True" or "TRUE")
            return JsonValue.Create(true);
        if (value is "false" or "False" or "FALSE")
            return JsonValue.Create(false);
        var numeric = value.Replace("_", "", StringComparison.Ordinal);
        if (Regex.IsMatch(numeric, "^[+-]?0[xob][0-9a-fA-F]+$"))
        {
            try
            {
                var sign = numeric.StartsWith('-') ? -1 : 1;
                var unsigned = numeric.TrimStart('+', '-');
                var radix =
                    unsigned[1] == 'x' ? 16
                    : unsigned[1] == 'o' ? 8
                    : 2;
                return JsonValue.Create(
                    sign * (double)System.Convert.ToInt64(unsigned[2..], radix)
                );
            }
            catch (Exception error)
                when (error is FormatException or OverflowException or ArgumentException) { }
        }
        if (
            Regex.IsMatch(numeric, "^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
            && double.TryParse(
                numeric,
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out var number
            )
        )
            return JsonValue.Create(number);
        if (numeric.ToLowerInvariant() is ".inf" or "+.inf" or "-.inf" or ".nan")
            throw new InvalidDataException(
                "Non-finite YAML configuration numbers are unsupported."
            );
        return JsonValue.Create(value);
    }
}
