using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal abstract record CtlInvocation;

internal sealed record CtlDescription(
    string Source,
    string Name,
    JsonObject Args,
    string? Server,
    string? Node
);

// Help for the overview (both null), a noun, or one command.
internal sealed record CtlHelpRequest(string? Noun, string? Verb) : CtlInvocation;

// A command that could not be parsed. Command or Noun select the usage shown with it. Unknown
// is the noun or `noun verb` that names no command; suggestions are chosen when the error is
// presented, from the commands the caller may see.
internal sealed record CtlError(
    string Message,
    CtlCommand? Command = null,
    string? Noun = null,
    string? Unknown = null
) : CtlInvocation;

internal sealed record CtlSearch(CtlCommand Command, JsonObject Args) : CtlInvocation;

// `tool call`: a descriptor in the former unified-call shape (toolId/source/name/server/nodeId/args).
internal sealed record CtlCall(CtlCommand Command, JsonObject Descriptor) : CtlInvocation;

// A command resolving to one canonical capability with normalized arguments.
internal sealed record CtlTarget(CtlCommand Command, string Source, string Name, JsonObject Args)
    : CtlInvocation;

internal static partial class CtlParser
{
    [GeneratedRegex("^[A-Za-z_][A-Za-z0-9_-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex ValueName();

    // Parses the arguments of one ctl call. Never throws for a malformed command: errors are
    // returned so the caller can present them with the usage the caller may see.
    internal static CtlInvocation Parse(JsonObject args, string ingress = CtlRegistry.Ingress)
    {
        try
        {
            return ParseCore(args, ingress);
        }
        catch (CtlUsageException error)
        {
            return new CtlError(error.Message, error.Command, error.Noun, error.Unknown);
        }
        catch (InvalidDataException error)
        {
            return new CtlError(error.Message);
        }
    }

    // The canonical capability a ctl call stands for, when it names one. Display and batch
    // rules use this; dispatch resolves through the registry.
    internal static CtlDescription? Describe(JsonObject args) =>
        Parse(args) switch
        {
            CtlTarget target => new(target.Source, target.Name, target.Args, null, null),
            CtlCall call => DescribeCall(call.Descriptor),
            _ => null,
        };

    // Whether a ctl call is an attempt to select a Node: `node select`, or `tool call` naming
    // builtin `node` with action select. Judged from the command words, so a call whose values,
    // envelope or arguments are invalid still counts. When `tool call builtin:node` arguments
    // can't be read, the call counts as a selection attempt.
    internal static bool SelectsNode(JsonObject args)
    {
        switch (Parse(args))
        {
            case CtlTarget target:
                return target is { Source: "builtin", Name: "node" } && IsSelect(target.Args);
            case CtlCall call:
                return DescribeCall(call.Descriptor) is { Source: "builtin", Name: "node" } described
                    && IsSelect(described.Args);
            case CtlError { Command.Path: "node select" }:
                return true;
            case CtlError:
                break;
            default:
                return false;
        }
        if (SessionWait.Text(args["command"]) is not { } command)
            return false;
        var words = Words(command);
        if (words.Count > 0 && words[0] == "ctl")
            words.RemoveAt(0);
        if (words.Count < 2)
            return false;
        if (words[0] == "node" && words[1] == "select")
            return true;
        if (words[0] != "tool" || words[1] != "call")
            return false;
        string? toolId = null, source = null, name = null, argsText = null;
        for (var index = 2; index < words.Count; index++)
        {
            var word = words[index];
            if (!word.StartsWith("--", StringComparison.Ordinal))
            {
                toolId ??= word;
                continue;
            }
            var equals = word.IndexOf('=');
            var flag = equals < 0 ? word[2..] : word[2..equals];
            var value =
                equals >= 0 ? word[(equals + 1)..]
                : index + 1 < words.Count ? words[++index]
                : null;
            switch (flag)
            {
                case "tool-id" or "toolId":
                    toolId = value;
                    break;
                case "source":
                    source = value;
                    break;
                case "name":
                    name = value;
                    break;
                case "args":
                    argsText = value;
                    break;
            }
        }
        var names =
            toolId is not null ? toolId.Trim() == "builtin:node"
            : source?.Trim() == "builtin" && name == "node";
        if (!names)
            return false;
        if (argsText is null)
            return false;
        JsonNode? toolArgs = null;
        try
        {
            if (argsText.StartsWith('@') && !argsText.StartsWith("@@", StringComparison.Ordinal))
            {
                var values =
                    args["values"] as JsonObject
                    ?? (
                        SessionWait.Text(args["valuesJson"]) is { } json
                            ? JsonNode.Parse(json) as JsonObject
                            : null
                    );
                toolArgs = values?[argsText[1..]];
            }
            else
                toolArgs = JsonNode.Parse(argsText);
        }
        catch (System.Text.Json.JsonException) { }
        return toolArgs is not JsonObject known || IsSelect(known);
    }

    private static bool IsSelect(JsonObject args) =>
        SessionWait.Text(args["action"])?.Trim().Equals("select", StringComparison.OrdinalIgnoreCase)
        == true;

    // Command words for intent checks: lexed when possible, otherwise split on whitespace.
    private static List<string> Words(string command)
    {
        try
        {
            var lexer = new CtlLexer(command);
            var words = new List<string>();
            while (lexer.Next() is { } token)
                words.Add(token.Text);
            return words;
        }
        catch (InvalidDataException)
        {
            return command.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).ToList();
        }
    }

    // A unified-call descriptor (toolId, or source/name/server/nodeId, plus args).
    internal static CtlDescription? DescribeCall(JsonObject descriptor)
    {
        var source = SessionWait.Text(descriptor["source"])?.Trim();
        var name = SessionWait.Text(descriptor["name"]);
        var server = SessionWait.Text(descriptor["server"]);
        var node = SessionWait.Text(descriptor["nodeId"]);
        if (SessionWait.Text(descriptor["toolId"]) is { Length: > 0 } id)
        {
            var colon = id.IndexOf(':');
            if (colon <= 0)
                return null;
            source = id[..colon];
            var rest = id[(colon + 1)..];
            var slash =
                source == "builtin" ? -1
                : source == "mcp" ? rest.IndexOf('/')
                : rest.LastIndexOf('/');
            name = rest[(slash + 1)..].Trim();
            if (slash > 0)
            {
                if (source == "mcp")
                    server = rest[..slash];
                else
                    node = rest[..slash];
            }
        }
        if (source is not ("builtin" or "node" or "mcp") || string.IsNullOrEmpty(name))
            return null;
        JsonObject args;
        try
        {
            args = ToolRegistry.ObjectArg(descriptor, "args", "argsJson") ?? new JsonObject();
        }
        catch (Exception error)
            when (error is InvalidDataException or System.Text.Json.JsonException)
        {
            args = new JsonObject();
        }
        return new(source, name, args, server, node);
    }

    private sealed class CtlUsageException(
        string message,
        CtlCommand? command = null,
        string? noun = null,
        string? unknown = null
    ) : Exception(message)
    {
        internal CtlCommand? Command => command;
        internal string? Noun => noun;
        internal string? Unknown => unknown;
    }

    private sealed class Values(JsonObject? values)
    {
        private readonly HashSet<string> used = new(StringComparer.Ordinal);

        // The bound value of an exact `@name` token, or null for literal text.
        internal bool TryBind(string text, out JsonNode? value, out string literal)
        {
            value = null;
            literal = text;
            if (!text.StartsWith('@'))
                return false;
            if (text.StartsWith("@@", StringComparison.Ordinal))
            {
                literal = text[1..];
                return false;
            }
            var name = text[1..];
            if (!ValueName().IsMatch(name))
                throw new InvalidDataException(
                    $"`{text}` is not a valid @name reference. Names use letters, digits, `_` and `-`; write @@ for a literal leading @."
                );
            if (values is null || !values.TryGetPropertyValue(name, out var bound))
                throw new InvalidDataException($"`{text}` has no value: supply values.{name}.");
            used.Add(name);
            value = bound;
            return true;
        }

        internal void RequireAllUsed()
        {
            var unused = (values ?? []).Select(pair => pair.Key).Where(key => !used.Contains(key));
            if (unused.Any())
                throw new InvalidDataException(
                    "Unused values: "
                        + string.Join(", ", unused)
                        + ". Every values entry must be referenced as @name."
                );
        }
    }

    private static CtlInvocation ParseCore(JsonObject args, string ingress)
    {
        foreach (var key in args.Select(pair => pair.Key))
            if (key is not ("command" or "values" or "valuesJson"))
                throw new InvalidDataException(
                    "Unsupported ctl argument `" + key + "`; use command, values or valuesJson."
                );
        var command =
            SessionWait.Text(args["command"])
            ?? throw new InvalidDataException("command must be a string.");
        JsonObject? values = null;
        if (args.ContainsKey("values") && args.ContainsKey("valuesJson"))
            throw new InvalidDataException("Supply either values or valuesJson, not both.");
        if (args.ContainsKey("values"))
            values =
                args["values"] as JsonObject
                ?? (
                    args["values"] is null
                        ? null
                        : throw new InvalidDataException("values must be an object.")
                );
        else if (args.ContainsKey("valuesJson"))
        {
            JsonNode? parsed;
            try
            {
                parsed = JsonNode.Parse(
                    SessionWait.Text(args["valuesJson"])
                        ?? throw new InvalidDataException("valuesJson must be a string.")
                );
            }
            catch (System.Text.Json.JsonException error)
            {
                throw new InvalidDataException("valuesJson is not valid JSON: " + error.Message);
            }
            values =
                parsed as JsonObject
                ?? throw new InvalidDataException("valuesJson must encode a JSON object.");
        }
        var bound = new Values(values);
        var lexer = new CtlLexer(command);
        var first = lexer.Next();
        if (first is { Quoted: false, Text: "ctl" })
            first = lexer.Next();
        if (first is null)
            return Help(lexer, bound, null, null);
        if (first is { Quoted: false, Text: "help" or "--help" })
        {
            var noun = lexer.Next()?.Text;
            var verb = lexer.Next()?.Text;
            if (lexer.Next() is not null)
                throw new CtlUsageException("help takes at most a noun and a verb.");
            return Help(lexer, bound, noun, verb);
        }
        var nounName = first.Text;
        if (CtlRegistry.Noun(nounName) is null || !Visible(nounName, ingress))
            throw new CtlUsageException(Unknown(nounName), unknown: nounName);

        var second = lexer.Next();
        if (second is null || second is { Quoted: false, Text: "--help" })
        {
            if (second is not null && !lexer.AtEnd)
                throw new CtlUsageException("Unexpected text after --help.", noun: nounName);
            return Help(lexer, bound, nounName, null);
        }
        var found = CtlRegistry.Find(nounName, second.Text);
        if (found is null || !found.Available(ingress))
            throw new CtlUsageException(
                Unknown(nounName + " " + second.Text),
                noun: nounName,
                unknown: nounName + " " + second.Text
            );
        try
        {
            return Arguments(found, lexer, bound);
        }
        catch (CtlUsageException)
        {
            throw;
        }
        catch (InvalidDataException error)
        {
            throw new CtlUsageException(error.Message, found);
        }
    }

    private static CtlHelpRequest Help(CtlLexer lexer, Values bound, string? noun, string? verb)
    {
        if (!lexer.AtEnd)
            throw new CtlUsageException("help takes at most a noun and a verb.");
        bound.RequireAllUsed();
        return new(noun, verb);
    }

    private static bool Visible(string noun, string ingress) =>
        CtlRegistry.ForNoun(noun).Any(command => command.Available(ingress));

    internal static string Unknown(string typed) => $"Unknown command `{typed}`.";

    private static CtlInvocation Arguments(CtlCommand command, CtlLexer lexer, Values bound)
    {
        var assigned = new JsonObject();
        var positionals = command.Parameters.Where(parameter => parameter.Positional).ToList();
        var rest = command.Parameters.FirstOrDefault(parameter => parameter.Rest);
        var nextPositional = 0;
        var flagsEnded = false;
        var help = false;
        while (!lexer.AtEnd)
        {
            // A positional already given as an option is filled; use the next one.
            while (
                nextPositional < positionals.Count
                && !positionals[nextPositional].Variadic
                && assigned.ContainsKey(positionals[nextPositional].Name)
            )
                nextPositional++;
            if (
                rest is not null
                && nextPositional >= positionals.Count
                && (flagsEnded || !lexer.PeekStartsWith("--"))
            )
            {
                Assign(assigned, rest, RestValue(lexer.Remainder()), bound);
                break;
            }
            var token = lexer.Next()!;
            if (!flagsEnded && !token.Quoted && token.Text == "--")
            {
                flagsEnded = true;
                continue;
            }
            if (!flagsEnded && !token.Quoted && token.Text == "--help")
            {
                help = true;
                continue;
            }
            if (!flagsEnded && token.IsOption(out var flag, out var inline))
            {
                var parameter = command.FindFlag(flag);
                var negated = false;
                if (
                    parameter is null
                    && flag.StartsWith("no-", StringComparison.Ordinal)
                    && command.FindFlag(flag[3..]) is { IsBoolean: true } negatable
                )
                {
                    parameter = negatable;
                    negated = true;
                }
                if (parameter is null)
                    throw new InvalidDataException($"Unknown option `--{flag}`.");
                if (parameter.IsBoolean)
                {
                    if (negated)
                    {
                        if (inline is not null)
                            throw new InvalidDataException($"`--no-{parameter.FlagName}` takes no value.");
                        Assign(assigned, parameter, Literal(JsonValue.Create(false)), bound);
                    }
                    else
                        Assign(
                            assigned,
                            parameter,
                            inline is null ? Literal(JsonValue.Create(true)) : Text(inline),
                            bound
                        );
                    continue;
                }
                if (inline is null)
                {
                    var value =
                        lexer.Next()
                        ?? throw new InvalidDataException($"`--{parameter.FlagName}` needs a value.");
                    Assign(assigned, parameter, Text(value.Text), bound);
                }
                else
                    Assign(assigned, parameter, Text(inline), bound);
                continue;
            }
            if (nextPositional >= positionals.Count)
                throw new InvalidDataException($"Unexpected argument `{token.Text}`.");
            var slot = positionals[nextPositional];
            if (slot.Variadic)
            {
                AppendWord(assigned, slot, token.Text, bound);
                continue;
            }
            Assign(assigned, slot, Text(token.Text), bound);
            nextPositional++;
        }
        if (help)
        {
            bound.RequireAllUsed();
            return new CtlHelpRequest(command.Noun, command.Verb);
        }
        bound.RequireAllUsed();
        foreach (var parameter in command.Parameters)
            if (parameter.Required && !assigned.ContainsKey(parameter.Name))
                throw new InvalidDataException(
                    parameter.Flag
                        ? $"Missing required option `--{parameter.FlagName}`."
                        : $"Missing required argument <{parameter.Name}>."
                );
        var mapped = command.Fixed is { } fixedArgs ? (JsonObject)fixedArgs.DeepClone() : [];
        foreach (var parameter in command.Parameters)
            if (assigned.TryGetPropertyValue(parameter.Name, out var value))
                SetPath(mapped, parameter.Arg, value?.DeepClone());
        return command.Local switch
        {
            "tool-search" => new CtlSearch(command, mapped),
            "tool-call" => new CtlCall(command, Descriptor(mapped)),
            _ => new CtlTarget(command, command.Source!, command.Name!, mapped),
        };
    }

    // Sets a target argument; a dotted path such as `model.modelId` builds nested objects.
    private static void SetPath(JsonObject target, string path, JsonNode? value)
    {
        var parts = path.Split('.');
        for (var index = 0; index < parts.Length - 1; index++)
        {
            if (target[parts[index]] is not JsonObject inner)
                target[parts[index]] = inner = new JsonObject();
            target = inner;
        }
        target[parts[^1]] = value;
    }

    private static JsonObject Descriptor(JsonObject mapped)
    {
        if (
            SessionWait.Text(mapped["toolId"]) is null
            && (mapped["source"] is null || mapped["name"] is null)
        )
            throw new InvalidDataException("Supply a toolId, or --source and --name.");
        if (!mapped.ContainsKey("args"))
            mapped["args"] = new JsonObject();
        return mapped;
    }

    // A command-line token (subject to @name binding), literal text, or a bound value.
    private sealed record Input(string? Token, JsonNode? Node, bool Bound);

    private static Input Text(string token) => new(token, null, false);

    private static Input Literal(JsonNode? node) => new(null, node, true);

    // Rest text is taken as written. Only text that is exactly one @name binds; a leading @@
    // stands for a literal @.
    private static Input RestValue(string raw)
    {
        var trimmed = raw.TrimEnd();
        if (trimmed.Length > 1 && trimmed[0] == '@' && ValueName().IsMatch(trimmed[1..]))
            return Text(trimmed);
        return new(
            null,
            JsonValue.Create(raw.StartsWith("@@", StringComparison.Ordinal) ? raw[1..] : raw),
            false
        );
    }

    private static void AppendWord(JsonObject assigned, CtlParameter parameter, string text, Values bound)
    {
        if (bound.TryBind(text, out var node, out var literal))
        {
            if (assigned.ContainsKey(parameter.Name))
                throw new InvalidDataException($"<{parameter.Name}> is bound with @name and can't take more words.");
            assigned[parameter.Name] = Convert(parameter, node, bound: true, element: false);
            return;
        }
        assigned[parameter.Name] = assigned[parameter.Name] is JsonValue previous
            ? previous.GetValue<string>() + " " + literal
            : literal;
    }

    private static void Assign(
        JsonObject assigned,
        CtlParameter parameter,
        Input input,
        Values bound
    )
    {
        JsonNode? value = input.Node;
        var isBound = input.Bound;
        if (input.Token is string token)
        {
            isBound = bound.TryBind(token, out var node, out var literal);
            value = isBound ? node : JsonValue.Create(literal);
        }
        if (parameter.IsArray)
        {
            var list = assigned[parameter.Name] as JsonArray ?? [];
            if (isBound || value is JsonValue text && text.TryGetValue<string>(out var json) && json.TrimStart().StartsWith('['))
            {
                var array =
                    isBound
                        ? value as JsonArray
                            ?? throw new InvalidDataException($"--{parameter.FlagName} expects an array.")
                        : ParseJson(value!.GetValue<string>(), parameter) as JsonArray
                            ?? throw new InvalidDataException($"--{parameter.FlagName} expects a JSON array.");
                foreach (var item in array)
                    list.Add(Convert(parameter, item, bound: true, element: true));
            }
            else
                list.Add(Convert(parameter, value, bound: false, element: true));
            assigned[parameter.Name] = list;
            return;
        }
        if (assigned.ContainsKey(parameter.Name))
            throw new InvalidDataException(
                (parameter.Flag ? "--" + parameter.FlagName : "<" + parameter.Name + ">")
                    + " is given more than once."
            );
        assigned[parameter.Name] = Convert(parameter, value, isBound, element: false);
    }

    private static JsonNode? ParseJson(string text, CtlParameter parameter)
    {
        try
        {
            return JsonNode.Parse(text);
        }
        catch (System.Text.Json.JsonException)
        {
            throw new InvalidDataException(Label(parameter) + " expects JSON, given `" + Clip(text) + "`.");
        }
    }

    private static string Label(CtlParameter parameter) =>
        parameter.Positional || parameter.Rest ? "<" + parameter.Name + ">" : "--" + parameter.FlagName;

    private static string Clip(string text) => text.Length <= 60 ? text : text[..57] + "...";

    // Converts a literal token or a bound value to the parameter's type. Bound values are
    // checked, never coerced; literal text is parsed.
    private static JsonNode? Convert(CtlParameter parameter, JsonNode? value, bool bound, bool element)
    {
        var types = element ? [parameter.Items!] : parameter.Types;
        var values = parameter.Values;
        var label = Label(parameter);
        if (bound)
        {
            foreach (var type in types)
                if (Matches(type, value, values))
                    return value?.DeepClone();
            throw new InvalidDataException(
                $"{label} expects {Describe(types, values)}, but the bound value is {Kind(value)}."
            );
        }
        var text = value!.GetValue<string>();
        foreach (var type in types.OrderBy(type => type == "string" ? 1 : 0))
        {
            switch (type)
            {
                case "string":
                    return JsonValue.Create(text);
                case "enum":
                    if (values!.Contains(text, StringComparer.Ordinal))
                        return JsonValue.Create(text);
                    break;
                case "integer":
                    if (long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var integer))
                        return JsonValue.Create(integer);
                    break;
                case "number":
                    if (
                        Regex.IsMatch(text, @"^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$")
                        && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
                        && double.IsFinite(number)
                    )
                        return number == Math.Truncate(number) && Math.Abs(number) < 1e15
                            ? JsonValue.Create((long)number)
                            : JsonValue.Create(number);
                    break;
                case "boolean":
                    if (text is "true" or "false")
                        return JsonValue.Create(text == "true");
                    break;
                case "object":
                    if (ParseJson(text, parameter) is JsonObject obj)
                        return obj;
                    break;
                case "json":
                    try
                    {
                        return JsonNode.Parse(text);
                    }
                    catch (System.Text.Json.JsonException)
                    {
                        return JsonValue.Create(text);
                    }
            }
        }
        throw new InvalidDataException($"{label} expects {Describe(types, values)}, given `{Clip(text)}`.");
    }

    private static bool Matches(string type, JsonNode? value, IReadOnlyList<string>? values) =>
        type switch
        {
            "null" => value is null,
            "json" => true,
            "string" => value is JsonValue text && text.TryGetValue<string>(out _),
            "enum" => SessionWait.Text(value) is string member && values!.Contains(member),
            "boolean" => value is JsonValue flag && flag.TryGetValue<bool>(out _),
            "number" => value?.GetValueKind() == System.Text.Json.JsonValueKind.Number,
            "integer" => value?.GetValueKind() == System.Text.Json.JsonValueKind.Number
                && SessionWait.Number(value) is double number
                && number == Math.Truncate(number),
            "object" => value is JsonObject,
            "array" => value is JsonArray,
            _ => false,
        };

    private static string Kind(JsonNode? value) =>
        value?.GetValueKind() switch
        {
            null => "null",
            System.Text.Json.JsonValueKind.String => "a string",
            System.Text.Json.JsonValueKind.Number => "a number",
            System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False => "a boolean",
            System.Text.Json.JsonValueKind.Array => "an array",
            System.Text.Json.JsonValueKind.Object => "an object",
            _ => "null",
        };

    internal static string Describe(IReadOnlyList<string> types, IReadOnlyList<string>? values) =>
        string.Join(
            " or ",
            types.Select(type =>
                type switch
                {
                    "enum" => "one of " + string.Join(", ", values!),
                    "integer" => "an integer",
                    "number" => "a number",
                    "boolean" => "true or false",
                    "object" => "a JSON object",
                    "array" => "an array",
                    "json" => "a JSON value",
                    "null" => "null",
                    _ => "text",
                }
            )
        );
}
