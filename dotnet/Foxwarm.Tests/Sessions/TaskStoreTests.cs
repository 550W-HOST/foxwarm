using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class TaskStoreTests
{
    [Fact]
    public void LegacyGoalMigrationIsIdempotentAndContextCheckpointIsBounded()
    {
        using var temp = new TempDirectory();
        using var store = new TaskStore(temp.Path, id => id, _ => []);
        var goal = new string('g', 4000) + "-tail";
        store.MigrateLegacyGoal("main", goal, 12);
        store.MigrateLegacyGoal("main", goal, 12);
        var listed = store.Execute(new JsonObject { ["action"] = "list" }, "main");
        Assert.Single(listed.Payload["tasks"]!.AsArray());
        var loaded = store.Execute(
            new JsonObject
            {
                ["action"] = "get",
                ["taskId"] = listed.Payload["tasks"]![0]!["id"]!.GetValue<string>(),
            },
            "main"
        );
        Assert.Equal(
            goal.Length,
            loaded.Payload["task"]!["description"]!.GetValue<string>().Length
        );
        using var db = new SqliteConnection(
            $"Data Source={Path.Combine(temp.Path, "state", "tasks.sqlite")}"
        );
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = "SELECT description FROM tasks";
        Assert.Equal(goal, command.ExecuteScalar()?.ToString());
        var context = store.TaskContext(
            "main",
            Enumerable.Range(13, 40).Select(value => (long)value).ToArray(),
            false,
            []
        );
        Assert.Empty(context["tasks"]!.AsArray());
    }

    [Fact]
    public void AttachedChildRequiresCommittedOwnerAndBindsTask()
    {
        using var temp = new TempDirectory();
        using var store = new TaskStore(temp.Path, id => id, _ => []);
        var created = store.Execute(
            new JsonObject { ["action"] = "create", ["title"] = "child" },
            "parent"
        );
        var id = created.Payload["task"]!["id"]!.GetValue<string>();
        store.Execute(
            new JsonObject
            {
                ["action"] = "assign",
                ["taskId"] = id,
                ["ownerSessionId"] = "child",
            },
            "parent"
        );
        store.AttachChild(id, "child");
        var task = store
            .Execute(new JsonObject { ["action"] = "get", ["taskId"] = id }, null)
            .Payload["task"]!;
        Assert.Equal("child", task["ownerSessionId"]!.GetValue<string>());
        Assert.Equal("child", task["attachedSessionId"]!.GetValue<string>());
    }

    [Fact]
    public void TaskContextResetsNullAnchorAndCanonicalizesStoredReferences()
    {
        using var temp = new TempDirectory();
        using var store = new TaskStore(
            temp.Path,
            id => id == "old" ? "main" : id,
            id => id == "main" ? ["old"] : []
        );
        var created = store.Execute(
            new JsonObject { ["action"] = "create", ["title"] = "progress" },
            "main"
        );
        var id = created.Payload["task"]!["id"]!.GetValue<string>();
        using (
            var db = new SqliteConnection(
                $"Data Source={Path.Combine(temp.Path, "state", "tasks.sqlite")}"
            )
        )
        {
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText =
                "UPDATE tasks SET createdBySessionId='old',ownerSessionId='old',attachedSessionId='old',previousOwnerSessionId='old',status='active',reminderLastSeq=NULL,reminderMessageCount=30 WHERE id=$id";
            command.Parameters.AddWithValue("$id", id);
            command.ExecuteNonQuery();
        }

        Assert.Empty(store.TaskContext("main", [1, 2], false, [])!["tasks"]!.AsArray());
        using var verify = new SqliteConnection(
            $"Data Source={Path.Combine(temp.Path, "state", "tasks.sqlite")}"
        );
        verify.Open();
        using var read = verify.CreateCommand();
        read.CommandText =
            "SELECT createdBySessionId,ownerSessionId,attachedSessionId,previousOwnerSessionId,reminderLastSeq,reminderMessageCount FROM tasks WHERE id=$id";
        read.Parameters.AddWithValue("$id", id);
        using var row = read.ExecuteReader();
        Assert.True(row.Read());
        Assert.Equal("main", row.GetString(0));
        Assert.Equal("main", row.GetString(1));
        Assert.Equal("main", row.GetString(2));
        Assert.Equal("main", row.GetString(3));
        Assert.Equal(2L, row.GetInt64(4));
        Assert.Equal(0L, row.GetInt64(5));
    }

    [Fact]
    public void CreateClaimUpdateAndTerminalCompletionAreDurable()
    {
        using var temp = new TempDirectory();
        using var store = new TaskStore(temp.Path, id => id == "old" ? "main" : id, _ => []);
        var created = store.Execute(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "task",
                ["description"] = new string('d', 20000),
            },
            "old"
        );
        var id = created.Payload["task"]!["id"]!.GetValue<string>();
        var claimed = store.Execute(
            new JsonObject { ["action"] = "claim", ["taskId"] = id },
            "main"
        );
        Assert.Equal("active", claimed.Payload["task"]!["status"]!.GetValue<string>());
        var updated = store.Execute(
            new JsonObject
            {
                ["action"] = "update",
                ["taskId"] = id,
                ["note"] = "progress",
            },
            "main"
        );
        Assert.Equal("active", updated.Payload["task"]!["status"]!.GetValue<string>());
        var completed = store.Execute(
            new JsonObject
            {
                ["action"] = "complete",
                ["taskId"] = id,
                ["result"] = new string('r', 20000),
            },
            "main"
        );
        Assert.Equal("completed", completed.Payload["task"]!["status"]!.GetValue<string>());
        Assert.Equal(20000, completed.Payload["task"]!["description"]!.GetValue<string>().Length);
        Assert.Equal(20000, completed.Payload["task"]!["result"]!.GetValue<string>().Length);
        Assert.Throws<TaskError>(() =>
            store.Execute(new JsonObject { ["action"] = "complete", ["taskId"] = id }, "main")
        );
    }

    [Fact]
    public void NonOwnerSessionMayUpdateDescriptionAndNoteButNotStatus()
    {
        using var temp = new TempDirectory();
        using var store = new TaskStore(temp.Path, id => id, _ => []);
        var created = store.Execute(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "note",
                ["ownerSessionId"] = "owner",
            },
            "creator"
        );
        var id = created.Payload["task"]!["id"]!.GetValue<string>();
        var noted = store.Execute(
            new JsonObject
            {
                ["action"] = "update",
                ["taskId"] = id,
                ["note"] = "progress from a non-owner",
                ["notifySession"] = true,
            },
            "observer"
        );
        Assert.Equal("owner", noted.CommentOwner);
        var details = store.Execute(new JsonObject { ["action"] = "get", ["taskId"] = id }, null);
        Assert.Contains(
            details.Payload["notes"]!.AsArray(),
            note => note?["text"]?.GetValue<string>() == "progress from a non-owner"
        );
        foreach (var note in new[] { false, true })
        {
            var change = new JsonObject { ["action"] = "update", ["taskId"] = id, ["description"] = "shared scope" };
            if (note) change["note"] = "shared progress";
            store.Execute(change, "observer");
        }
        using (var reopened = new TaskStore(temp.Path, value => value, _ => []))
            Assert.Equal("shared scope", reopened.Execute(new JsonObject { ["action"] = "get", ["taskId"] = id }, "observer").Payload["task"]!["description"]!.GetValue<string>());
        foreach (var status in new JsonNode?[] { JsonValue.Create("active"), null })
            Assert.Throws<TaskError>(() => store.Execute(new JsonObject { ["action"] = "update", ["taskId"] = id, ["description"] = "not permitted", ["status"] = status }, "observer"));
        store.Execute(new JsonObject { ["action"] = "complete", ["taskId"] = id }, "owner");
        Assert.Throws<TaskError>(() => store.Execute(new JsonObject { ["action"] = "update", ["taskId"] = id, ["description"] = "terminal" }, "observer"));
    }

    [Fact]
    public void AssignmentAndNotificationArgumentsMatchSourceValidation()
    {
        using var temp = new TempDirectory();
        using var store = new TaskStore(temp.Path, id => id, _ => []);

        foreach (JsonNode? invalid in new JsonNode?[] { null, new JsonObject(), new JsonArray() })
        {
            Assert.Throws<TaskError>(() =>
                store.Execute(
                    new JsonObject
                    {
                        ["action"] = "create",
                        ["title"] = "invalid notify",
                        ["notifySession"] = invalid,
                    },
                    "creator"
                )
            );
        }

        var created = store.Execute(
            new JsonObject { ["action"] = "create", ["title"] = "assignment" },
            "creator"
        );
        var id = created.Payload["task"]!["id"]!.GetValue<string>();
        Assert.Throws<TaskError>(() =>
            store.Execute(new JsonObject { ["action"] = "assign", ["taskId"] = id }, "creator")
        );
        Assert.Equal(
            "open",
            store.Execute(new JsonObject { ["action"] = "get", ["taskId"] = id }, null).Payload[
                "task"
            ]!["status"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task IndependentConnectionsAllowOnlyOneSuccessfulClaim()
    {
        using var temp = new TempDirectory();
        using var first = new TaskStore(temp.Path, id => id, _ => []);
        using var second = new TaskStore(temp.Path, id => id, _ => []);
        var created = first.Execute(
            new JsonObject { ["action"] = "create", ["title"] = "race" },
            "creator"
        );
        var id = created.Payload["task"]!["id"]!.GetValue<string>();
        var results = await Task.WhenAll(
            Task.Run(() => TryClaim(first, id, "one")),
            Task.Run(() => TryClaim(second, id, "two"))
        );
        Assert.Equal(1, results.Count(value => value));
        Assert.Equal(
            "active",
            first.Execute(new JsonObject { ["action"] = "get", ["taskId"] = id }, null).Payload[
                "task"
            ]!["status"]!.GetValue<string>()
        );
    }

    private static bool TryClaim(TaskStore store, string id, string actor)
    {
        try
        {
            store.Execute(new JsonObject { ["action"] = "claim", ["taskId"] = id }, actor);
            return true;
        }
        catch (TaskError)
        {
            return false;
        }
    }

    [Fact]
    public void OpensOldSchemaAndWritesCanonicalReferencesReadableBySourceShape()
    {
        using var temp = new TempDirectory();
        var path = System.IO.Path.Combine(temp.Path, "state", "tasks.sqlite");
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        using (var db = new SqliteConnection($"Data Source={path}"))
        {
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText =
                "CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT,status TEXT NOT NULL,parentTaskId TEXT,createdBySessionId TEXT NOT NULL,ownerSessionId TEXT,result TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,completedAt INTEGER,cancelledAt INTEGER); INSERT INTO tasks VALUES('task_old','legacy',NULL,'open',NULL,'old',NULL,NULL,1,1,NULL,NULL); CREATE TABLE task_notes(id INTEGER PRIMARY KEY,taskId TEXT NOT NULL,sessionId TEXT NOT NULL,text TEXT NOT NULL,createdAt INTEGER NOT NULL);";
            command.ExecuteNonQuery();
        }
        using var store = new TaskStore(
            temp.Path,
            id => id == "old" ? "main" : id,
            id => id == "main" ? ["old"] : []
        );
        var before = store.Execute(
            new JsonObject { ["action"] = "get", ["taskId"] = "task_old" },
            null
        );
        Assert.Equal("main", before.Payload["task"]!["createdBySessionId"]!.GetValue<string>());
        store.Execute(new JsonObject { ["action"] = "claim", ["taskId"] = "task_old" }, "old");
        using var sourceShape = new SqliteConnection($"Data Source={path}");
        sourceShape.Open();
        using var read = sourceShape.CreateCommand();
        read.CommandText =
            "SELECT createdBySessionId,ownerSessionId,assignmentRevision FROM tasks WHERE id='task_old'";
        using var row = read.ExecuteReader();
        Assert.True(row.Read());
        Assert.Equal("main", row.GetString(0));
        Assert.Equal("main", row.GetString(1));
        Assert.Equal(0L, row.GetInt64(2));
    }

    private sealed class TempDirectory : IDisposable
    {
        internal string Path { get; } =
            System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "foxwarm-task-tests-" + Guid.NewGuid().ToString("N")
            );

        public TempDirectory() => Directory.CreateDirectory(Path);

        public void Dispose() => Directory.Delete(Path, true);
    }
}
