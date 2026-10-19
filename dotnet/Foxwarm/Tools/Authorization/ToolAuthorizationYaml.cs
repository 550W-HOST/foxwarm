using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace Foxwarm.Tools;

internal static class ToolAuthorizationYaml
{
    private enum Shape
    {
        Root,
        Rules,
        Rule,
        Match,
        Args,
        Tool,
        Path,
        Matcher,
        Argument,
        Session,
        Task,
        Node,
        Scalar,
        ScalarList,
        ScalarOrList,
    }

    internal static ToolAuthorizationPolicy Parse(byte[] bytes)
    {
        if (bytes.Length > ToolAuthorizationPolicy.MaxBytes)
            throw new InvalidDataException("Tool policy exceeds its byte limit.");
        try
        {
            var graph = ToolAuthorizationYamlGraph.Parse(Encoding.UTF8.GetString(bytes));
            var root = Convert(
                graph,
                Shape.Root,
                new HashSet<PolicyYamlNode>(ReferenceEqualityComparer.Instance)
            );
            return ToolAuthorizationPolicy.Normalize(
                root as JsonObject
                    ?? throw new InvalidDataException("Tool policy requires a YAML object.")
            );
        }
        catch (YamlException error)
        {
            throw new InvalidDataException(
                $"Invalid tool policy YAML at line {error.Start.Line + 1}, column {error.Start.Column + 1}."
            );
        }
    }

    private static JsonNode? Convert(
        PolicyYamlNode node,
        Shape shape,
        HashSet<PolicyYamlNode> active
    )
    {
        if (!active.Add(node))
            throw new InvalidDataException("Cyclic tool policy YAML alias.");
        try
        {
            if (node.Scalar is { } scalar)
            {
                var value = ToolAuthorizationYamlGraph.ScalarValue(scalar);
                return value is null
                    ? null
                    : value as JsonNode
                        ?? throw new InvalidDataException(
                            "Policy matcher requires a finite scalar."
                        );
            }
            if (node.List is { } sequence)
            {
                if (
                    shape
                    is not (
                        Shape.Rules
                        or Shape.Matcher
                        or Shape.Argument
                        or Shape.Tool
                        or Shape.Node
                        or Shape.ScalarList
                        or Shape.ScalarOrList
                    )
                )
                    throw new InvalidDataException("Invalid policy sequence.");
                var maximum = shape == Shape.Rules ? 256 : 64;
                if (sequence.Count > maximum)
                    throw new InvalidDataException("Policy sequence exceeds its item limit.");
                var child = shape == Shape.Rules ? Shape.Rule : Shape.Scalar;
                return new JsonArray(
                    sequence.Select(item => Convert(item, child, active)).ToArray()
                );
            }
            if (
                node.Map is not { } map
                || shape is Shape.Scalar or Shape.Rules or Shape.ScalarList or Shape.ScalarOrList
            )
                throw new InvalidDataException("Invalid tool policy value.");
            var keys = map.Select(pair => (pair.Key, pair.Value)).ToArray();
            var allowed = shape switch
            {
                Shape.Root => new[] { "version", "defaultAction", "rules" },
                Shape.Rule => ["id", "enabled", "match", "action", "reason", "agent", "session", "externalId", "tool", "node", "args", "path"],
                Shape.Match =>
                [
                    "agent",
                    "session",
                    "externalId",
                    "tool",
                    "targetNode",
                    "args",
                    "path",
                ],
                Shape.Tool => ["source", "server", "name"],
                Shape.Path => ["arg", "allWithin", "anyNotWithin"],
                Shape.Session => ["self", "sameAgent", "relation"],
                Shape.Task => ["owned"],
                Shape.Node => ["current", "provider"],
                Shape.Argument when keys.Any(pair => pair.Key == "task") => ["task"],
                Shape.Argument when keys.Any(pair => pair.Key == "session") => ["session"],
                Shape.Matcher or Shape.Argument => ["equals", "oneOf", "exists"],
                Shape.Args => null,
                _ => throw new InvalidDataException("Invalid policy mapping."),
            };
            if (
                keys.Length > (allowed?.Length ?? 64)
                || allowed is not null
                    && keys.Any(pair => !allowed.Contains(pair.Key, StringComparer.Ordinal))
            )
                throw new InvalidDataException("Unknown or oversized policy mapping.");
            var result = new JsonObject();
            foreach (var pair in keys)
            {
                var child = shape switch
                {
                    Shape.Root when pair.Key == "rules" => Shape.Rules,
                    Shape.Rule when pair.Key == "match" => Shape.Match,
                    Shape.Rule when pair.Key == "args" => Shape.Args,
                    Shape.Rule when pair.Key == "tool" => Shape.Tool,
                    Shape.Rule when pair.Key == "path" => Shape.Path,
                    Shape.Rule when pair.Key == "node" => Shape.Node,
                    Shape.Rule when pair.Key == "session" => Shape.ScalarOrList,
                    Shape.Rule when pair.Key is "agent" or "externalId" => Shape.Matcher,
                    Shape.Node when pair.Key == "provider" => Shape.ScalarOrList,
                    Shape.Match when pair.Key == "args" => Shape.Args,
                    Shape.Match when pair.Key == "tool" => Shape.Tool,
                    Shape.Match when pair.Key == "path" => Shape.Path,
                    Shape.Match => Shape.Matcher,
                    Shape.Args => Shape.Argument,
                    Shape.Tool => Shape.Matcher,
                    Shape.Argument when pair.Key == "session" => Shape.Session,
                    Shape.Argument when pair.Key == "task" => Shape.Task,
                    Shape.Matcher or Shape.Argument when pair.Key == "oneOf" => Shape.ScalarList,
                    Shape.Path when pair.Key == "arg" => Shape.ScalarOrList,
                    Shape.Session when pair.Key == "relation" => Shape.ScalarOrList,
                    _ => Shape.Scalar,
                };
                var value = Convert(pair.Value, child, active);
                if (result.ContainsKey(pair.Key))
                    throw new InvalidDataException("Duplicate YAML policy key.");
                result[pair.Key] = value;
            }
            return result;
        }
        finally
        {
            active.Remove(node);
        }
    }

    internal static object? Scalar(YamlScalarNode node)
    {
        var value = node.Value ?? "";
        var tag = node.Tag.IsEmpty ? "" : node.Tag.Value;
        if (
            tag is "tag:yaml.org,2002:str" or "!"
            || tag.Length == 0 && node.Style is not (ScalarStyle.Plain or ScalarStyle.Any)
        )
            return JsonValue.Create(value);
        var isNull = value is "" or "~" or "null" or "Null" or "NULL";
        var isTrue = value is "true" or "True" or "TRUE";
        var isFalse = value is "false" or "False" or "FALSE";
        if (tag == "tag:yaml.org,2002:null")
            return isNull ? null : throw new InvalidDataException("Invalid YAML null.");
        if (tag == "tag:yaml.org,2002:bool")
            return isTrue || isFalse
                ? JsonValue.Create(isTrue)
                : throw new InvalidDataException("Invalid YAML boolean.");
        if (tag == "tag:yaml.org,2002:merge")
            return value == "<<"
                ? JsonValue.Create(value)
                : throw new InvalidDataException("Invalid YAML merge scalar.");
        if (tag.Length > 0 && tag is not ("tag:yaml.org,2002:int" or "tag:yaml.org,2002:float"))
            throw new InvalidDataException("Unsupported YAML scalar type.");
        if (tag.Length == 0)
        {
            if (isNull)
                return null;
            if (isTrue || isFalse)
                return JsonValue.Create(isTrue);
        }
        var numeric = value.Replace("_", "", StringComparison.Ordinal);
        var baseInteger = Regex.IsMatch(
            value,
            @"^[+-]?0x[0-9a-fA-F_]*[0-9a-fA-F]$|^[+-]?0o[0-7_]*[0-7]$|^[+-]?0b[01_]*[01]$",
            RegexOptions.CultureInvariant
        );
        var decimalInteger =
            !value.EndsWith('_')
            && Regex.IsMatch(value, @"^[+-]?[0-9][0-9_]*$", RegexOptions.CultureInvariant)
            && !value.TrimStart('+', '-').StartsWith("0_", StringComparison.Ordinal);
        object Number(double number) =>
            double.IsFinite(number)
                ? JsonValue.Create(number)!
                : new ToolAuthorizationYamlGraph.NonfiniteScalar(number);
        if (tag != "tag:yaml.org,2002:float" && baseInteger)
        {
            var sign = numeric.StartsWith('-') ? -1 : 1;
            var unsigned = numeric.TrimStart('+', '-');
            var radix =
                unsigned[1] == 'x' ? 16
                : unsigned[1] == 'o' ? 8
                : 2;
            double number = 0;
            foreach (var ch in unsigned[2..])
                number =
                    number * radix
                    + (ch is >= '0' and <= '9' ? ch - '0' : char.ToLowerInvariant(ch) - 'a' + 10);
            return Number(sign * number);
        }
        if (tag == "tag:yaml.org,2002:int" && !decimalInteger)
            throw new InvalidDataException("Invalid YAML integer.");
        var floatPattern =
            @"^(?:[+-]?[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9_]+(?:[eE][+-]?[0-9]+)?|[+-]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$";
        if (
            decimalInteger
            || !value.EndsWith('_')
                && Regex.IsMatch(value, floatPattern, RegexOptions.CultureInvariant)
        )
        {
            if (numeric.ToLowerInvariant() is ".inf" or "+.inf" or "-.inf" or ".nan")
                return Number(
                    numeric.ToLowerInvariant() == "-.inf" ? double.NegativeInfinity
                    : numeric.ToLowerInvariant() == ".nan" ? double.NaN
                    : double.PositiveInfinity
                );
            return Number(
                double.TryParse(
                    numeric,
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out var number
                )
                    ? number
                    : double.NaN
            );
        }
        if (tag.Length > 0)
            throw new InvalidDataException("Invalid YAML scalar.");
        return JsonValue.Create(value);
    }
}
