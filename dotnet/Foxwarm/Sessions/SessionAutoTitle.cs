using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

// Pure selection and normalization for automatic Session titles. Main owns the
// request and the conditional catalog write in SessionManager.AutoTitle.cs.
internal static class SessionAutoTitle
{
    internal const string JournalPurpose = "background";
    internal const string Effort = "low";
    internal const string CacheLineage = "session-title";
    internal const int MaxInputCharacters = 2000;

    // Display width with East Asian wide characters counted as two columns.
    internal const int MaxWidth = 40;

    internal const string Instructions = """
        You write short titles for conversations shown in a chat sidebar.
        Read the first exchange below and reply with only a title that names its topic or task.
        Write the title in the same language as the user's message.
        Use at most 6 words, or at most 12 characters for Chinese, Japanese or Korean.
        Do not use quotation marks, ending punctuation, emoji or a prefix such as "Title:".
        Do not answer, continue or comment on the conversation.
        """;

    private const string DirectInputPrefix = "<foxwarm-message type=\"channel\"";

    internal sealed class OwnerState
    {
        // No turn has started in this owner lifetime yet, so nothing qualifies.
        private long turnStartSeq = long.MaxValue;
        private int settled;

        internal long TurnStartSeq => Interlocked.Read(ref turnStartSeq);
        internal bool Settled => Volatile.Read(ref settled) != 0;

        // Test observation of the detached request; not a completion contract.
        internal Task? Pending { get; set; }

        internal void TurnStarting(long nextMessageSeq) =>
            Interlocked.Exchange(ref turnStartSeq, nextMessageSeq);

        internal bool Settle() => Interlocked.Exchange(ref settled, 1) == 0;
    }

    internal enum Outcome
    {
        // Not decidable yet: no direct input or no text reply after it.
        Pending,

        // Permanently not titled automatically from this owner lifetime.
        Ineligible,
        Ready,
    }

    internal sealed record Exchange(string UserText, string ReplyText);

    internal sealed record Selection(Outcome Outcome, Exchange? Exchange = null);

    // The completed turn qualifies when the Session's first input is a direct user
    // message and the first assistant text after that input was committed by this
    // turn (seq at or after turnStartSeq). Rows before the first input, such as a
    // prepared greeting, are not part of the exchange.
    internal static Selection Select(IReadOnlyList<HistoryMessage> history, long turnStartSeq)
    {
        var first = -1;
        for (var index = 0; index < history.Count; index++)
        {
            var row = history[index].Data;
            if (HistoryMessage.Text(row, "role") != "user")
                continue;
            var kind = InputKind(row);
            if (kind == RowKind.Metadata)
                continue;
            if (kind == RowKind.OtherInput)
                return new(Outcome.Ineligible);
            first = index;
            break;
        }
        if (first < 0)
            return new(Outcome.Pending);
        string? reply = null;
        for (var index = first + 1; index < history.Count; index++)
        {
            var message = history[index];
            if (!IsReply(message))
                continue;
            var text = ReplyText(message.Data);
            if (text.Length == 0)
                continue;
            if (message.Sequence is not { } seq || seq < turnStartSeq)
                return new(Outcome.Ineligible);
            reply = text;
        }
        if (reply is null)
            return new(Outcome.Pending);
        return new(Outcome.Ready, new(Clip(UserText(history[first].Data)), Clip(reply)));
    }

    internal static JsonObject RequestMessage(Exchange exchange)
    {
        var text = new StringBuilder();
        text.Append("<conversation>\n");
        if (exchange.UserText.Length > 0)
            text.Append("User:\n").Append(exchange.UserText).Append("\n\n");
        text.Append("Assistant:\n").Append(exchange.ReplyText).Append("\n</conversation>");
        return new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text.ToString() }),
        };
    }

    internal static string AssistantText(JsonObject? message) =>
        string.Concat(
            (message?["parts"] as JsonArray ?? [])
                .OfType<JsonObject>()
                .Where(part => part["thinking"] is null && part["functionCall"] is null)
                .Select(part => SessionWait.Text(part["text"]) ?? "")
        );

    // Returns a single-line title within MaxWidth, or null when nothing usable remains.
    internal static string? Normalize(string? raw)
    {
        if (raw is null)
            return null;
        var line = raw.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Split('\n')
            .Select(value => value.Trim())
            .FirstOrDefault(value => value.Length > 0);
        if (line is null)
            return null;
        var builder = new StringBuilder(line.Length);
        var space = false;
        foreach (var character in line)
        {
            if (char.IsWhiteSpace(character) || char.IsControl(character))
            {
                space = builder.Length > 0;
                continue;
            }
            if (space)
                builder.Append(' ');
            builder.Append(character);
            space = false;
        }
        var title = builder.ToString();
        string previous;
        do
        {
            previous = title;
            title = title.TrimStart('#', '*', '_', '>', '-', ' ').Trim();
            foreach (
                var prefix in new[] { "title:", "title：", "标题：", "标题:", "標題：", "標題:" }
            )
                if (title.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    title = title[prefix.Length..].Trim();
            title = title.Trim(
                '"',
                '\'',
                '`',
                '*',
                '_',
                '“',
                '”',
                '‘',
                '’',
                '「',
                '」',
                '『',
                '』',
                '《',
                '》',
                ' '
            );
            title = title.TrimEnd('.', '。', '!', '！', ',', '，', ';', '；', ':', '：', '、', ' ');
        } while (title != previous);
        if (title.Length == 0)
            return null;
        return Truncate(title, MaxWidth);
    }

    internal static int Width(string text)
    {
        var width = 0;
        var elements = StringInfo.GetTextElementEnumerator(text);
        while (elements.MoveNext())
            width += ElementWidth((string)elements.Current);
        return width;
    }

    private static string Truncate(string title, int maxWidth)
    {
        if (Width(title) <= maxWidth)
            return title;
        var builder = new StringBuilder();
        var width = 0;
        var elements = StringInfo.GetTextElementEnumerator(title);
        while (elements.MoveNext())
        {
            var element = (string)elements.Current;
            var next = ElementWidth(element);
            // Reserve one column for the ellipsis.
            if (width + next > maxWidth - 1)
                break;
            builder.Append(element);
            width += next;
        }
        return builder.ToString().TrimEnd() + "…";
    }

    private static int ElementWidth(string element)
    {
        var code = char.ConvertToUtf32(element, 0);
        return code switch
        {
            >= 0x1100 and <= 0x115F => 2,
            >= 0x2E80 and <= 0xA4CF => 2,
            >= 0xAC00 and <= 0xD7A3 => 2,
            >= 0xF900 and <= 0xFAFF => 2,
            >= 0xFE30 and <= 0xFE4F => 2,
            >= 0xFF00 and <= 0xFF60 => 2,
            >= 0xFFE0 and <= 0xFFE6 => 2,
            >= 0x1F300 and <= 0x1FAFF => 2,
            >= 0x20000 and <= 0x3FFFD => 2,
            _ => 1,
        };
    }

    private enum RowKind
    {
        Metadata,
        DirectInput,
        OtherInput,
    }

    private static RowKind InputKind(JsonElement row)
    {
        if (!row.TryGetProperty("parts", out var parts) || parts.ValueKind != JsonValueKind.Array)
            return RowKind.Metadata;
        foreach (var part in parts.EnumerateArray())
        {
            if (part.ValueKind != JsonValueKind.Object)
                continue;
            if (part.TryGetProperty("functionResponse", out _))
                return RowKind.Metadata;
            if (HistoryMessage.Text(part, "system") is { } system)
            {
                var trimmed = system.TrimStart();
                if (trimmed.StartsWith(DirectInputPrefix, StringComparison.Ordinal))
                    return RowKind.DirectInput;
                if (
                    trimmed.StartsWith("<foxwarm-message", StringComparison.Ordinal)
                    || trimmed.StartsWith(
                        "<foxwarm-system kind=\"external-input\"",
                        StringComparison.Ordinal
                    )
                    || trimmed.StartsWith(
                        "<foxwarm-system kind=\"event\"",
                        StringComparison.Ordinal
                    )
                )
                    return RowKind.OtherInput;
                // Session tags, channel modes and other notices describe an input; they are not one.
                continue;
            }
            if (part.TryGetProperty("thinking", out _))
                continue;
            if (HistoryMessage.Text(part, "text") is { } text && text.Trim().Length == 0)
                continue;
            // Unwrapped content comes from internal submissions such as a fork's initial message.
            return RowKind.OtherInput;
        }
        return RowKind.Metadata;
    }

    private static bool IsReply(HistoryMessage message)
    {
        if (message.Role is not ("model" or "assistant") || !message.IsModelVisible)
            return false;
        return !(
            message.Data.TryGetProperty("__meta", out var meta)
            && meta.ValueKind == JsonValueKind.Object
            && meta.TryGetProperty("noticeType", out var notice)
            && notice.ValueKind != JsonValueKind.Null
        );
    }

    private static string ReplyText(JsonElement row)
    {
        if (!row.TryGetProperty("parts", out var parts) || parts.ValueKind != JsonValueKind.Array)
            return "";
        var text = new StringBuilder();
        foreach (var part in parts.EnumerateArray())
        {
            if (
                part.ValueKind != JsonValueKind.Object
                || part.TryGetProperty("thinking", out _)
                || part.TryGetProperty("functionCall", out _)
            )
                continue;
            if (HistoryMessage.Text(part, "text") is { } value)
                text.Append(value);
        }
        return text.ToString().Trim();
    }

    private static string UserText(JsonElement row)
    {
        var text = new StringBuilder();
        foreach (var part in row.GetProperty("parts").EnumerateArray())
        {
            if (part.ValueKind != JsonValueKind.Object)
                continue;
            if (HistoryMessage.Text(part, "system") is { } system)
            {
                var trimmed = system.TrimStart();
                if (!trimmed.StartsWith(DirectInputPrefix, StringComparison.Ordinal))
                    continue;
                // Attribute values escape '>', so the first one closes the opening tag.
                var body = trimmed[(trimmed.IndexOf('>') + 1)..];
                const string closing = "</foxwarm-message>";
                if (body.TrimEnd().EndsWith(closing, StringComparison.Ordinal))
                    body = body.TrimEnd()[..^closing.Length];
                Append(body);
                continue;
            }
            if (part.TryGetProperty("thinking", out _))
                continue;
            if (HistoryMessage.Text(part, "text") is { } value)
                Append(value);
        }
        return text.ToString().Trim();

        void Append(string value)
        {
            value = value.Trim();
            if (value.Length == 0)
                return;
            if (text.Length > 0)
                text.Append('\n');
            text.Append(value);
        }
    }

    private static string Clip(string text)
    {
        if (text.Length <= MaxInputCharacters)
            return text;
        var end = MaxInputCharacters;
        if (char.IsHighSurrogate(text[end - 1]))
            end--;
        return text[..end] + "…";
    }
}
