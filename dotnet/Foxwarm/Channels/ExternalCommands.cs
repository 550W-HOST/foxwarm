using System.Text.Json.Nodes;

namespace Foxwarm.Channels;

internal static class ExternalCommands
{
    private static readonly JsonObject[] Entries = Read();

    private static JsonObject[] Read()
    {
        using var stream = typeof(ExternalCommands).Assembly.GetManifestResourceStream(
            "Foxwarm.Channels.CommandCatalog.json"
        )!;
        return JsonNode.Parse(stream)!.AsArray().OfType<JsonObject>().ToArray();
    }

    internal static JsonObject? Find(string name) =>
        Entries.FirstOrDefault(row => row["name"]!.GetValue<string>() == name);

    internal static string Help() =>
        "📖 *Commands*\n\n" + string.Join("\n", Entries
            .Where(row => row["showInTelegram"]!.GetValue<bool>())
            .Select(row => $"`{row["name"]}` - {row["description"]}"
                + (row["usage"] is null ? "" : " " + row["usage"])));

    internal static JsonArray WebUiCommands() => new(Entries
        .OrderBy(row => row["name"]!.GetValue<string>(), StringComparer.Ordinal)
        .Select(row => row.DeepClone()).ToArray());

    internal static JsonArray TelegramCommands() => new(Entries
        .Where(row => row["showInTelegram"]!.GetValue<bool>())
        .Select(row => (JsonNode)new JsonObject
        {
            ["command"] = row["name"]!.GetValue<string>().TrimStart('/'),
            ["description"] = row["description"]!.DeepClone(),
        }).ToArray());
}
