using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// One typed parameter of a ctl command. Name is the spelling users see (and the default
// argument key of the target); Arg overrides the target argument key.
internal sealed record CtlParameter(
    string Name,
    string Arg,
    string Type,
    string? Items,
    IReadOnlyList<string>? Values,
    string Kind,
    bool Required,
    bool Variadic,
    string? Help
)
{
    internal bool Positional => Kind == "positional";
    internal bool Rest => Kind == "rest";
    internal bool Flag => Kind == "flag";
    internal string FlagName => CtlRegistry.Kebab(Name);
    internal bool IsBoolean => Type == "boolean";
    internal bool IsArray => Type == "array";
    internal IReadOnlyList<string> Types => Type.Split('|');
}

// A noun/verb command. A command either names the canonical capability it resolves to
// (Source/Name plus Fixed arguments) or a Local operation handled by ctl itself.
internal sealed record CtlCommand(
    string Path,
    string Noun,
    string Verb,
    IReadOnlyList<string> Aliases,
    string Summary,
    string? Help,
    IReadOnlyList<string> Ingress,
    string? Source,
    string? Name,
    JsonObject? Fixed,
    string? Local,
    IReadOnlyList<CtlParameter> Parameters
)
{
    internal bool Available(string ingress) => Ingress.Contains(ingress, StringComparer.Ordinal);

    internal CtlParameter? FindFlag(string flag) =>
        Parameters.FirstOrDefault(parameter =>
            parameter.FlagName == flag || parameter.Name == flag
        );
}

internal sealed record CtlNoun(string Name, string Summary);

// The checked-in command registry. It is the source for ctl commands: it is maintained by hand
// and is not derived from tool schemas at run time.
internal static class CtlRegistry
{
    internal const string Ingress = "model";
    internal static readonly IReadOnlyList<string> ParameterTypes =
    [
        "string",
        "integer",
        "number",
        "boolean",
        "enum",
        "array",
        "object",
        "json",
        "null",
    ];

    private static readonly Lazy<(
        IReadOnlyList<CtlNoun> Nouns,
        IReadOnlyList<CtlCommand> Commands
    )> loaded = new(() => Load(ReadResource()));

    internal static IReadOnlyList<CtlNoun> Nouns => loaded.Value.Nouns;
    internal static IReadOnlyList<CtlCommand> Commands => loaded.Value.Commands;

    private static string ReadResource()
    {
        using var stream =
            typeof(CtlRegistry).Assembly.GetManifestResourceStream(
                "Foxwarm.Tools.Ctl.CtlCommands.json"
            ) ?? throw new InvalidOperationException("The ctl command registry is missing.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    internal static string Kebab(string name) =>
        Regex.Replace(name.Replace('_', '-'), "(?<=[a-z0-9])([A-Z])", "-$1").ToLowerInvariant();

    internal static CtlNoun? Noun(string name) =>
        Nouns.FirstOrDefault(noun => noun.Name == name);

    internal static CtlCommand? Find(string noun, string verb) =>
        Commands.FirstOrDefault(command =>
            command.Noun == noun && (command.Verb == verb || command.Aliases.Contains(verb))
        );

    internal static IEnumerable<CtlCommand> ForNoun(string noun) =>
        Commands.Where(command => command.Noun == noun);

    // Commands resolving to one canonical builtin, for discovery hints.
    internal static IEnumerable<CtlCommand> ForTarget(string source, string name) =>
        Commands.Where(command => command.Source == source && command.Name == name);

    // Validates the registry shape so a malformed entry fails at first use and in tests.
    internal static (IReadOnlyList<CtlNoun>, IReadOnlyList<CtlCommand>) Load(string text)
    {
        var root =
            JsonNode.Parse(text) as JsonObject
            ?? throw new InvalidDataException("ctl registry must be an object.");
        if (SessionWait.Number(root["version"]) != 1)
            throw new InvalidDataException("ctl registry version must be 1.");
        var nouns = new List<CtlNoun>();
        foreach (var node in root["nouns"] as JsonArray ?? [])
        {
            var name = Required(node?["name"], "noun name");
            if (nouns.Any(noun => noun.Name == name))
                throw new InvalidDataException("Duplicate ctl noun: " + name);
            nouns.Add(new(name, Required(node?["summary"], "noun summary")));
        }
        var commands = new List<CtlCommand>();
        foreach (var node in root["commands"] as JsonArray ?? [])
        {
            if (node is not JsonObject entry)
                throw new InvalidDataException("ctl command must be an object.");
            var path = Required(entry["path"], "command path");
            var words = path.Split(' ');
            if (words.Length != 2 || words.Any(word => !Regex.IsMatch(word, "^[a-z][a-z0-9-]*$")))
                throw new InvalidDataException("ctl command path must be `noun verb`: " + path);
            if (!nouns.Any(noun => noun.Name == words[0]))
                throw new InvalidDataException("ctl command has no declared noun: " + path);
            if (commands.Any(command => command.Path == path))
                throw new InvalidDataException("Duplicate ctl command: " + path);
            var target =
                entry["target"] as JsonObject
                ?? throw new InvalidDataException("ctl command requires a target: " + path);
            var local = SessionWait.Text(target["local"]);
            var source = SessionWait.Text(target["source"]);
            var name = SessionWait.Text(target["name"]);
            if (local is null == (source is null || name is null))
                throw new InvalidDataException(
                    "ctl target needs either local or source and name: " + path
                );
            if (source is not (null or "builtin" or "node" or "mcp"))
                throw new InvalidDataException("ctl target source is invalid: " + path);
            if (local is not (null or "tool-search" or "tool-call"))
                throw new InvalidDataException("ctl local target is invalid: " + path);
            var parameters = new List<CtlParameter>();
            foreach (var item in entry["params"] as JsonArray ?? [])
            {
                var parameterName = Required(item?["name"], "parameter name");
                var type = Required(item?["type"], "parameter type");
                if (type.Split('|').Any(part => !ParameterTypes.Contains(part)))
                    throw new InvalidDataException($"ctl parameter type is invalid: {path} {type}");
                var kind = SessionWait.Text(item?["kind"]) ?? "flag";
                if (kind is not ("flag" or "positional" or "rest"))
                    throw new InvalidDataException("ctl parameter kind is invalid: " + path);
                var values = (item?["values"] as JsonArray)
                    ?.Select(value => Required(value, "enum value"))
                    .ToArray();
                var items = SessionWait.Text(item?["items"]);
                if ((type == "enum" || items == "enum") && values is not { Length: > 0 })
                    throw new InvalidDataException("ctl enum parameter needs values: " + path);
                if (type == "array" && items is null)
                    throw new InvalidDataException("ctl array parameter needs items: " + path);
                if (parameters.Any(parameter => parameter.Name == parameterName))
                    throw new InvalidDataException("Duplicate ctl parameter: " + path);
                parameters.Add(
                    new(
                        parameterName,
                        SessionWait.Text(item?["arg"]) ?? parameterName,
                        type,
                        items,
                        values,
                        kind,
                        item?["required"]?.GetValue<bool>() == true,
                        item?["variadic"]?.GetValue<bool>() == true,
                        SessionWait.Text(item?["help"])
                    )
                );
            }
            if (parameters.Count(parameter => parameter.Rest) > 1)
                throw new InvalidDataException("ctl command has more than one rest parameter: " + path);
            if (
                parameters.FindIndex(parameter => parameter.Variadic)
                    is var variadic and >= 0
                && (
                    !parameters[variadic].Positional
                    || parameters.Skip(variadic + 1).Any(parameter => parameter.Positional)
                    || parameters.Any(parameter => parameter.Rest)
                )
            )
                throw new InvalidDataException(
                    "ctl variadic parameter must be the last positional: " + path
                );
            var ingress = (entry["ingress"] as JsonArray ?? [])
                .Select(value => Required(value, "ingress"))
                .ToArray();
            if (ingress.Any(value => value is not ("model" or "user" or "external")))
                throw new InvalidDataException("ctl ingress is invalid: " + path);
            commands.Add(
                new(
                    path,
                    words[0],
                    words[1],
                    (entry["aliases"] as JsonArray ?? [])
                        .Select(value => Required(value, "alias"))
                        .ToArray(),
                    Required(entry["summary"], "summary"),
                    SessionWait.Text(entry["help"]),
                    ingress,
                    source,
                    name,
                    target["fixed"] is JsonObject fixedArgs
                        ? (JsonObject)fixedArgs.DeepClone()
                        : null,
                    local,
                    parameters
                )
            );
        }
        return (nouns, commands);
    }

    private static string Required(JsonNode? node, string what) =>
        SessionWait.Text(node) is { Length: > 0 } text
            ? text
            : throw new InvalidDataException("ctl registry requires " + what + ".");
}
