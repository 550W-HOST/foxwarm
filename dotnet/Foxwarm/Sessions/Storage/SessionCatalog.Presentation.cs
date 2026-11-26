using System.Globalization;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed class SessionPresentationException(string message, string code, int status = 400)
    : InvalidOperationException(message)
{
    internal string Code { get; } = code;
    internal int Status { get; } = status;
}

internal sealed record PresentationChange(JsonObject Result, string[] ChangedIds);

internal sealed class PresentationCommittedException(PresentationChange change, Exception inner)
    : InvalidOperationException(
        "The presentation change committed, but its notification failed.",
        inner
    )
{
    internal PresentationChange Change { get; } = change;
}

internal sealed partial class SessionCatalog
{
    internal static readonly CompareInfo SidebarCollation = CultureInfo
        .GetCultureInfo("en-US")
        .CompareInfo;

    internal static int CompareSidebar(JsonObject left, JsonObject right)
    {
        var compared = Flag(left["archived"]).CompareTo(Flag(right["archived"]));
        if (compared != 0)
            return compared;
        var a = Number(left["sidebarOrder"]);
        var b = Number(right["sidebarOrder"]);
        if (a is not null && b is not null && a != b)
            return a.Value.CompareTo(b.Value);
        if (a is not null && b is null)
            return -1;
        if (a is null && b is not null)
            return 1;
        compared = (Number(right["meta"]?["lastMessageTime"]) ?? 0).CompareTo(
            Number(left["meta"]?["lastMessageTime"]) ?? 0
        );
        return compared != 0
            ? compared
            : SidebarCollation.Compare(Text(left["id"])!, Text(right["id"])!, CompareOptions.None);
    }

    public Func<JsonObject[], IDisposable>? BeforePresentationMutation { get; set; }

    private PresentationChange CommitPresentation(
        Func<(JsonObject Result, JsonObject[] Rows)> prepare
    )
    {
        PresentationChange result;
        lock (gate)
        {
            EnsureInitialized();
            Execute(db!, "BEGIN IMMEDIATE");
            try
            {
                var operation = prepare();
                using var admission = BeforePresentationMutation?.Invoke(operation.Rows);
                WriteRowsLocked(operation.Rows);
                Execute(db!, "COMMIT");
                if (operation.Rows.Length > 0)
                    revision++;
                result = new(
                    operation.Result,
                    operation.Rows.Select(row => Text(row["id"])!).ToArray()
                );
            }
            catch
            {
                Execute(db!, "ROLLBACK");
                throw;
            }
        }
        if (result.ChangedIds.Length > 0)
            try
            {
                Changed?.Invoke();
            }
            catch (Exception error)
            {
                throw new PresentationCommittedException(result, error);
            }
        return result;
    }

    public PresentationChange SetLastChannel(string id, JsonObject channel) =>
        CommitPresentation(() => SessionCatalogRules.SetLastChannel(this, id, channel));

    public PresentationChange Archive(
        string requested,
        bool archived,
        bool descendants = false,
        bool singleCommand = false
    ) =>
        CommitPresentation(() =>
            SessionCatalogRules.Archive(this, requested, archived, descendants, singleCommand)
        );

    public PresentationChange Pin(string requested, bool pinned) =>
        CommitPresentation(() => SessionCatalogRules.Pin(this, requested, pinned));

    public PresentationChange SetParent(string requested, string? parent) =>
        CommitPresentation(() => SessionCatalogRules.SetParent(this, requested, parent));

    public PresentationChange Move(string requested, JsonObject body, bool promote = false) =>
        CommitPresentation(() => SessionCatalogRules.Move(this, requested, body, promote));

    IReadOnlyList<(JsonObject Row, string? Parent)> ICatalogRowView.ResolvedRows() =>
        Rows($"SELECT {Columns} FROM session_catalog ORDER BY session_id")
            .Select(row =>
                (
                    row,
                    Text(row["parentSessionId"]) is { Length: > 0 } reference
                        ? Text(Resolve(reference)["sessionId"])
                        : null
                )
            )
            .ToArray();

    IReadOnlyList<JsonObject> ICatalogRowView.SiblingRows(string? parent, string exclude) =>
        Rows(
            $"SELECT {Columns} FROM session_catalog WHERE NULLIF(trim(parent_reference,$p0),'') IS $p1 AND session_id<>$p2 ORDER BY session_id",
            SessionCatalogRules.Spaces,
            parent,
            exclude
        );
}
