using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Tools;

// Writes a builtin call as the ctl command that runs it, for hints in tool output. The command
// and its argument spellings come from the registry, and values are quoted so CtlLexer reads
// them back unchanged.
internal static partial class CtlCommandText
{
    [GeneratedRegex(@"^[A-Za-z0-9_./:#%+=,@-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex Plain();

    // `ctl <noun> <verb>` for the command running a builtin, to recognize hints in text.
    internal static string Prefix(string builtin, JsonObject? fixedArgs = null) =>
        "ctl " + Command(builtin, fixedArgs ?? []).Path;

    // One option of the command running a builtin, such as `--preview-length 20000`.
    internal static string Option(string builtin, string arg, JsonNode value)
    {
        var parameter = Command(builtin, []).Parameters.Single(parameter => parameter.Arg == arg);
        return string.Join(' ', Option(parameter, value));
    }

    internal static string For(string builtin, JsonObject args)
    {
        var command = Command(builtin, args);
        var remaining = (JsonObject)args.DeepClone();
        foreach (var key in command.Fixed?.Select(pair => pair.Key) ?? [])
            remaining.Remove(key);
        var words = new List<string> { "ctl", command.Path };
        var flags = new List<string>();
        string? rest = null;
        var positionalOpen = true;
        foreach (var parameter in command.Parameters)
        {
            if (Take(remaining, parameter.Arg) is not { } value)
            {
                if (parameter.Positional)
                    positionalOpen = false;
                continue;
            }
            // Rest text is written raw only when the parser will read it back unchanged: every
            // positional before it given as a word, and no leading whitespace. Otherwise it is
            // an ordinary quoted option.
            if (
                parameter.Rest
                && positionalOpen
                && RestText(value) is { Length: > 0 } text
                && !char.IsWhiteSpace(text[0])
            )
                rest = text;
            else if (parameter.Positional && positionalOpen && Positional(value) is { } word)
                words.Add(word);
            else
            {
                if (parameter.Positional)
                    positionalOpen = false;
                flags.AddRange(Option(parameter, value));
            }
        }
        // Arguments the command has no option for (none for the builtins used in hints, which
        // the registry test checks) are left out rather than failing the tool result.
        words.AddRange(flags);
        if (rest is not null)
            words.Add(rest.StartsWith("--", StringComparison.Ordinal) ? "-- " + rest : rest);
        return string.Join(' ', words);
    }

    private static CtlCommand Command(string builtin, JsonObject args) =>
        CtlRegistry
            .ForTarget("builtin", builtin)
            .FirstOrDefault(command =>
                (command.Fixed ?? []).All(pair => JsonNode.DeepEquals(pair.Value, args[pair.Key]))
            )
        ?? throw new InvalidOperationException("No ctl command runs builtin " + builtin + ".");

    // Removes and returns a (possibly dotted) argument; an emptied parent object is removed too.
    private static JsonNode? Take(JsonObject args, string path)
    {
        var dot = path.IndexOf('.');
        if (dot < 0)
        {
            if (!args.TryGetPropertyValue(path, out var value) || value is null)
                return null;
            args.Remove(path);
            return value;
        }
        var head = path[..dot];
        if (args[head] is not JsonObject inner)
            return null;
        var taken = Take(inner, path[(dot + 1)..]);
        if (inner.Count == 0)
            args.Remove(head);
        return taken;
    }

    private static string? Positional(JsonNode value) =>
        value is JsonValue scalar
        && scalar.TryGetValue<string>(out var text)
        && text.StartsWith("--", StringComparison.Ordinal)
            ? null
            : Word(value);

    private static IEnumerable<string> Option(CtlParameter parameter, JsonNode value)
    {
        var flag = "--" + parameter.FlagName;
        if (parameter.IsBoolean && value is JsonValue boolean && boolean.TryGetValue<bool>(out var on))
            return [on ? flag : "--no-" + parameter.FlagName];
        // Repeated options for scalar items; an empty or structured array is one JSON token, so
        // an explicit `[]` stays distinct from omission.
        if (
            parameter.IsArray
            && value is JsonArray { Count: > 0 } items
            && items.All(item =>
                item is JsonValue scalar
                && !(scalar.TryGetValue<string>(out var text) && text.TrimStart().StartsWith('['))
            )
        )
            return items.SelectMany(item => new[] { flag, Word(item!) });
        return [flag, Word(value)];
    }

    private static string Word(JsonNode value)
    {
        if (value is JsonValue scalar && scalar.TryGetValue<string>(out var text))
            return Quote(text.StartsWith('@') ? "@" + text : text);
        if (value is JsonValue number && number.GetValueKind() == System.Text.Json.JsonValueKind.Number)
            return number.ToJsonString();
        return Quote(value.ToJsonString());
    }

    private static string RestText(JsonNode value) =>
        value is JsonValue scalar && scalar.TryGetValue<string>(out var text)
            ? text.StartsWith('@') ? "@" + text : text
            : value.ToJsonString();

    // A literal word: quoted when needed, with a leading @ doubled so it doesn't bind.
    internal static string Literal(string text) => Quote(text.StartsWith('@') ? "@" + text : text);

    internal static string Quote(string text) =>
        text.Length > 0 && Plain().IsMatch(text) ? text : "'" + text.Replace("'", "'\\''") + "'";
}
