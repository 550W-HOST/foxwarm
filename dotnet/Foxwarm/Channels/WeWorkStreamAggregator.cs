using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Channels;

internal sealed record WeWorkDelivery(
    string Mode,
    string? ResponseUrl = null,
    string? ReqId = null
);

internal sealed record WeWorkStreamSnapshot(
    string Conversation,
    string Id,
    string Content,
    bool Finish,
    WeWorkDelivery Delivery,
    long UpdatedAt
)
{
    internal JsonObject Payload() =>
        new()
        {
            ["msgtype"] = "stream",
            ["stream"] = new JsonObject
            {
                ["id"] = Id,
                ["finish"] = Finish,
                ["content"] = Content,
            },
        };
}

// Adapter-local presentation only. Neither IDs nor progress enter Session authority.
internal sealed class WeWorkStreamAggregator(int maxBytes = 20000, Func<DateTimeOffset>? now = null)
{
    private abstract class Block;

    private sealed class TextBlock(string text) : Block
    {
        internal string Text = text;
    }

    private sealed class ToolEntry(string id, string name, string status)
    {
        internal string Id = id;
        internal string Name = name;
        internal string Status = status;
    }

    private sealed class ToolGroup : Block
    {
        internal List<ToolEntry> Tools = [];
        internal bool Thinking;
    }

    private sealed class State(string conversation, WeWorkDelivery delivery)
    {
        internal string Conversation = conversation;
        internal string Id = "fw_" + Guid.NewGuid().ToString("N")[..24];
        internal WeWorkDelivery Delivery = delivery;
        internal bool Finish;
        internal long UpdatedAt;
        internal string Content = "";
        internal List<Block> Blocks = [new ToolGroup { Thinking = true }];
    }

    private readonly object gate = new();
    private readonly Dictionary<string, State> conversations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, State> streams = new(StringComparer.Ordinal);
    private readonly int limit = Math.Clamp(maxBytes == 0 ? 20000 : maxBytes, 1, 20480);
    private long Now => (now?.Invoke() ?? DateTimeOffset.UtcNow).ToUnixTimeMilliseconds();

    private void Cleanup()
    {
        foreach (var (id, state) in streams.ToArray())
            if (Now - state.UpdatedAt > 15 * 60 * 1000)
            {
                streams.Remove(id);
                if (conversations.GetValueOrDefault(state.Conversation) == state)
                    conversations.Remove(state.Conversation);
            }
    }

    internal (WeWorkStreamSnapshot? Old, WeWorkStreamSnapshot Current) Begin(
        string conversation,
        WeWorkDelivery delivery
    )
    {
        lock (gate)
        {
            Cleanup();
            conversation = conversation.Trim();
            if (conversation.Length == 0)
                throw new InvalidDataException(
                    "conversationId is required to begin a WeWork stream"
                );
            WeWorkStreamSnapshot? old = null;
            if (conversations.GetValueOrDefault(conversation) is { Finish: false } previous)
            {
                previous.Blocks.RemoveAll(block => block is not TextBlock);
                previous.Finish = true;
                old = Update(previous);
            }
            var state = new State(conversation, delivery);
            conversations[conversation] = state;
            streams[state.Id] = state;
            return (old, Update(state));
        }
    }

    internal WeWorkStreamSnapshot? Get(string value, bool byId = false)
    {
        lock (gate)
        {
            Cleanup();
            var state = (byId ? streams : conversations).GetValueOrDefault(value.Trim());
            return state is null ? null : Snapshot(state);
        }
    }

    // Selection and mutation are synchronous, before any platform await.
    internal (bool Handled, WeWorkStreamSnapshot? Changed) Apply(
        string conversation,
        string text,
        ChannelSendOptions options,
        ChannelTurnProgress? progress = null
    )
    {
        lock (gate)
        {
            Cleanup();
            var latest = conversations.GetValueOrDefault(conversation.Trim());
            var id =
                options.StreamId
                ?? (
                    string.IsNullOrWhiteSpace(options.WebhookUrl) && latest is { Finish: false }
                        ? latest.Id
                        : null
                );
            if (id is null)
                return (false, null);
            var state = latest ?? streams.GetValueOrDefault(id.Trim());
            if (state is null || state.Conversation != conversation)
                return (true, null);
            if (state.Finish)
                return (false, null);
            var before = state.Content;
            var finished = state.Finish;
            if (progress is not null)
                ApplyProgress(state, progress);
            else
            {
                if (text.Trim() is { Length: > 0 } section)
                {
                    ClearThinking(state);
                    state.Blocks.Add(new TextBlock(section));
                }
                if (options.TurnFinal)
                {
                    ClearThinking(state);
                    state.Finish = true;
                }
            }
            var result = Update(state);
            return (true, before == result.Content && finished == result.Finish ? null : result);
        }
    }

    private static void ClearThinking(State state)
    {
        foreach (var group in state.Blocks.OfType<ToolGroup>())
            group.Thinking = false;
        state.Blocks.RemoveAll(block => block is ToolGroup { Tools.Count: 0 });
    }

    private static ToolGroup CurrentGroup(State state)
    {
        if (state.Blocks.LastOrDefault() is ToolGroup group)
            return group;
        var created = new ToolGroup();
        state.Blocks.Add(created);
        return created;
    }

    private static void ApplyProgress(State state, ChannelTurnProgress progress)
    {
        if (progress.Type == "llm-start")
        {
            CurrentGroup(state).Thinking = true;
            return;
        }
        if (progress.Type == "tool-calls-start")
        {
            ClearThinking(state);
            if (progress.Text?.Trim() is { Length: > 0 } text)
                state.Blocks.Add(new TextBlock(text));
        }
        var group = CurrentGroup(state);
        foreach (var tool in progress.Tools ?? [])
        {
            if (tool.Id.Length == 0)
                continue;
            var existing = state
                .Blocks.OfType<ToolGroup>()
                .SelectMany(block => block.Tools)
                .FirstOrDefault(entry => entry.Id == tool.Id);
            var name = string.IsNullOrEmpty(tool.Name) ? "tool" : tool.Name;
            var status = progress.Type == "tool-calls-start" ? "running" : tool.Status;
            if (existing is not null)
            {
                existing.Name = string.IsNullOrEmpty(tool.Name) ? existing.Name : tool.Name;
                existing.Status = status;
            }
            else
                group.Tools.Add(new(tool.Id, name, status));
        }
    }

    private WeWorkStreamSnapshot Update(State state)
    {
        var sections = state
            .Blocks.Select(block =>
                block is TextBlock text ? text.Text : RenderGroup((ToolGroup)block)
            )
            .Where(value => value.Length > 0);
        var raw = string.Join("\n\n", sections);
        state.Content = Truncate(
            raw.Length == 0
                ? state.Finish
                    ? "处理完成。"
                    : "> 🤔 thinking"
                : raw,
            limit
        );
        state.UpdatedAt = Now;
        return Snapshot(state);
    }

    private static string RenderGroup(ToolGroup group)
    {
        var grouped = group.Tools.GroupBy(tool => (tool.Status, tool.Name));
        var items = grouped
            .Select(tools =>
            {
                var icon = tools.Key.Status switch
                {
                    "success" => "☑️",
                    "error" => "❌",
                    _ => "⌛️",
                };
                return icon
                    + " "
                    + tools.Key.Name
                    + (tools.Count() > 1 ? " ×" + tools.Count() : "");
            })
            .ToList();
        if (group.Thinking)
            items.Add("🤔 thinking");
        return items.Count == 0 ? "" : "> " + string.Join(" | ", items);
    }

    private static WeWorkStreamSnapshot Snapshot(State state) =>
        new(
            state.Conversation,
            state.Id,
            state.Content,
            state.Finish,
            state.Delivery,
            state.UpdatedAt
        );

    internal static string Truncate(string value, int maxBytes)
    {
        if (maxBytes <= 0 || Encoding.UTF8.GetByteCount(value) <= maxBytes)
            return value;
        const string suffix = "\n\n…[内容过长，已截断]";
        var budget = Math.Max(0, maxBytes - Encoding.UTF8.GetByteCount(suffix));
        var result = new StringBuilder();
        var used = 0;
        foreach (var rune in value.EnumerateRunes())
        {
            if (used + rune.Utf8SequenceLength > budget)
                break;
            result.Append(rune.ToString());
            used += rune.Utf8SequenceLength;
        }
        return result + suffix;
    }
}
