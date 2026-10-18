namespace Foxwarm.Channels;

// Registered transports, not Session attachments or a message store.
internal sealed class TextChannels
{
    private readonly object gate = new();
    private readonly Dictionary<string, Func<string, string, CancellationToken, Task>> channels = new(StringComparer.Ordinal);

    internal void Register(string id, Func<string, string, CancellationToken, Task> send)
    {
        lock (gate)
            channels.Add(id, send);
    }

    internal void Unregister(string id)
    {
        lock (gate)
            channels.Remove(id);
    }

    internal Task SendAsync(string target, string message, CancellationToken token)
    {
        var colon = target.IndexOf(':');
        if (colon <= 0 || colon == target.Length - 1)
            throw new InvalidDataException("Invalid channelTargetId format. Use <channel-instance-id>:<conversation-id>.");
        Func<string, string, CancellationToken, Task> send;
        lock (gate)
            send = channels.GetValueOrDefault(target[..colon])
                ?? throw new InvalidOperationException("Channel instance is unavailable: " + target[..colon]);
        token.ThrowIfCancellationRequested();
        return send(target[(colon + 1)..], message, token);
    }
}
