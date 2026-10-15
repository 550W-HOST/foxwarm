using System.Collections;
using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>An owned immutable history record. Mutable projections are explicit.</summary>
public sealed class HistoryMessage
{
    public JsonElement Data { get; }
    public string? Role => Text(Data, "role");
    public long? Sequence =>
        Data.TryGetProperty("__meta", out var meta)
        && meta.ValueKind == JsonValueKind.Object
        && meta.TryGetProperty("seq", out var seq)
            ? Integer(seq)
            : null;
    public bool IsModelVisible =>
        !Data.TryGetProperty("modelVisible", out var visible)
        || visible.ValueKind != JsonValueKind.False;

    private HistoryMessage(JsonElement owned) => Data = owned;

    public static HistoryMessage FromJson(JsonObject input) =>
        new(JsonSerializer.SerializeToElement(input));

    public static HistoryMessage FromElement(JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("History record must be an object.", nameof(input));
        return new(input.Clone());
    }

    public JsonObject ToJson() => JsonObject.Create(Data)!;

    public string ToJsonString() => Data.GetRawText();

    internal bool ContentEquals(HistoryMessage other) =>
        ReferenceEquals(this, other) || JsonElement.DeepEquals(Data, other.Data);

    internal static long? Integer(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Number)
            return null;
        if (value.TryGetInt64(out var integer))
            return integer;
        var real = value.GetDouble();
        return
            double.IsFinite(real)
            && real >= long.MinValue
            && real <= long.MaxValue
            && Math.Truncate(real) == real
            ? (long)real
            : null;
    }

    internal static string? Text(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

/// <summary>A persistent history root; unchanged records and tree branches are shared.</summary>
public sealed class SessionHistory : IReadOnlyList<HistoryMessage>
{
    private readonly ImmutableList<HistoryMessage> messages;
    public static SessionHistory Empty { get; } = new(ImmutableList<HistoryMessage>.Empty);
    public int Count => messages.Count;
    public HistoryMessage this[int index] => messages[index];

    private SessionHistory(ImmutableList<HistoryMessage> messages) => this.messages = messages;

    public static SessionHistory FromJson(IEnumerable<JsonObject> messages) =>
        new(ImmutableList.CreateRange(messages.Select(HistoryMessage.FromJson)));

    public static SessionHistory FromMessages(IEnumerable<HistoryMessage> messages) =>
        messages is SessionHistory history ? history : new(ImmutableList.CreateRange(messages));

    public SessionHistory Append(IEnumerable<HistoryMessage> appended) =>
        new(messages.AddRange(appended));

    public SessionHistory AppendJson(IEnumerable<JsonObject> appended) =>
        Append(appended.Select(HistoryMessage.FromJson));

    public SessionHistory Replace(int index, HistoryMessage message) =>
        new(messages.SetItem(index, message));

    public JsonObject[] Materialize() => messages.Select(message => message.ToJson()).ToArray();

    public IEnumerator<HistoryMessage> GetEnumerator() => messages.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

/// <summary>The gate-owned mutable reference to a persistent history root.</summary>
public sealed class SessionHistoryBuffer : IReadOnlyList<HistoryMessage>
{
    private SessionHistory history = SessionHistory.Empty;
    public int Count => history.Count;
    public HistoryMessage this[int index] => history[index];

    public SessionHistory Snapshot() => history;

    public void Reset(SessionHistory value) => history = value;

    public void Clear() => history = SessionHistory.Empty;

    public void Add(JsonObject message) => Add(HistoryMessage.FromJson(message));

    public void Add(HistoryMessage message) => history = history.Append([message]);

    public void AddRange(IEnumerable<JsonObject> messages) =>
        history = history.AppendJson(messages);

    public void AddRange(IEnumerable<HistoryMessage> messages) =>
        history = history.Append(messages);

    public void Replace(int index, HistoryMessage message) =>
        history = history.Replace(index, message);

    public int FindIndex(Predicate<HistoryMessage> predicate)
    {
        for (var index = 0; index < Count; index++)
            if (predicate(this[index]))
                return index;
        return -1;
    }

    public IEnumerator<HistoryMessage> GetEnumerator() => history.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
