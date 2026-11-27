using System.Text.Json.Nodes;
using Foxwarm.Sessions;

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

internal sealed record ExternalChannelMessage(
    IReadOnlyList<JsonObject> Parts,
    IReadOnlyList<JsonObject>? IngressMetadataParts = null,
    Func<SessionOwner, Task<IReadOnlyList<JsonObject>>>? MaterializeParts = null,
    // Already received bounded files: the routing instance determines the receiving owner,
    // including a newly provisioned guest. This callback does not fetch remote media.
    Func<SessionOwner, Task<IReadOnlyList<JsonObject>>>? BindReceivedFiles = null
)
{
    internal string Text =>
        string.Join(
            "\n",
            Parts.Select(part => Foxwarm.Sessions.SessionWait.Text(part["text"]) ?? "")
        );
}
