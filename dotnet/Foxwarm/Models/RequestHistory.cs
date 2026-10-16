using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// A captured request projection carries provenance only from its own immutable snapshot.
// Mutable/direct callers and request-only rows have no reusable record identity.
internal sealed class RequestHistory
{
    internal sealed record Row(JsonObject Message, HistoryMessage? Origin = null);

    internal IReadOnlyList<Row> Rows { get; }
    internal IReadOnlyList<JsonObject> Messages { get; }

    internal RequestHistory(IReadOnlyList<Row> rows)
    {
        Rows = rows;
        Messages = rows.Select(row => row.Message).ToArray();
    }

    internal static RequestHistory FromSnapshot(SessionHistory history) =>
        new(history.Select(message => new Row(message.ToJson(), message)).ToArray());

    internal static RequestHistory FromMutable(IReadOnlyList<JsonObject> history) =>
        new(history.Select(message => new Row(message)).ToArray());

    internal RequestHistory WithContext(IReadOnlyList<JsonObject> context) =>
        new(Rows.Concat(context.Select(message => new Row(message))).ToArray());
}
