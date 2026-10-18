using System.Text.Json.Nodes;

namespace Foxwarm.Channels;

internal sealed record ExternalChannelContext(
    string Instance,
    string Type,
    string Conversation,
    string? Sender,
    string? Username,
    Func<string, Task> Reply,
    string? SelfName = null
)
{
    internal string Target => Instance + ":" + Conversation;
}

internal sealed record ExternalChannelMessage(IReadOnlyList<JsonObject> Parts)
{
    internal string Text =>
        string.Join(
            "\n",
            Parts.Select(part => Foxwarm.Sessions.SessionWait.Text(part["text"]) ?? "")
        );
}
