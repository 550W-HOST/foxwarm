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

    // Direct server tools answer in the next response. Only newly issued calls
    // can remain pending after it, including a response that pauses again.
    internal static HashSet<string> UpdatePending(
        IEnumerable<JsonObject> blocks,
        ISet<string> pending
    )
    {
        var unanswered = pending.ToHashSet();
        pending.Clear();
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
            {
                pending.Remove(id);
                unanswered.Remove(id);
            }
        }
        return unanswered;
    }

    internal static bool HasPendingCalls(JsonObject? response)
    {
        var pending = new HashSet<string>();
        UpdatePending((response?["content"] as JsonArray ?? []).OfType<JsonObject>(), pending);
        return pending.Count > 0;
    }

    // Request-owned clones only. User input or the next response without a
    // matching result abandons old calls; client tool-result rows do not.
    internal static RequestHistory.Row[] RemoveAbandonedCalls(RequestHistory.Row[] history)
    {
        var pending = new Dictionary<string, (int Index, JsonObject Part)>();
        var abandoned = new Dictionary<JsonObject, (int Index, int Boundary)>();
        for (var index = 0; index < history.Length; index++)
        {
            var message = history[index].Message;
            if (SessionWait.Text(message["role"]) == "user")
            {
                foreach (var (start, part) in pending.Values)
                    abandoned.Add(part, (start, index));
                pending.Clear();
                continue;
            }
            if (SessionWait.Text(message["role"]) != "model")
                continue;
            var next = pending.Keys.ToHashSet();
            var unanswered = UpdatePending(Blocks(message), next);
            foreach (var id in unanswered)
            {
                var (start, part) = pending[id];
                abandoned.Add(part, (start, index));
            }
            pending.Clear();
            foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
                if (
                    Block(part) is JsonObject block
                    && SessionWait.Text(block["id"]) is string id
                    && next.Contains(id)
                )
                    pending[id] = (index, part);
        }
        var removed = new HashSet<JsonObject>();
        foreach (var (part, (index, boundary)) in abandoned)
        {
            removed.Add(part);
            // Signatures after this edit were produced against the old prefix.
            // Stop at the abandoning input/response: thinking generated during recovery
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
        var repaired = new List<RequestHistory.Row>();
        for (var index = 0; index < history.Length; index++)
        {
            var parts = history[index].Message["parts"] as JsonArray;
            if (parts is null)
            {
                repaired.Add(history[index]);
                continue;
            }
            var changed = false;
            for (var part = parts.Count - 1; part >= 0; part--)
                if (parts[part] is JsonObject value && removed.Contains(value))
                {
                    parts.RemoveAt(part);
                    changed = true;
                }
            // The journal must describe the repaired row, not reuse its original
            // immutable payload through the provenance cache.
            if (changed && parts.Count == 0)
                continue;
            repaired.Add(changed ? history[index] with { Origin = null } : history[index]);
        }
        return repaired.ToArray();
    }
}
