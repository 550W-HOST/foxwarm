using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static class AnthropicSearchHistory
{
    internal static JsonObject? Block(JsonObject part)
    {
        var native = (part["providerMeta"] as JsonObject)?["anthropic"] as JsonObject;
        if (
            SessionWait.Text(native?["sourceModelId"]) is not string
            || native?["contentBlock"] is not JsonObject block
        )
            return null;
        return IsSearch(block) ? block : null;
    }

    internal static IEnumerable<JsonObject> Blocks(JsonObject message) =>
        (message["parts"] as JsonArray ?? [])
            .OfType<JsonObject>()
            .Select(Block)
            .OfType<JsonObject>();

    private static bool IsSearch(JsonObject block) =>
        SessionWait.Text(block["type"]) == "web_search_tool_result"
        || SessionWait.Text(block["type"]) == "server_tool_use"
            && SessionWait.Text(block["name"]) == "web_search";

    internal static void UpdatePending(IEnumerable<JsonObject> blocks, ISet<string> pending)
    {
        foreach (var block in blocks)
        {
            if (!IsSearch(block))
                continue;
            var call = SessionWait.Text(block["type"]) == "server_tool_use";
            var id = SessionWait.Text(block[call ? "id" : "tool_use_id"]);
            if (string.IsNullOrEmpty(id))
                continue;
            if (call)
                pending.Add(id);
            else
                pending.Remove(id);
        }
    }

    internal static bool HasPendingCalls(JsonObject? response)
    {
        var pending = new HashSet<string>();
        UpdatePending((response?["content"] as JsonArray ?? []).OfType<JsonObject>(), pending);
        return pending.Count > 0;
    }

    // Operates only on the request-owned clones. New user input abandons unfinished
    // server calls; local tool-result rows do not. A later real result protects its
    // call even when another user row appeared in the retained history.
    internal static void RemoveAbandonedCalls(RequestHistory.Row[] history)
    {
        var pending = new Dictionary<string, (int Index, JsonObject Part)>();
        var abandoned = new Dictionary<JsonObject, int>();
        for (var index = 0; index < history.Length; index++)
        {
            var message = history[index].Message;
            if (SessionWait.Text(message["role"]) == "user")
            {
                foreach (var (_, part) in pending.Values)
                    abandoned.TryAdd(part, index);
                continue;
            }
            if (SessionWait.Text(message["role"]) != "model")
                continue;
            foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
            {
                if (Block(part) is not JsonObject block)
                    continue;
                var call = SessionWait.Text(block["type"]) == "server_tool_use";
                var id = SessionWait.Text(block[call ? "id" : "tool_use_id"]);
                if (string.IsNullOrEmpty(id))
                    continue;
                if (call)
                    pending[id] = (index, part);
                else if (pending.Remove(id, out var original))
                    abandoned.Remove(original.Part);
            }
        }
        var removed = new HashSet<JsonObject>();
        foreach (var (index, part) in pending.Values)
        {
            if (!abandoned.TryGetValue(part, out var boundary))
                continue;
            removed.Add(part);
            // Signatures after this edit were produced against the old prefix.
            // Stop at the first new input: thinking generated during recovery
            // sees the repaired prefix and must survive subsequent requests.
            for (var cursor = index; cursor < boundary; cursor++)
            {
                var afterCall = cursor > index;
                foreach (
                    var candidate in history[cursor].Message["parts"]!
                        .AsArray()
                        .OfType<JsonObject>()
                )
                {
                    if (!afterCall)
                    {
                        afterCall = ReferenceEquals(candidate, part);
                        continue;
                    }
                    if (
                        candidate["providerMeta"] is JsonObject metadata
                        && (
                            metadata["signature"] is not null
                            || metadata["redactedThinking"] is not null
                        )
                    )
                        removed.Add(candidate);
                }
            }
        }
        for (var index = 0; index < history.Length; index++)
        {
            var parts = history[index].Message["parts"] as JsonArray;
            if (parts is null)
                continue;
            var changed = false;
            for (var part = parts.Count - 1; part >= 0; part--)
                if (parts[part] is JsonObject value && removed.Contains(value))
                {
                    parts.RemoveAt(part);
                    changed = true;
                }
            // The journal must describe the repaired row, not reuse its original
            // immutable payload through the provenance cache.
            if (changed)
                history[index] = history[index] with { Origin = null };
        }
    }
}
