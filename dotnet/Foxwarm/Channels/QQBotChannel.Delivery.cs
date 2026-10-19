using System.Text.Json.Nodes;

namespace Foxwarm.Channels;

internal sealed partial class QQBotChannel
{
    private sealed class Passive(DateTimeOffset firstSeen)
    {
        internal readonly DateTimeOffset FirstSeen = firstSeen;
        internal int Successes;
        internal bool Expired;
    }
    private sealed record ReplyChain(long Generation, Task Barrier);
    private readonly OrderedDictionary<string, string> latest = new(StringComparer.Ordinal);
    private readonly OrderedDictionary<string, Passive> passive = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ReplyChain> chains = new(StringComparer.Ordinal);
    private readonly QQBotMedia media;

    private static void BoundInsert<T>(OrderedDictionary<string, T> map, string key, T value, int cap)
    {
        if (!map.ContainsKey(key) && map.Count >= cap) map.Remove(map.Keys.First());
        map[key] = value;
    }
    private Passive PassiveFor(string messageId)
    {
        if (passive.TryGetValue(messageId, out var value)) return value;
        value = new(now());
        BoundInsert(passive, messageId, value, 10000);
        return value;
    }
    private string? Latest(string conversation) { lock (stateGate) return latest.GetValueOrDefault(conversation); }
    private string? SelectPassive(string? messageId)
    {
        if (messageId is null) return null;
        lock (stateGate)
        {
            var context = PassiveFor(messageId);
            return context.Expired || context.Successes >= 4 || now() - context.FirstSeen >= TimeSpan.FromMinutes(3) ? null : messageId;
        }
    }
    private static string MessagePath((string Kind, string Id) target) => target.Kind switch
    {
        "c2c" => "/v2/users/" + Uri.EscapeDataString(target.Id) + "/messages",
        "group" => "/v2/groups/" + Uri.EscapeDataString(target.Id) + "/messages",
        "guild" => "/channels/" + Uri.EscapeDataString(target.Id) + "/messages",
        _ => "/dms/" + Uri.EscapeDataString(target.Id) + "/messages"
    };
    private Task SendAsync(string conversation, string text, ChannelSendOptions options, CancellationToken token) =>
        SendTextAsync(conversation, text, options, null, token);

    private async Task SendTextAsync(string conversation, string text, ChannelSendOptions options, string? explicitReply, CancellationToken token)
    {
        var target = Parse(conversation);
        if (string.IsNullOrWhiteSpace(text)) return;
        // Ordinary direct tool sends are proactive. Automatic presentation resolves latest per attachment.
        var messageId = explicitReply ?? (options.TurnFinal || options.PresentationTurnId is not null ? Latest(conversation) : null);
        var expected = Interlocked.Read(ref generation);
        async Task Send()
        {
            var body = new JsonObject { ["content"] = text };
            if (target.Kind is "c2c" or "group")
            {
                body["msg_type"] = 0;
                body["msg_seq"] = AllocateSequence();
            }
            await SendFinalAsync(MessagePath(target), body, messageId, expected, token,
                target.Kind is "c2c" or "group");
        }
        try { await EnqueueReplyAsync(messageId, expected, Send); }
        catch (Exception error) when (messageId is not null && options.TurnFinal) { log(error); }
    }
    private async Task SendFinalAsync(string path, JsonObject body, string? messageId,
        long expected, CancellationToken token, bool allowExpiration = true)
    {
        RequireCurrent(expected);
        var passiveId = SelectPassive(messageId);
        if (passiveId is not null) body["msg_id"] = passiveId;
        try { await ApiAsync(path, body, token, expected: expected); }
        catch (QQBotApiException error) when (passiveId is not null && allowExpiration && error.Code == 40034005)
        {
            RequireCurrent(expected);
            lock (stateGate) PassiveFor(passiveId).Expired = true;
            body.Remove("msg_id");
            passiveId = null;
            await ApiAsync(path, body, token, expected: expected);
        }
        if (passiveId is not null && Current(expected))
            lock (stateGate) if (Current(expected)) PassiveFor(passiveId).Successes++;
    }
    private async Task EnqueueReplyAsync(string? messageId, long expected, Func<Task> operation)
    {
        if (messageId is null)
        {
            RequireCurrent(expected);
            await operation();
            return;
        }
        Task previous;
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ReplyChain chain;
        lock (stateGate)
        {
            var existing = chains.GetValueOrDefault(messageId);
            previous = existing?.Generation == expected ? existing.Barrier : Task.CompletedTask;
            if (existing is null && chains.Count >= 10000)
                throw new IOException("QQ Bot has too many concurrent source-bound reply chains.");
            chain = new(expected, done.Task);
            chains[messageId] = chain;
        }
        try
        {
            await previous;
            RequireCurrent(expected);
            await operation();
        }
        finally
        {
            done.TrySetResult();
            lock (stateGate) if (ReferenceEquals(chains.GetValueOrDefault(messageId), chain)) chains.Remove(messageId);
        }
    }
    private async Task TypingAsync(string conversation, CancellationToken token)
    {
        var target = Parse(conversation);
        if (target.Kind != "c2c" || Latest(conversation) is not { } messageId) return;
        var expected = Interlocked.Read(ref generation);
        await ApiAsync(MessagePath(target), new JsonObject
        {
            ["msg_type"] = 6,
            ["input_notify"] = new JsonObject { ["input_type"] = 1, ["input_second"] = 10 },
            ["msg_id"] = messageId, ["msg_seq"] = AllocateSequence()
        }, token, expected: expected);
    }
    private async Task SendFileAsync(string conversation, ChannelFile file, string? caption, CancellationToken token)
    {
        var target = Parse(conversation);
        if (target.Kind is not ("c2c" or "group"))
            throw new InvalidDataException("QQ Bot media sending is unsupported for guild and DM destinations.");
        // Unlike direct text, the actual file caller always selects latest context when it exists.
        var messageId = Latest(conversation);
        var expected = Interlocked.Read(ref generation);
        await EnqueueReplyAsync(messageId, expected, async () =>
        {
            RequireCurrent(expected);
            var sequence = AllocateSequence();
            var fileInfo = await QQBotUpload.UploadAsync(target.Kind, target.Id, file, config["media"] as JsonObject,
                (path, body) => ApiAsync(path, body, token, 4 * 1024 * 1024, expected),
                http, () => RequireCurrent(expected), token, partTimeout);
            RequireCurrent(expected);
            var body = new JsonObject
            {
                ["msg_type"] = 7,
                ["media"] = new JsonObject { ["file_info"] = fileInfo },
                ["msg_seq"] = sequence
            };
            if (caption?.Trim() is { Length: > 0 } content) body["content"] = content[..Math.Min(2000, content.Length)];
            await SendFinalAsync(MessagePath(target), body, messageId, expected, token);
        });
    }
}
