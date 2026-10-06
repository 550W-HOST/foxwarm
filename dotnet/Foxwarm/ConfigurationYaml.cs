using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace Foxwarm;

internal static class ConfigurationYaml
{
    internal static JsonObject Parse(string text, string label)
    {
        try
        {
            var stream = new YamlStream();
            stream.Load(new MergingParser(new Parser(new StringReader(text))));
            if (stream.Documents.Count > 1)
                throw new InvalidDataException(label + " must contain one YAML document.");
            var root =
                stream.Documents.Count == 0
                    ? null
                    : Convert(
                        stream.Documents[0].RootNode,
                        new HashSet<YamlNode>(ReferenceEqualityComparer.Instance)
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

    private static JsonNode? Convert(YamlNode node, HashSet<YamlNode> active)
    {
        if (!active.Add(node))
            throw new InvalidDataException("YAML aliases must not form a cycle.");
        try
        {
            if (node is YamlScalarNode scalar)
                return Scalar(scalar);
            if (node is YamlSequenceNode sequence)
                return new JsonArray(
                    sequence.Children.Select(child => Convert(child, active)).ToArray()
                );
            if (node is YamlMappingNode map)
            {
                var result = new JsonObject();
                foreach (var (key, value) in map.Children)
                {
                    if (key is not YamlScalarNode name)
                        throw new InvalidDataException(
                            "Configuration mapping keys must be scalar values."
                        );
                    result.Add(name.Value ?? "null", Convert(value, active));
                }
                return result;
            }
            throw new InvalidDataException("Unsupported YAML configuration node.");
        }
        finally
        {
            active.Remove(node);
        }
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
