using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Xunit;

namespace Foxwarm.Tests.Storage;

// TaskStore owns the Task rules; a row store only stores rows. The same action sequence over the
// SQLite rows and over test-only in-memory rows must produce the same results.
public sealed class TaskRowStoreTests
{
    [Fact]
    public void Rules_produce_the_same_results_over_sqlite_and_memory_rows()
    {
        var root = Path.Combine(Path.GetTempPath(), "foxwarm-task-rows-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var sqlite = new TaskStore(root, id => id, _ => []);
            using var memory = new TaskStore(new MemoryTaskRows(), id => id, _ => []);
            Assert.Equal(Run(sqlite), Run(memory));
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    private static string Run(TaskStore store)
    {
        var results = new JsonArray();
        var ids = new Dictionary<string, string>(StringComparer.Ordinal);
        string Record(TaskStoreResult result)
        {
            var payload = (JsonObject)result.Payload.DeepClone();
            // Equal update times leave list order to random Task IDs.
            if (payload["tasks"] is JsonArray listed)
                payload["tasks"] = new JsonArray(
                    listed
                        .Select(item => item!.DeepClone())
                        .OrderBy(item => item["title"]?.GetValue<string>(), StringComparer.Ordinal)
                        .ToArray()
                );
            if (payload["task"] is JsonObject task && task["id"]?.GetValue<string>() is { } id)
                ids.TryAdd(id, "T" + ids.Count);
            results.Add(payload);
            results.Add(result.Assignment?.ToString());
            results.Add(result.Completed);
            results.Add(result.CommentOwner);
            return payload["task"]?["id"]?.GetValue<string>() ?? "";
        }
        TaskStoreResult Act(string actor, JsonObject args, long? anchor = null) =>
            store.Execute(args, actor, anchorSeq: anchor);

        var parent = Record(
            Act(
                "creator",
                new JsonObject
                {
                    ["action"] = "create",
                    ["title"] = "Parent",
                    ["description"] = "Root task",
                }
            )
        );
        var child = Record(
            Act(
                "creator",
                new JsonObject
                {
                    ["action"] = "create",
                    ["title"] = "Child",
                    ["parentTaskId"] = parent,
                    ["ownerSessionId"] = "worker",
                    ["notifySession"] = true,
                },
                7
            )
        );
        Record(
            Act(
                "creator",
                new JsonObject
                {
                    ["action"] = "update",
                    ["taskId"] = child,
                    ["note"] = "First note",
                    ["notifySession"] = true,
                }
            )
        );
        Record(
            Act(
                "creator",
                new JsonObject
                {
                    ["action"] = "assign",
                    ["taskId"] = child,
                    ["ownerSessionId"] = "other",
                    ["notifySession"] = true,
                }
            )
        );
        Assert.Throws<TaskError>(() =>
            Act("worker", new JsonObject { ["action"] = "complete", ["taskId"] = child })
        );
        Record(Act("creator", new JsonObject { ["action"] = "claim", ["taskId"] = parent }, 3));
        Record(
            Act(
                "other",
                new JsonObject
                {
                    ["action"] = "update",
                    ["taskId"] = child,
                    ["status"] = "active",
                    ["note"] = "Working",
                }
            )
        );
        store.MarkNotification(child, "assignmentNotificationStatus", "delivered", 2);
        store.AttachChild(child, "other");
        var context = store.TaskContext("other", [10, 11, 12], consume: true);
        results.Add(context);
        Record(
            Act(
                "other",
                new JsonObject
                {
                    ["action"] = "complete",
                    ["taskId"] = child,
                    ["result"] = "Done",
                }
            )
        );
        Record(Act("creator", new JsonObject { ["action"] = "get", ["taskId"] = parent }));
        Record(Act("creator", new JsonObject { ["action"] = "get", ["taskId"] = child }));
        Record(
            Act(
                "creator",
                new JsonObject
                {
                    ["action"] = "list",
                    ["scope"] = "all",
                    ["status"] = "completed",
                }
            )
        );
        foreach (var scope in new[] { "current-session", "owned", "all" })
            Record(
                Act(
                    "creator",
                    new JsonObject
                    {
                        ["action"] = "list",
                        ["scope"] = scope,
                    }
                )
            );
        Assert.Throws<TaskError>(() =>
            Act("creator", new JsonObject { ["action"] = "cancel", ["taskId"] = child })
        );
        store.MigrateLegacyGoal("legacy", "Legacy goal\nwith detail", 4);
        store.MigrateLegacyGoal("legacy", "Legacy goal\nwith detail", 4);
        results.Add(store.TaskContext("legacy", [5], consume: false));
        results.Add(store.OwnerSessionId(child));
        results.Add(store.CreatorSessionId(child));
        results.Add(store.ReadStoredDescription(parent));
        results.Add(store.Summaries([parent, child, "missing"]));
        results.Add(
            new JsonArray(
                store
                    .Statuses([parent, child])
                    // Task IDs are random; their aliases follow creation order.
                    .OrderBy(pair => ids[pair.Key], StringComparer.Ordinal)
                    .Select(pair => (JsonNode?)pair.Value)
                    .ToArray()
            )
        );
        var text = results.ToJsonString();
        foreach (var (id, alias) in ids)
            text = text.Replace(id, alias, StringComparison.Ordinal);
        // Timestamps differ between runs; compare everything else.
        return System.Text.RegularExpressions.Regex.Replace(
            text,
            "\"(createdAt|updatedAt|completedAt|cancelledAt)\":\\d+",
            "\"$1\":0"
        );
    }

    // Test-only rows with the SQLite column order, defaults and value types.
    private sealed class MemoryTaskRows : ITaskRowStore, ITaskRows
    {
        private static readonly string[] Columns =
        [
            "id", "title", "description", "status", "parentTaskId", "createdByKind",
            "createdBySessionId", "ownerSessionId", "result", "createdAt", "updatedAt",
            "completedAt", "cancelledAt", "completionNotificationStatus",
            "assignmentNotificationStatus", "previousOwnerSessionId",
            "previousOwnerNotificationStatus", "assignmentRevision", "attachedSessionId",
            "legacyGoalSessionId", "reminderLastSeq", "reminderMessageCount", "ownerAssignedAt",
        ];
        private readonly List<JsonObject> tasks = [];
        private readonly List<JsonObject> notes = [];

        public bool Exists => tasks.Count > 0;

        public T Run<T>(TaskRowAccess access, Func<ITaskRows, T> body)
        {
            if (access == TaskRowAccess.Direct)
                return body(this);
            var savedTasks = tasks.Select(row => (JsonObject)row.DeepClone()).ToList();
            var savedNotes = notes.Select(row => (JsonObject)row.DeepClone()).ToList();
            try
            {
                return body(this);
            }
            catch
            {
                tasks.Clear();
                tasks.AddRange(savedTasks);
                notes.Clear();
                notes.AddRange(savedNotes);
                throw;
            }
        }

        public void Dispose() { }

        public JsonObject? Read(string id) =>
            (JsonObject?)tasks.FirstOrDefault(row => Text(row, "id") == id)?.DeepClone();

        public void Insert(params object?[] columnValues)
        {
            var row = new JsonObject();
            foreach (var column in Columns)
                row[column] = column switch
                {
                    "createdByKind" => "session",
                    "assignmentRevision" or "reminderMessageCount" => 0L,
                    _ => null,
                };
            Set(row, columnValues);
            tasks.Add(row);
        }

        public void Update(string id, params object?[] columnValues) =>
            Set(tasks.Single(row => Text(row, "id") == id), columnValues);

        public void SettlePendingNotification(
            string id,
            string column,
            string status,
            long? revision
        )
        {
            var row = tasks.FirstOrDefault(row => Text(row, "id") == id);
            if (
                row is not null
                && Text(row, column) == "pending"
                && (revision is null || row["assignmentRevision"]!.GetValue<long>() == revision)
            )
                row[column] = status;
        }

        public void AddNote(
            string taskId,
            string? sessionId,
            string authorKind,
            string text,
            long createdAt
        ) =>
            notes.Add(
                new JsonObject
                {
                    ["id"] = notes.Count + 1L,
                    ["taskId"] = taskId,
                    ["authorKind"] = authorKind,
                    ["sessionId"] = sessionId,
                    ["text"] = text,
                    ["createdAt"] = createdAt,
                }
            );

        public string? FindLegacyGoal(IReadOnlyList<string> sessionReferences) =>
            Ordered(tasks.Where(row => sessionReferences.Contains(Text(row, "legacyGoalSessionId"))))
                .Select(row => Text(row, "id"))
                .FirstOrDefault();

        public List<JsonObject> ActiveTasks() =>
            Ordered(tasks.Where(row => Text(row, "status") == "active"))
                .Select(row => (JsonObject)row.DeepClone())
                .ToList();

        public List<JsonObject> List(TaskListFilter filter, int limit) =>
            Matching(filter)
                .OrderByDescending(row => row["updatedAt"]!.GetValue<long>())
                .ThenBy(row => Text(row, "id"), StringComparer.Ordinal)
                .Take(limit)
                .Select(row =>
                    Project(
                        row,
                        "id", "title", "status", "parentTaskId", "createdByKind",
                        "createdBySessionId", "ownerSessionId", "updatedAt"
                    )
                )
                .ToList();

        public int Count(TaskListFilter filter) => Matching(filter).Count();

        public List<JsonObject> Children(string parentId, int limit) =>
            Ordered(tasks.Where(row => Text(row, "parentTaskId") == parentId))
                .Take(limit)
                .Select(row => Project(row, "id", "title", "status", "ownerSessionId"))
                .ToList();

        public int ChildCount(string parentId) =>
            tasks.Count(row => Text(row, "parentTaskId") == parentId);

        public List<JsonObject> LatestNotes(string taskId, int limit) =>
            notes
                .Where(row => Text(row, "taskId") == taskId)
                .OrderByDescending(row => row["id"]!.GetValue<long>())
                .Take(limit)
                .Select(row => Project(row, "authorKind", "sessionId", "text", "createdAt"))
                .ToList();

        public int NoteCount(string taskId) => notes.Count(row => Text(row, "taskId") == taskId);

        private IEnumerable<JsonObject> Matching(TaskListFilter filter) =>
            tasks.Where(row =>
                (
                    filter.Status is null
                        ? Text(row, "status") is "open" or "active"
                        : Text(row, "status") == filter.Status
                )
                && (
                    filter.ScopeIds is not { } scope
                    || scope.Contains(Text(row, "ownerSessionId"))
                    || !filter.OwnedOnly && scope.Contains(Text(row, "createdBySessionId"))
                )
            );

        private static IEnumerable<JsonObject> Ordered(IEnumerable<JsonObject> rows) =>
            rows.OrderBy(row => row["createdAt"]!.GetValue<long>())
                .ThenBy(row => Text(row, "id"), StringComparer.Ordinal);

        private static JsonObject Project(JsonObject row, params string[] columns)
        {
            var result = new JsonObject();
            foreach (var column in columns)
                result[column] = row[column]?.DeepClone();
            return result;
        }

        private static void Set(JsonObject row, object?[] columnValues)
        {
            for (var i = 0; i < columnValues.Length; i += 2)
                row[(string)columnValues[i]!] = columnValues[i + 1] is { } value
                    ? TaskRowValues.Value(value)
                    : null;
        }

        private static string? Text(JsonObject row, string column) =>
            row[column] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
    }
}
