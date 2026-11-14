using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Channels;

// The user command catalog: `/` heads, help, WebUI autocomplete rows and Telegram commands,
// generated from the ctl registry's user ingress. Heads are `/help`, the shortcuts and every
// noun with a user command.
internal static class UserCommands
{
    internal const string Ingress = "user";

    private static readonly Lazy<string[]> heads = new(() =>
        [
            "/help",
            .. CtlRegistry.Shortcuts.Select(shortcut => "/" + shortcut.Name),
            .. Nouns().Select(noun => "/" + noun.Name),
        ]
    );

    private static IEnumerable<CtlNoun> Nouns() =>
        CtlRegistry.Nouns.Where(noun => CtlRegistry.ForNoun(noun.Name, Ingress).Any());

    internal static IReadOnlyList<string> Heads => heads.Value;

    // A complete, case-sensitive command head.
    internal static bool IsHead(string head) => heads.Value.Contains(head, StringComparer.Ordinal);

    internal static JsonObject? Find(string name) =>
        WebUiCommands().OfType<JsonObject>().FirstOrDefault(row => row["name"]!.GetValue<string>() == name);

    internal static string Help() => CtlHelp.Overview(_ => true, Ingress);

    internal static JsonArray WebUiCommands()
    {
        var rows = new List<JsonObject>
        {
            Row(
                "/help",
                "Show commands, a noun's commands or one command's arguments.",
                "/help [noun] [verb]",
                false,
                Array(
                    Nouns()
                        .Select(noun =>
                            Literal(
                                noun.Name,
                                CtlRegistry.NounSummary(noun, Ingress),
                                null,
                                Array(
                                    CtlRegistry
                                        .ForNoun(noun.Name, Ingress)
                                        .Select(command => Literal(command.Verb, command.Summary, null, null))
                                )
                            )
                        )
                )
            ),
        };
        foreach (var shortcut in CtlRegistry.Shortcuts)
        {
            var command = CtlRegistry.Shortcut(shortcut.Name)!;
            rows.Add(
                Row(
                    "/" + shortcut.Name,
                    command.Summary,
                    CtlHelp.Synopsis(command, compact: false, Ingress),
                    command.UserSession == "required",
                    Tree(command)
                )
            );
        }
        foreach (var noun in Nouns())
            rows.Add(
                Row(
                    "/" + noun.Name,
                    CtlRegistry.NounSummary(noun, Ingress),
                    null,
                    false,
                    Array(
                        CtlRegistry
                            .ForNoun(noun.Name, Ingress)
                            .Select(command =>
                                Literal(
                                    command.Verb,
                                    command.Summary,
                                    CtlHelp.Synopsis(command, compact: false, Ingress),
                                    Tree(command)
                                )
                            )
                    )
                )
            );
        return Array(rows.OrderBy(row => row["name"]!.GetValue<string>(), StringComparer.Ordinal));
    }

    // Telegram registers every head; nouns and shortcuts are lowercase words, as it requires.
    internal static JsonArray TelegramCommands() =>
        Array(
            WebUiCommands()
                .OfType<JsonObject>()
                .Select(row => new JsonObject
                {
                    ["command"] = row["name"]!.GetValue<string>().TrimStart('/'),
                    ["description"] = Telegram(row["description"]!.GetValue<string>()),
                })
        );

    private static string Telegram(string description) =>
        description.Length <= 256 ? description : description[..255] + "…";

    private static JsonArray Array(IEnumerable<JsonObject> items) => new([.. items.Select(item => (JsonNode)item)]);

    private static JsonObject Row(
        string name,
        string description,
        string? usage,
        bool requiresSession,
        JsonArray children
    ) =>
        new()
        {
            ["name"] = name,
            ["description"] = description,
            ["usage"] = usage,
            ["requiresSession"] = requiresSession,
            ["showInTelegram"] = true,
            ["autocomplete"] = new JsonObject { ["children"] = children },
        };

    private static JsonObject Literal(string value, string? description, string? usage, JsonArray? children)
    {
        var node = new JsonObject { ["value"] = value, ["kind"] = "literal" };
        if (description is not null)
            node["description"] = description;
        if (usage is not null)
            node["usage"] = usage;
        if (children is { Count: > 0 })
            node["children"] = children;
        return node;
    }

    private static JsonObject Placeholder(CtlParameter parameter, JsonArray? children)
    {
        var term = "<" + CtlRegistry.Kebab(parameter.Name) + (parameter.Rest ? "..." : "") + ">";
        var node = new JsonObject
        {
            ["value"] = parameter.Required ? term : "[" + term + "]",
            ["kind"] = "placeholder",
        };
        if (parameter.Help is not null)
            node["description"] = parameter.Help;
        if (children is { Count: > 0 })
            node["children"] = children;
        return node;
    }

    // Autocomplete for one command: its options at every position, then its words in order.
    // An option offers its value; enumerated values are literals.
    private static JsonArray Tree(CtlCommand command)
    {
        var words = command.Parameters.Where(parameter => !parameter.Flag).ToArray();
        IEnumerable<JsonObject> Options() =>
            command
                .Parameters.Where(parameter => parameter.Flag)
                .Select(parameter =>
                    Literal(
                        "--" + parameter.FlagName,
                        parameter.Help,
                        null,
                        parameter.IsBoolean ? null : Array(Values(parameter, null))
                    )
                );
        JsonArray At(int index) =>
            index == words.Length
                ? Array(Options())
                : Array(
                    Options()
                        .Concat(Values(words[index], words[index].Rest ? null : At(index + 1)))
                );
        return At(0);
    }

    private static IEnumerable<JsonObject> Values(CtlParameter parameter, JsonArray? children) =>
        parameter.Values is { Count: > 0 } values && parameter.Type == "enum"
            ? values.Select(value =>
                Literal(value, parameter.Help, null, (JsonArray?)children?.DeepClone())
            )
            : [Placeholder(parameter, children)];
}
