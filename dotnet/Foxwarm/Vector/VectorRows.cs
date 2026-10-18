using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using static Foxwarm.Vector.VectorText;

namespace Foxwarm.Vector;

internal sealed record ArchiveSegment(string SessionId, string Agent, long StartSeq, long EndSeq, int MessageCount, string Role, double StartTimestamp, double EndTimestamp, string Text);

internal static class VectorRows
{
    internal static IReadOnlyList<ArchiveSegment> Segments(IEnumerable<ArchiveMessageRecord> records)
    {
        var messages = records.Select(row => (Row: row, Text: Message(row.Message))).Where(row => row.Text.Length > 0).ToArray();
        var segments = new List<ArchiveSegment>();
        var start = 0;
        while (start < messages.Length)
        {
            var end = start;
            var text = messages[start].Text;
            while (end + 1 < messages.Length && Tokens(text) < 1200)
            {
                var candidate = text + "\n\n" + messages[end + 1].Text;
                if (Tokens(candidate) > 1500)
                    break;
                end++;
                text = candidate;
            }
            var first = messages[start].Row;
            var last = messages[end].Row;
            segments.Add(new(first.SessionId, first.Agent, first.Seq, last.Seq, end - start + 1, first.Role, first.Timestamp == 0 ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : first.Timestamp,
                last.Timestamp == 0 ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : last.Timestamp, text));
            if (end == messages.Length - 1)
                break;
            var next = end + 1;
            var overlap = "";
            for (var index = end; index > start; index--)
            {
                if (Tokens(messages[index].Text) > 400)
                    break;
                var candidate = messages[index].Text + (overlap.Length == 0 ? "" : "\n\n" + overlap);
                if (Tokens(candidate) > 400)
                    break;
                overlap = candidate;
                next = index;
            }
            start = Math.Max(start + 1, next);
        }
        return segments;
    }

    private static JsonObject Common(string session, string agent, string messageId, string kind, long first, long last, int count, string role, double startTime, double endTime, string text) => new()
    {
        ["id"] = messageId + ":0", ["message_id"] = messageId, ["session_id"] = session, ["agent"] = agent.Length == 0 ? "main" : agent,
        ["memory_kind"] = kind, ["seq"] = first, ["start_seq"] = first, ["end_seq"] = last, ["raw_start_seq"] = first, ["raw_end_seq"] = last,
        ["message_count"] = count, ["role"] = role, ["timestamp"] = startTime, ["start_timestamp"] = startTime, ["end_timestamp"] = endTime,
        ["chunk_index"] = 0, ["chunk_count"] = 1, ["text"] = text, ["chunk_text"] = Truncate(text), ["block_id"] = null, ["block_level"] = null,
        ["source_kind"] = null, ["source_start"] = null, ["source_end"] = null,
    };

    internal static IReadOnlyList<JsonObject> Raw(ArchiveSegment segment)
    {
        var text = Trim(segment.Text);
        var chunks = Chunks(text);
        return chunks.Select((chunk, index) =>
        {
            var row = Common(segment.SessionId, segment.Agent, $"{segment.SessionId}:{segment.StartSeq}-{segment.EndSeq}", "raw", segment.StartSeq, segment.EndSeq,
                segment.MessageCount, segment.Role, segment.StartTimestamp, segment.EndTimestamp, text);
            row["id"] = Text(row["message_id"]) + ":" + index;
            row["chunk_index"] = index;
            row["chunk_count"] = chunks.Count;
            row["chunk_text"] = Truncate(chunk);
            return row;
        }).ToArray();
    }

    internal static JsonObject? Block(ArchiveBlockRecord block, SqliteArchiveMessageStore store)
    {
        var text = Trim(block.Summary);
        if (text.Length == 0)
            return null;
        var messages = store.ReadMessagesRange(block.RawStartSeq, block.RawEndSeq);
        var first = messages.FirstOrDefault()?.Timestamp ?? block.CreatedAt;
        if (first == 0)
            first = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var last = messages.LastOrDefault()?.Timestamp ?? first;
        var row = Common(block.SessionId, block.Agent, $"{block.SessionId}:block:{block.Id}", "block", block.RawStartSeq, block.RawEndSeq,
            checked((int)Math.Max(1, block.RawEndSeq - block.RawStartSeq + 1)), "model", first, last == 0 ? first : last, text);
        row["block_id"] = block.Id;
        row["block_level"] = block.Level;
        row["source_kind"] = block.SourceKind;
        row["source_start"] = block.SourceStart;
        row["source_end"] = block.SourceEnd;
        return row;
    }

    internal static IReadOnlyList<JsonObject> Facts(ArchiveBlockRecord block)
    {
        var result = new List<JsonObject>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var fact in block.MemoryFacts?.OfType<JsonObject>() ?? [])
        {
            var text = Trim(Text(fact["text"]));
            if (text.Length == 0 || block.RawStartSeq <= 0 || block.RawEndSeq <= 0)
                continue;
            var kind = Text(fact["kind"]);
            var normalized = Regex.Replace(text, @"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+", " ");
            var hash = Hash(kind + "\0" + Lower(normalized))[..24];
            var id = $"{block.SessionId}:fact:B{block.Id}:{hash}";
            if (!seen.Add(id))
                continue;
            var attribution = SessionWait.Text(fact["attributedTo"]) ?? "both";
            var context = Trim(Text(fact["context"]));
            var range = block.RawStartSeq == block.RawEndSeq ? block.RawStartSeq.ToString() : $"{block.RawStartSeq}-{block.RawEndSeq}";
            var formatted = $"Memory fact ({kind})\n{text}" + (context.Length == 0 ? "" : "\nContext: " + context)
                + "\nAttribution: " + attribution + $"\nSource: CTX-BLOCK L{block.Level} B#{block.Id}, raw messages {range}";
            var row = Common(block.SessionId, block.Agent, id, "fact", block.RawStartSeq, block.RawEndSeq,
                checked((int)Math.Max(1, block.RawEndSeq - block.RawStartSeq + 1)), $"fact:{kind}:{attribution}", block.CreatedAt, block.CreatedAt, formatted);
            row["block_id"] = block.Id;
            row["block_level"] = block.Level;
            row["source_kind"] = "memory_fact:" + kind;
            row["source_start"] = block.RawStartSeq;
            row["source_end"] = block.RawEndSeq;
            result.Add(row);
        }
        return result;
    }
}
