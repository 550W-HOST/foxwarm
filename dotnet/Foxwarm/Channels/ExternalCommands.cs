using System.Text.Json.Nodes;

namespace Foxwarm.Channels;

internal static class ExternalCommands
{
    // Registration lists only the implemented shared entry points, not the full reference command catalog.
    internal static readonly IReadOnlyDictionary<string, string> Descriptions = new Dictionary<string, string>
    {
        ["whoami"] = "Show your user ID and current channel target",
        ["help"] = "Show help",
        ["attach"] = "Attach to session. `args: <sessionId>`",
        ["channel"] = "View channel status and access, control channel runtime, and change attachment settings.",
        ["session"] = "Create or fork sessions and manage the current session.",
        ["fork"] = "Fork current session. `args: [suffix] [message]`",
        ["stop"] = "Stop current run, or use `/stop compact` to cancel compaction only",
        ["continue"] = "Continue an interrupted turn without adding a new message",
        ["compact"] = "Compact the current session's history.",
        ["dequeue"] = "Run queued items, stopping the current run first if needed",
        ["status"] = "Show current session status",
    };

    internal static JsonArray TelegramCommands() => new(Descriptions.Select(pair => (JsonNode)new JsonObject
    {
        ["command"] = pair.Key, ["description"] = pair.Value,
    }).ToArray());
}
