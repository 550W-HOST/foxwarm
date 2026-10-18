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
    IReadOnlyList<string>? MentionedMobileList = null
);

internal sealed record RegisteredChannel(
    string Type,
    Func<string, string, ChannelSendOptions, CancellationToken, Task> Send,
    Func<string, ChannelFile, string?, CancellationToken, Task>? SendFile = null,
    Func<string, CancellationToken, Task>? Typing = null,
    Func<string, ChannelSendOptions, CancellationToken, Task>? Finalize = null,
    Func<string, bool>? IsLifecycleActive = null,
    Func<string, ChannelTurnProgress, CancellationToken, Task>? Progress = null
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

    internal static (string Instance, string Conversation) Parse(string target)
    {
        var colon = target.IndexOf(':');
        if (colon <= 0 || colon == target.Length - 1)
            throw new InvalidDataException(
                "Invalid channelTargetId format. Use <channel-instance-id>:<conversation-id>."
            );
        return (target[..colon], target[(colon + 1)..]);
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
