using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// One typed parameter of a ctl command. Name is the spelling users see (and the default
// argument key of the target); Arg overrides the target argument key, and a dotted Arg such as
// `model.modelId` sets a field of an object argument.
internal sealed record CtlParameter(
    string Name,
    string Arg,
    string Type,
    string? Items,
    IReadOnlyList<string>? Values,
    string Kind,
    bool Required,
    bool Variadic,
    string? Help,
    // The ingresses offering this parameter; null for every ingress of its command.
    IReadOnlyList<string>? Ingress = null
)
{
    internal bool AvailableTo(string ingress) =>
        Ingress is null || Ingress.Contains(ingress, StringComparer.Ordinal);

    internal bool Positional => Kind == "positional";
    internal bool Rest => Kind == "rest";
    internal bool Flag => Kind == "flag";
    internal string FlagName => CtlRegistry.Kebab(Name);
    internal bool IsBoolean => Type == "boolean";
    internal bool IsArray => Type == "array";
    internal IReadOnlyList<string> Types => Type.Split('|');
}

// Copy one ingress shows instead of the model copy: the command summary and help, and the help
// of named parameters.
internal sealed record CtlCopy(
    string? Summary,
    string? Help,
    IReadOnlyDictionary<string, string> Parameters
);

// A verb alias, for every ingress of its command or only the listed ones.
internal sealed record CtlAlias(string Name, IReadOnlyList<string>? Ingress)
{
    internal bool AvailableTo(string ingress) =>
        Ingress is null || Ingress.Contains(ingress, StringComparer.Ordinal);
}

// A noun/verb command. A command either names the canonical capability it resolves to
// (Source/Name plus Fixed arguments) or a Local operation handled by ctl itself. Ingress lists
// who may run it: the model (`ctl` tool), the user (`/` commands) or external MCP clients.
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
    internal IReadOnlyList<CtlAlias> IngressAliases { get; init; } = [];
    internal IReadOnlyDictionary<string, CtlCopy> Copy { get; init; } =
        new Dictionary<string, CtlCopy>();
    // The user handler and whether it needs the conversation's current Session.
    internal string? UserHandler { get; init; }
    internal string UserSession { get; init; } = "none";

    internal bool Available(string ingress) => Ingress.Contains(ingress, StringComparer.Ordinal);

    // The command as one ingress sees it: its parameters, aliases and copy.
    internal CtlCommand View(string ingress)
    {
        var copy = Copy.GetValueOrDefault(ingress);
        return this with
        {
            Aliases =
            [
                .. Aliases,
                .. IngressAliases.Where(alias => alias.AvailableTo(ingress)).Select(alias => alias.Name),
            ],
            IngressAliases = [],
            Summary = copy?.Summary ?? Summary,
            Help = copy is null ? Help : copy.Help,
            Parameters =
            [
                .. Parameters
                    .Where(parameter => parameter.AvailableTo(ingress))
                    .Select(parameter =>
                        copy?.Parameters.GetValueOrDefault(parameter.Name) is { } help
                            ? parameter with { Help = help }
                            : parameter
                    ),
            ],
        };
    }

    internal CtlParameter? FindFlag(string flag) =>
        Parameters.FirstOrDefault(parameter =>
            parameter.FlagName == flag || parameter.Name == flag
        );
}

internal sealed record CtlNoun(string Name, string Summary)
{
    internal IReadOnlyDictionary<string, string> Copy { get; init; } =
        new Dictionary<string, string>();
}

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

    // A noun's summary for one ingress.
    internal static string NounSummary(CtlNoun noun, string ingress) =>
        noun.Copy.GetValueOrDefault(ingress) ?? noun.Summary;

    // The command a noun and verb name for one ingress, as that ingress sees it; null when
    // there is none or the ingress may not run it.
    internal static CtlCommand? Find(string noun, string verb, string ingress = Ingress) =>
        Commands
            .Where(command => command.Noun == noun && command.Available(ingress))
            .Select(command => command.View(ingress))
            .FirstOrDefault(command => command.Verb == verb || command.Aliases.Contains(verb));

    // A noun's commands one ingress may run, as it sees them.
    internal static IEnumerable<CtlCommand> ForNoun(string noun, string ingress = Ingress) =>
        Commands
            .Where(command => command.Noun == noun && command.Available(ingress))
            .Select(command => command.View(ingress));

    // Model commands resolving to one canonical builtin, for discovery hints.
    internal static IEnumerable<CtlCommand> ForTarget(string source, string name) =>
        Commands
            .Where(command =>
                command.Source == source && command.Name == name && command.Available(Ingress)
            )
            .Select(command => command.View(Ingress));

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
            nouns.Add(
                new(name, Required(node?["summary"], "noun summary"))
                {
                    Copy = IngressMap(node?["copy"], path: name)
                        .ToDictionary(pair => pair.Key, pair => Required(pair.Value, "noun copy")),
                }
            );
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
            if (local is not (null or "tool-search" or "tool-call" or "exec-result"))
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
                        SessionWait.Text(item?["help"]),
                        IngressList(item?["ingress"], path)
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
            var ingress = IngressList(entry["ingress"], path) ?? [];
            var aliases = new List<string>();
            var ingressAliases = new List<CtlAlias>();
            foreach (var alias in entry["aliases"] as JsonArray ?? [])
                if (alias is JsonObject scoped)
                    ingressAliases.Add(
                        new(Required(scoped["name"], "alias"), IngressList(scoped["ingress"], path))
                    );
                else
                    aliases.Add(Required(alias, "alias"));
            var user = entry["user"] as JsonObject;
            if (ingress.Contains("user") != user is not null)
                throw new InvalidDataException("ctl user ingress needs a user handler: " + path);
            var copy = new Dictionary<string, CtlCopy>();
            foreach (var (key, value) in IngressMap(entry["copy"], path))
                copy[key] = new(
                    SessionWait.Text(value?["summary"]),
                    SessionWait.Text(value?["help"]),
                    (value?["params"] as JsonObject ?? [])
                        .ToDictionary(pair => pair.Key, pair => Required(pair.Value, "parameter copy"))
                );
            commands.Add(
                new(
                    path,
                    words[0],
                    words[1],
                    aliases,
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
                {
                    IngressAliases = ingressAliases,
                    Copy = copy,
                    UserHandler = user is null ? null : Required(user["handler"], "user handler"),
                    UserSession = SessionWait.Text(user?["session"]) is { } session
                        ? session is "required" or "optional" or "none"
                            ? session
                            : throw new InvalidDataException("ctl user session is invalid: " + path)
                        : "none",
                }
            );
        }
        return (nouns, commands);
    }

    private static IReadOnlyList<string>? IngressList(JsonNode? node, string path)
    {
        if (node is null)
            return null;
        var list = (node as JsonArray ?? throw new InvalidDataException("ctl ingress must be a list: " + path))
            .Select(value => Required(value, "ingress"))
            .ToArray();
        if (list.Any(value => value is not ("model" or "user" or "external")))
            throw new InvalidDataException("ctl ingress is invalid: " + path);
        return list;
    }

    private static IEnumerable<KeyValuePair<string, JsonNode?>> IngressMap(JsonNode? node, string path)
    {
        foreach (var pair in node as JsonObject ?? [])
        {
            if (pair.Key is not ("model" or "user" or "external"))
                throw new InvalidDataException("ctl copy ingress is invalid: " + path);
            yield return pair;
        }
    }

    private static string Required(JsonNode? node, string what) =>
        SessionWait.Text(node) is { Length: > 0 } text
            ? text
            : throw new InvalidDataException("ctl registry requires " + what + ".");
}
