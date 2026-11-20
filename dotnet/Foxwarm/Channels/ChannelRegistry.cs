using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Channels;

internal sealed record ChannelFile(string Path, string Name, string? MimeType, bool IsImage);

internal sealed record ChannelTurnTool(string Id, string Name, string Status = "running");

internal sealed record ChannelTurnProgress(
    string Type,
    IReadOnlyList<ChannelTurnTool>? Tools = null,
    string? Text = null
);

internal sealed record ChannelSendOptions(
    bool TurnFinal = false,
    string? ParseMode = null,
    string? WebhookUrl = null,
    string? StreamId = null,
    string? ChatId = null,
    string? ChatType = null,
    int? NativeChatType = null,
    string? MessageType = null,
    IReadOnlyList<string>? MentionedList = null,
    IReadOnlyList<string>? MentionedMobileList = null,
    string? PresentationTurnId = null,
    bool TurnSuspended = false
);

internal sealed record RegisteredChannel(
    string Type,
    Func<string, string, ChannelSendOptions, CancellationToken, Task> Send,
    Func<string, ChannelFile, string?, CancellationToken, Task>? SendFile = null,
    Func<string, CancellationToken, Task>? Typing = null,
    Func<string, ChannelSendOptions, CancellationToken, Task>? Finalize = null,
    Func<string, bool>? IsLifecycleActive = null,
    Func<string, ChannelTurnProgress, CancellationToken, Task>? Progress = null,
    // The conversation a requested conversation part delivers to (the flag: a file delivery),
    // computed by the function the transport's delivery uses; null when the transport can't
    // establish it before delivery. Absent: the transport delivers to the ID verbatim.
    Func<string, bool, string?>? Conversation = null
);

// One transport registry. Persisted attachments and managed transport lifetimes have their own owners.
internal sealed class ChannelRegistry
{
    private readonly object gate = new();
    private readonly Dictionary<string, RegisteredChannel> channels = new(StringComparer.Ordinal);

    internal void Register(string id, Func<string, string, CancellationToken, Task> send) =>
        Register(
            id,
            new RegisteredChannel(
                id,
                (conversation, text, _, token) => send(conversation, text, token)
            )
        );

    internal void Register(string id, RegisteredChannel channel)
    {
        lock (gate)
            channels.Add(id, channel);
    }

    internal void Unregister(string id)
    {
        lock (gate)
            channels.Remove(id);
    }

    internal RegisteredChannel? Get(string id)
    {
        lock (gate)
            return channels.GetValueOrDefault(id);
    }

    internal string[] Ids()
    {
        lock (gate)
            return channels.Keys.ToArray();
    }

    // The channel target send_file delivers to: its channelTargetId, trimmed; empty when absent.
    // The handler and the operation plan (`file-channel`) both use it.
    internal static string FileDeliveryTarget(JsonObject args) =>
        SessionGoal.Trim(ToolRegistry.Text(args, "channelTargetId") ?? "");

    internal static (string Instance, string Conversation) Parse(string target)
    {
        var colon = target.IndexOf(':');
        if (colon <= 0 || colon == target.Length - 1)
            throw new InvalidDataException(
                "Invalid channelTargetId format. Use <channel-instance-id>:<conversation-id>."
            );
        return (target[..colon], target[(colon + 1)..]);
    }

    // The channel target a send delivers to: the instance and its transport's canonical
    // conversation. Null when the target is malformed, its instance isn't registered, or the
    // transport can't establish the conversation before delivery. The operation plan names it.
    internal string? CanonicalTarget(string target, bool file)
    {
        string instance;
        string conversation;
        try
        {
            (instance, conversation) = Parse(target);
        }
        catch (InvalidDataException)
        {
            return null;
        }
        if (Get(instance) is not { } channel)
            return null;
        try
        {
            return (channel.Conversation is { } canonical ? canonical(conversation, file) : conversation)
                is { } delivered
                ? instance + ":" + delivered
                : null;
        }
        catch (InvalidDataException)
        {
            return null;
        }
    }

    internal Task SendAsync(string target, string message, CancellationToken token)
    {
        var (instance, conversation) = Parse(target);
        var channel =
            Get(instance)
            ?? throw new InvalidOperationException("Channel instance is unavailable: " + instance);
        token.ThrowIfCancellationRequested();
        return channel.Send(conversation, message, new(), token);
    }
}
