using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed partial class QQBotChannel
{
    private sealed record Inbound(string Kind, string Conversation, string Sender, string Username, string Id);
    private sealed record Buffered(string Key, string Type, DateTimeOffset At, Inbound Identity,
        string Content, JsonArray Attachments, bool Mentioned);
    private sealed class Group
    {
        internal List<Buffered> Context = [];
        internal Buffered? Current;
        internal DateTimeOffset? Opened;
        internal CancellationTokenSource? Timer;
    }
    private sealed record Batch(List<Buffered> Context, Buffered Current, List<string>? Platform = null)
    { internal long Run { get; init; } }
    private readonly OrderedDictionary<string, bool> recent = new(StringComparer.Ordinal);
    private readonly OrderedDictionary<string, Group> groups = new(StringComparer.Ordinal);
    private long bufferGeneration;
    private readonly int groupLimit;
    private readonly int batchWindow;
    private bool RequireMention => config["requireMention"]?.ToJsonString() != "false";
    private int GroupOption(string key, int fallback, int min, int max, bool zero = false)
    {
        if (config[key] is null) return fallback;
        var value = Numeric(config[key]);
        if (value is null || value != Math.Truncate(value.Value) || value > max || value < min && !(zero && value == 0))
            throw new InvalidDataException($"QQ Bot {key} is outside its supported range.");
        return (int)value;
    }
    private static string? Scalar(JsonNode? value)
    {
        if (value is not JsonValue scalar) return null;
        if (scalar.TryGetValue<string>(out var text))
        {
            text = text.Trim();
            return text.Length is > 0 and <= 128 && !Regex.IsMatch(text, "[\\x00-\\x1f\\x7f]") ? text : null;
        }
        var number = Number(value);
        return number is >= 0 and <= 9007199254740991 && number == Math.Truncate(number.Value)
            ? number.Value.ToString("0", System.Globalization.CultureInfo.InvariantCulture) : null;
    }
    private static string? SceneIndex(JsonNode? value)
    {
        if (value is JsonObject obj) return Scalar(obj["msg_idx"]);
        if (value is not JsonArray list || list.Count > 32) return null;
        string? result = null;
        foreach (var entry in list)
        {
            if (Text(entry) is not { Length: <= 256 } text) return null;
            if (!text.StartsWith("msg_idx=", StringComparison.Ordinal)) continue;
            var next = Scalar(JsonValue.Create(text[8..]));
            if (next is null || result is not null) return null;
            result = next;
        }
        return result;
    }
    private static string EventKey(string type, string messageId, JsonObject body) =>
        (type is "GROUP_AT_MESSAGE_CREATE" or "GROUP_MESSAGE_CREATE" ? "GROUP_MESSAGE_CREATE" : type)
        + ":" + messageId + ":seq=" + (Scalar(body["msg_seq"]) ?? "-")
        + ":idx=" + (SceneIndex((body["message_scene"] as JsonObject)?["ext"]) ?? "-");
    private static Inbound? Identity(string type, JsonObject body)
    {
        var messageId = Text(body["id"])?.Trim();
        if (string.IsNullOrEmpty(messageId)) return null;
        var kind = type switch
        {
            "C2C_MESSAGE_CREATE" => "c2c",
            "GROUP_MESSAGE_CREATE" or "GROUP_AT_MESSAGE_CREATE" => "group",
            "AT_MESSAGE_CREATE" => "guild",
            _ => "dm"
        };
        var sender = Text(body["author"]?[kind == "c2c" ? "user_openid" : kind == "group" ? "member_openid" : "id"])?.Trim();
        var target = kind == "c2c" ? sender : Text(body[kind == "group" ? "group_openid" : kind == "guild" ? "channel_id" : "guild_id"])?.Trim();
        return string.IsNullOrEmpty(sender) || string.IsNullOrEmpty(target) ? null
            : new(kind, kind + ":" + target, sender,
                kind == "c2c" ? sender : Text(body["author"]?["username"]) is { Length: > 0 } name ? name : sender, messageId);
    }
    private static bool IsMention(string type, JsonObject body) => type == "GROUP_AT_MESSAGE_CREATE"
        || type == "GROUP_MESSAGE_CREATE" && body["mentions"] is JsonArray entries
        && entries.Take(64).OfType<JsonObject>().Any(entry => entry["is_you"]?.ToJsonString() == "true");

    internal Task RouteInboundAsync(string type, JsonObject body)
    {
        var inbound = Identity(type, body);
        if (inbound is null) return Task.CompletedTask;
        var content = Text(body["content"]) ?? "";
        var attachments = body["attachments"] as JsonArray ?? [];
        if (string.IsNullOrWhiteSpace(content) && (inbound.Kind is not ("c2c" or "group") || attachments.Count == 0))
            return Task.CompletedTask;
        Batch? batch;
        lock (stateGate)
        {
            var key = EventKey(type, inbound.Id, body);
            var current = new Buffered(key, type, now(), inbound, content, (JsonArray)attachments.DeepClone(), IsMention(type, body));
            if (inbound.Kind != "group")
            {
                if (recent.ContainsKey(key)) return Task.CompletedTask;
                BoundInsert(recent, key, true, 10000);
                batch = new([], current);
            }
            else
            {
                var accumulator = groups.GetValueOrDefault(inbound.Conversation);
                if (accumulator is not null)
                {
                    // Touch the bounded group map without moving the fixed batch deadline.
                    groups.Remove(inbound.Conversation); groups[inbound.Conversation] = accumulator;
                    var cutoff = now() - TimeSpan.FromMinutes(5);
                    accumulator.Context.RemoveAll(item => item.At < cutoff);
                    if (accumulator.Current is { } stale && stale.At < cutoff)
                    {
                        accumulator.Current = null; accumulator.Opened = null;
                        accumulator.Timer?.Cancel(); accumulator.Timer = null;
                    }
                }
                var duplicate = accumulator?.Current?.Key == key ? accumulator.Current : accumulator?.Context.Find(item => item.Key == key);
                if (duplicate is not null && !current.Mentioned) return Task.CompletedTask;
                if (duplicate is not null)
                {
                    if (accumulator!.Current?.Key == key) accumulator.Current = null;
                    accumulator.Context.RemoveAll(item => item.Key == key);
                }
                else
                {
                    if (recent.ContainsKey(key)) return Task.CompletedTask;
                    BoundInsert(recent, key, true, 10000);
                }
                if (accumulator is null)
                {
                    if (groups.Count >= 1000) Detach(groups.Keys.First());
                    accumulator = new(); groups[inbound.Conversation] = accumulator;
                }
                if (content.TrimStart().StartsWith('/') && (current.Mentioned || !RequireMention))
                {
                    Detach(inbound.Conversation);
                    batch = new([], current);
                }
                else if (RequireMention)
                {
                    if (!current.Mentioned) { Append(accumulator, current); return Task.CompletedTask; }
                    var context = Context(Detach(inbound.Conversation)?.Context ?? []);
                    batch = new(context, current, context.Count == 0 ? PlatformHistory(body["msg_elements"], content) : null);
                }
                else
                {
                    if (accumulator.Current is { } previous) Append(accumulator, previous);
                    accumulator.Current = current;
                    accumulator.Opened ??= current.At;
                    if (current.Mentioned || attachments.Count > 0 || batchWindow == 0)
                    {
                        var detached = Detach(inbound.Conversation)!;
                        batch = new(Context(detached.Context), current) { Run = bufferGeneration };
                    }
                    else
                    {
                        if (accumulator.Timer is null)
                        {
                            accumulator.Timer = new();
                            _ = ObserveAsync(FlushAfterAsync(inbound.Conversation, accumulator, bufferGeneration));
                        }
                        return Task.CompletedTask;
                    }
                }
            }
            batch = batch with { Run = bufferGeneration };
        }
        return DispatchAsync(batch);
    }
    private void Append(Group accumulator, Buffered item)
    {
        accumulator.Context.Add(item);
        var retained = Math.Max(1, groupLimit);
        if (accumulator.Context.Count > retained)
            accumulator.Context.RemoveRange(0, accumulator.Context.Count - retained);
    }
    private List<Buffered> Context(List<Buffered> input) => input.TakeLast(groupLimit).ToList();
    private Group? Detach(string conversation)
    {
        if (!groups.Remove(conversation, out var detached)) return null;
        detached.Timer?.Cancel();
        return detached;
    }
    private async Task FlushAfterAsync(string conversation, Group accumulator, long expected)
    {
        var timer = accumulator.Timer!;
        try
        {
            await delay(TimeSpan.FromMilliseconds(Math.Max(0, batchWindow - (now() - accumulator.Opened!.Value).TotalMilliseconds)), timer.Token);
            Batch? batch = null;
            lock (stateGate)
            {
                if (expected != bufferGeneration || !ReferenceEquals(groups.GetValueOrDefault(conversation), accumulator) || timer.IsCancellationRequested) return;
                var detached = Detach(conversation)!;
                if (detached.Current is { } current) batch = new(Context(detached.Context), current) { Run = expected };
            }
            if (batch is not null) await DispatchAsync(batch);
        }
        catch (OperationCanceledException) when (timer.IsCancellationRequested) { }
        finally { timer.Dispose(); }
    }
    private static string EscapeText(string value) => value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
    private static string Attribute(string value) => LocalSessionTurnHost.EscapeFoxwarmAttribute(value);
    private string BatchContent(Batch batch)
    {
        var current = batch.Current;
        var items = batch.Context.Where(item => current.At - item.At <= TimeSpan.FromMinutes(5)).Select(item =>
            "<foxwarm-qqbot-context-item senderId=\"" + Attribute(item.Identity.Sender)
            + "\" senderName=\"" + Attribute(item.Identity.Username) + "\" time=\"" + item.At.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            + "\">\n" + EscapeText(string.Join("\n", media.Preview(item.Content, item.Attachments).Select(part => Text(part["text"]) ?? "")))
            + "\n</foxwarm-qqbot-context-item>").ToList();
        if (items.Count == 0 && batch.Platform is { } history)
            items.AddRange(history.Select(text => "<foxwarm-qqbot-context-item source=\"platform-history\">\n" + EscapeText(text) + "\n</foxwarm-qqbot-context-item>"));
        if (items.Count == 0) return current.Content;
        var context = $"<foxwarm-qqbot-context count=\"{items.Count}\" untrusted=\"true\">\n" + string.Join("\n", items) + "\n</foxwarm-qqbot-context>";
        return context + (current.Content.Length > 0 ? "\n\n" + current.Content : "");
    }
    private async Task DispatchAsync(Batch batch)
    {
        var item = batch.Current;
        var inbound = item.Identity;
        lock (stateGate)
        {
            if (batch.Run != bufferGeneration) return;
            PassiveFor(inbound.Id);
            BoundInsert(latest, inbound.Conversation, inbound.Id, 1000);
        }
        var content = BatchContent(batch);
        var supportsMedia = inbound.Kind is "c2c" or "group";
        var source = new ExternalChannelContext(id, "qqbot", inbound.Conversation, inbound.Sender, inbound.Username,
            text => SendTextAsync(inbound.Conversation, text, new(TurnFinal: true), inbound.Id, CancellationToken.None));
        IReadOnlyList<JsonObject>? metadata = inbound.Kind == "group"
            ? [new JsonObject { ["system"] = "<foxwarm-metadata kind=\"group-message\" mentioned=\"" + (item.Mentioned ? "true" : "false")
                + "\" hint=\"" + (item.Mentioned ? "The current group message explicitly mentioned this agent." : "The current group message is ordinary group chat and did not mention this agent.") + "\" />" }]
            : null;
        var parts = supportsMedia && item.Attachments.Count > 0 ? media.Preview(content, item.Attachments) : [new JsonObject { ["text"] = content }];
        var message = new ExternalChannelMessage(parts, metadata,
            supportsMedia && item.Attachments.Count > 0 ? owner => media.MaterializeAsync(content, item.Attachments, owner) : null);
        try { await router.HandleExternalMessageAsync(source, message); }
        catch (Exception error) { log(error); }
    }
    private List<string> PlatformHistory(JsonNode? raw, string current)
    {
        if (groupLimit == 0 || raw is not JsonArray elements) return [];
        var records = new List<(string Text, bool Parsed)>();
        var remaining = 100000;
        foreach (var element in elements.Take(50).OfType<JsonObject>())
        {
            if (records.Count >= 50 || remaining <= 0) break;
            if (Text(element["content"]) is not { } value) continue;
            var body = value[..Math.Min(remaining, value.Length)]; remaining -= body.Length;
            if (string.IsNullOrWhiteSpace(body)) continue;
            var parsed = ParseHistory(body);
            if (parsed is not null) records.AddRange(parsed.Take(50 - records.Count).Select(text => (text, true)));
            else records.Add((body.Trim(), false));
        }
        static string Comparable(string value) => value.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
        if (records.Count > 0 && records[^1].Parsed && Comparable(records[^1].Text) == Comparable(current)) records.RemoveAt(records.Count - 1);
        return records.TakeLast(groupLimit).Select(item => item.Text).ToList();
    }
    private static List<string>? ParseHistory(string body)
    {
        var lines = body.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        var result = new List<string>();
        var index = 0;
        while (index < lines.Length && string.IsNullOrWhiteSpace(lines[index])) index++;
        static bool Header(string line) => Regex.IsMatch(line.Trim(), @"^===\s*消息\s+\d+\s*===$");
        while (index < lines.Length)
        {
            if (!Header(lines[index++]) || index >= lines.Length) return null;
            var match = Regex.Match(lines[index++], @"^\[消息内容\][ \t]*(.*)$");
            if (!match.Success) return null;
            var content = new List<string> { match.Groups[1].Value };
            while (index < lines.Length && !Header(lines[index])) content.Add(lines[index++]);
            var text = string.Join("\n", content).Trim();
            if (text.Length > 0) result.Add(text);
        }
        return result.Count > 0 ? result : null;
    }
}
