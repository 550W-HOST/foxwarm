using System.Text;

namespace Foxwarm.Tools;

// Help and usage text. Commands the caller's policy definitely denies are left out; a command
// whose permission depends on its arguments is kept, as in tool discovery.
internal static class CtlHelp
{
    internal const int MaxLength = 16_000;

    internal static string Overview(Func<CtlCommand, bool> visible)
    {
        var builder = new StringBuilder(
            "Foxwarm runtime commands. Write `<noun> <verb> [arguments]`; add --help to a noun or command for its usage.\n\n"
        );
        var nouns = CtlRegistry
            .Nouns.Where(noun => Commands(noun.Name, visible).Any())
            .ToArray();
        var width = nouns.Length == 0 ? 0 : nouns.Max(noun => noun.Name.Length);
        foreach (var noun in nouns)
            builder.Append("  ").Append(noun.Name.PadRight(width + 2)).Append(noun.Summary).Append('\n');
        builder.Append(
            "\nOptions use --name value or --name=value; booleans also take --name and --no-name. Quote arguments containing spaces. Pass long text or JSON as @name and supply it in values; write @@ for a literal leading @. ctl runs one command and is not a shell; use run_script to combine dependent calls."
        );
        return Bound(builder.ToString());
    }

    internal static string? Noun(string noun, Func<CtlCommand, bool> visible)
    {
        var commands = Commands(noun, visible).ToArray();
        if (commands.Length == 0 || CtlRegistry.Noun(noun) is not { } entry)
            return null;
        var builder = new StringBuilder(noun + ": " + entry.Summary + "\n\n");
        foreach (var command in commands)
            builder
                .Append("  ")
                .Append(Synopsis(command, compact: true))
                .Append("\n      ")
                .Append(command.Summary)
                .Append('\n');
        builder.Append($"\nRun `{noun} <verb> --help` for a command's arguments.");
        return Bound(builder.ToString());
    }

    internal static string Command(CtlCommand command)
    {
        var builder = new StringBuilder("Usage: " + Synopsis(command, compact: false) + "\n\n");
        builder.Append(command.Summary).Append('\n');
        if (command.Help is { } help && help != command.Summary)
            builder.Append('\n').Append(help).Append('\n');
        if (command.Parameters.Count > 0)
        {
            builder.Append("\nArguments:\n");
            foreach (var parameter in command.Parameters)
            {
                builder.Append("  ").Append(Term(parameter));
                if (parameter.Required)
                    builder.Append(" (required)");
                builder.Append('\n');
                if (parameter.Help is { } text)
                    builder.Append("      ").Append(text).Append('\n');
            }
        }
        return Bound(builder.ToString().TrimEnd());
    }

    // The text returned for a parse error: the message, suggestions and the usage the caller
    // may see. Suggestions come only from visible commands, like help.
    internal static string Error(CtlError error, Func<CtlCommand, bool> visible)
    {
        var message = error.Message;
        if (error.Unknown is { } typed && Suggestions(typed, visible) is { Length: > 0 } candidates)
            message += " Did you mean " + string.Join(", ", candidates.Select(path => "`" + path + "`")) + "?";
        var usage =
            error.Command is { } command
                ? visible(command)
                    ? Command(command)
                    : null
            : error.Noun is { } noun ? Noun(noun, visible)
            : null;
        return Bound(
            message
                + (usage is null ? "\n\nRun `help` for the available commands." : "\n\n" + usage)
        );
    }

    // Up to three visible nouns (for a one-word command) or commands closest to the typed text.
    internal static string[] Suggestions(string typed, Func<CtlCommand, bool> visible)
    {
        var candidates = typed.Contains(' ')
            ? CtlRegistry
                .Commands.Where(command => command.Available(CtlRegistry.Ingress) && visible(command))
                .Select(command => command.Path)
            : CtlRegistry.Nouns.Where(noun => Commands(noun.Name, visible).Any()).Select(noun => noun.Name);
        return candidates
            .Select(path => (Path: path, Distance: Distance(typed, path)))
            .Where(pair => pair.Distance <= Math.Max(2, typed.Length / 3))
            .OrderBy(pair => pair.Distance)
            .ThenBy(pair => pair.Path, StringComparer.Ordinal)
            .Take(3)
            .Select(pair => pair.Path)
            .ToArray();
    }

    private static int Distance(string left, string right)
    {
        var previous = Enumerable.Range(0, right.Length + 1).ToArray();
        for (var row = 1; row <= left.Length; row++)
        {
            var current = new int[right.Length + 1];
            current[0] = row;
            for (var column = 1; column <= right.Length; column++)
                current[column] = Math.Min(
                    Math.Min(current[column - 1] + 1, previous[column] + 1),
                    previous[column - 1] + (left[row - 1] == right[column - 1] ? 0 : 1)
                );
            previous = current;
        }
        return previous[right.Length];
    }

    // Null when the requested noun or command does not exist for this caller.
    internal static string? Render(CtlHelpRequest request, Func<CtlCommand, bool> visible)
    {
        if (request.Noun is null)
            return Overview(visible);
        if (request.Verb is null)
            return Noun(request.Noun, visible);
        return CtlRegistry.Find(request.Noun, request.Verb) is { } command
            && command.Available(CtlRegistry.Ingress)
            && visible(command)
            ? Command(command)
            : null;
    }

    private static IEnumerable<CtlCommand> Commands(string noun, Func<CtlCommand, bool> visible) =>
        CtlRegistry.ForNoun(noun).Where(command => command.Available(CtlRegistry.Ingress) && visible(command));

    internal static string Synopsis(CtlCommand command, bool compact)
    {
        var parts = new List<string> { command.Path };
        foreach (var parameter in command.Parameters.Where(parameter => !parameter.Flag))
        {
            var term = "<" + parameter.Name + (parameter.Variadic || parameter.Rest ? "..." : "") + ">";
            parts.Add(parameter.Required ? term : "[" + term + "]");
        }
        var flags = command.Parameters.Where(parameter => parameter.Flag).ToArray();
        if (compact)
        {
            parts.AddRange(flags.Where(parameter => parameter.Required).Select(Term));
            if (flags.Any(parameter => !parameter.Required))
                parts.Add("[options]");
        }
        else
            parts.AddRange(
                flags.Select(parameter => parameter.Required ? Term(parameter) : "[" + Term(parameter) + "]")
            );
        return string.Join(' ', parts);
    }

    private static string Term(CtlParameter parameter)
    {
        if (!parameter.Flag)
            return "<" + parameter.Name + (parameter.Variadic || parameter.Rest ? "..." : "") + ">";
        if (parameter.IsBoolean)
            return "--[no-]" + parameter.FlagName;
        return "--"
            + parameter.FlagName
            + " "
            + Placeholder(parameter.IsArray ? parameter.Items! : parameter.Type, parameter.Values)
            + (parameter.IsArray ? " ..." : "");
    }

    private static string Placeholder(string type, IReadOnlyList<string>? values) =>
        string.Join(
            "|",
            type.Split('|')
                .Where(part => part != "null")
                .Select(part =>
                    part switch
                    {
                        "enum" => string.Join('|', values!),
                        "object" => "<json>",
                        "json" => "<json>",
                        "integer" or "number" => "<number>",
                        "boolean" => "true|false",
                        _ => "<text>",
                    }
                )
        );

    private static string Bound(string text) =>
        text.Length <= MaxLength
            ? text
            : text[..(MaxLength - 60)].TrimEnd() + "\n… Help shortened; ask for a single noun or command.";
}
