using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Tools;

/// <summary>
/// Environment variables an exec receives from stored secrets. Main validates the requested
/// mapping and resolves the values just before launch; the Node that starts the command applies
/// them to the process environment only, never to its script, records or logs.
/// </summary>
internal static partial class ExecSecretEnvironment
{
    internal const int MaxVariables = 32;

    internal static string Unsupported(string node) =>
        $"Node `{node}` can't pass stored secrets to commands. Run the command on master or on a Node that supports secretEnv.";

    [GeneratedRegex("^[A-Za-z_][A-Za-z0-9_]{0,127}$", RegexOptions.CultureInvariant)]
    private static partial Regex NamePattern();

    // Variables the exec launcher sets itself.
    internal static bool Reserved(string name) =>
        name.Equals("fw_agentdir", StringComparison.OrdinalIgnoreCase)
        || name.Equals("fw_tmp", StringComparison.OrdinalIgnoreCase)
        || name.Equals("TERM", StringComparison.OrdinalIgnoreCase)
        || name.Equals("PWD", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("FOXWARM_", StringComparison.OrdinalIgnoreCase);

    internal static void RequireName(string name)
    {
        if (!NamePattern().IsMatch(name))
            throw new InvalidDataException(
                $"`{name}` is not a valid environment variable name for secretEnv."
            );
        if (Reserved(name))
            throw new InvalidDataException(
                $"`{name}` is set by Foxwarm and cannot come from a secret."
            );
    }

    /// <summary>
    /// Validates a mapping of variable names to string values (secret names in a call, secret
    /// values in a launch request). Names differing only in case are refused, so the mapping
    /// means the same on every platform.
    /// </summary>
    internal static IReadOnlyDictionary<string, string> Parse(JsonNode? node, string label)
    {
        if (node is not JsonObject mapping || mapping.Count is < 1 or > MaxVariables)
            throw new InvalidDataException(
                $"{label} must map 1-{MaxVariables} environment variable names to text."
            );
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, value) in mapping)
        {
            RequireName(name);
            if (!seen.Add(name))
                throw new InvalidDataException($"{label} names `{name}` more than once.");
            if (value is not JsonValue text || !text.TryGetValue<string>(out var content))
                throw new InvalidDataException($"{label}.{name} must be text.");
            result[name] = content;
        }
        return result;
    }

    /// <summary>Adds the variables to a launch environment, replacing inherited values.</summary>
    internal static void Apply(
        IDictionary<string, string?> environment,
        IReadOnlyDictionary<string, string> values
    )
    {
        // ProcessStartInfo compares names the way the platform does.
        foreach (var (name, value) in values)
            environment[name] = value;
    }
}
