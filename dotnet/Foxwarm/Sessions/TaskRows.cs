using System.Globalization;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>How a <see cref="ITaskRowStore.Run{T}"/> body reaches the rows.</summary>
internal enum TaskRowAccess
{
    /// <summary>Independent statements with no transaction spanning the callback.</summary>
    Direct,

    /// <summary>One read transaction with a consistent snapshot.</summary>
    Read,

    /// <summary>One write transaction that excludes other writers from its start.</summary>
    Write,
}

/// <summary>
/// Which Tasks a list reads: by status (open and active when null), optionally limited to
/// Tasks created by or owned by the given Session references, or only owned by them.
/// </summary>
internal sealed record TaskListFilter(
    string? Status,
    IReadOnlyList<string>? ScopeIds,
    bool OwnedOnly
);

/// <summary>
/// Row storage for <see cref="TaskStore"/>, which owns every Task rule. Rows are JSON objects
/// with the stored column names; text columns are strings, integer columns are longs, and
/// absent values are null. A storage implementation adds no rules of its own.
/// </summary>
internal interface ITaskRowStore : IDisposable
{
    /// <summary>Whether any Task storage exists yet; reads may skip work when it doesn't.</summary>
    bool Exists { get; }

    /// <summary>
    /// Runs <paramref name="body"/> with row access. A thrown exception rolls back a
    /// transaction; a normal return commits it.
    /// </summary>
    T Run<T>(TaskRowAccess access, Func<ITaskRows, T> body);
}

internal interface ITaskRows
{
    /// <summary>Every column of one Task, or null.</summary>
    JsonObject? Read(string id);

    /// <summary>Inserts one Task from alternating column names and values.</summary>
    void Insert(params object?[] columnValues);

    /// <summary>Sets columns of one Task from alternating column names and values.</summary>
    void Update(string id, params object?[] columnValues);

    /// <summary>
    /// Sets a notification status column that is still <c>pending</c>, optionally only at the
    /// given assignment revision.
    /// </summary>
    void SettlePendingNotification(string id, string column, string status, long? revision);

    void AddNote(string taskId, string? sessionId, string authorKind, string text, long createdAt);

    /// <summary>The earliest Task migrated from a legacy goal of any of these Session references.</summary>
    string? FindLegacyGoal(IReadOnlyList<string> sessionReferences);

    /// <summary>Every column of each active Task, ordered by creation time and ID.</summary>
    List<JsonObject> ActiveTasks();

    /// <summary>
    /// Matching Tasks with id, title, status, parentTaskId, createdByKind, createdBySessionId,
    /// ownerSessionId and updatedAt, most recently updated first, then by ID.
    /// </summary>
    List<JsonObject> List(TaskListFilter filter, int limit);
    int Count(TaskListFilter filter);

    /// <summary>Child Tasks with id, title, status and ownerSessionId, by creation time and ID.</summary>
    List<JsonObject> Children(string parentId, int limit);
    int ChildCount(string parentId);

    /// <summary>The newest notes with authorKind, sessionId, text and createdAt, newest first.</summary>
    List<JsonObject> LatestNotes(string taskId, int limit);
    int NoteCount(string taskId);
}

internal static class TaskRowValues
{
    // Task columns are text and integers. Build the DOM primitive from its actual type so a
    // row clone or save never needs runtime-type serialization in a native publication.
    internal static JsonValue Value(object value) =>
        value switch
        {
            string text => JsonValue.Create(text),
            long number => JsonValue.Create(number),
            int number => JsonValue.Create((long)number),
            _ => JsonValue.Create(Convert.ToString(value, CultureInfo.InvariantCulture)),
        };
}
