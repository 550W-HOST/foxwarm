using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

// The derived activity index of Archive tool rows, its backfill and its direct records.
public sealed class ActivityIndexTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private sealed class ScriptedChat(params JsonObject[][] turns) : IChatService
    {
        private int index;

        public Task<ChatResult> ChatAsync(
            string id,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        )
        {
            var current = Interlocked.Increment(ref index) - 1;
            var parts =
                current < turns.Length
                    ? new JsonArray(
                        turns[current]
                            .Select(call =>
                                (JsonNode)new JsonObject { ["functionCall"] = call.DeepClone() }
                            )
                            .ToArray()
                    )
                    : new JsonArray(new JsonObject { ["text"] = "done" });
            return Task.FromResult(
                new ChatResult(new JsonObject { ["role"] = "model", ["parts"] = parts })
            );
        }
    }

    private static JsonObject Call(string id, string name, JsonObject args) =>
        new()
        {
            ["id"] = id,
            ["name"] = name,
            ["args"] = args,
        };

    private sealed class Fixture : IAsyncDisposable
    {
        internal required TempDirectory Temp { get; init; }
        internal required string Work { get; init; }
        internal required SessionManager Manager { get; init; }
        internal required SessionOwner Owner { get; init; }
        internal required ToolRegistry Registry { get; init; }
        internal required Foxwarm.McpClient Mcp { get; init; }

        internal static async Task<Fixture> Create()
        {
            var temp = new TempDirectory();
            var data = Path.Combine(temp.Path, "data");
            var work = Path.Combine(temp.Path, "work");
            Directory.CreateDirectory(work);
            Directory.CreateDirectory(Path.Combine(data, "state"));
            await File.WriteAllTextAsync(
                Path.Combine(data, "state", "tool-authorization.yaml"),
                "version: 1\ndefaultAction: allow\nrules:\n"
                    + "- id: no-secret\n  action: deny\n  match:\n    tool: {source: node, name: write}\n    args: {filePath: secret.txt}\n"
            );
            var manager = new SessionManager(data, work, Options, HostModels.ForTest(Options));
            await manager.LoadAsync();
            var owner = await manager.CreateNamedAsync("main", "effects", null, null);
            var mcp = new Foxwarm.McpClient(data);
            var definitions = LocalExecManager.Definitions();
            foreach (var definition in ToolScriptToolDefinitions.Definitions())
                definitions.Add(definition?.DeepClone());
            foreach (var definition in WorkspaceTools.Definitions())
                definitions.Add(definition?.DeepClone());
            var registry = SessionToolExecutor.CreateRegistry(definitions, mcp, _ => work);
            return new Fixture
            {
                Temp = temp,
                Work = work,
                Manager = manager,
                Owner = owner,
                Registry = registry,
                Mcp = mcp,
            };
        }

        internal async Task TurnAsync(params JsonObject[][] turns)
        {
            var tools = new SessionToolExecutor(new WorkspaceTools(Work), Owner, Manager, Registry);
            var host = new LocalSessionTurnHost(
                Owner.Entry,
                Owner.Registry.Store,
                new ScriptedChat(turns),
                tools
            );
            Assert.True(await host.TryClaimBusyAsync());
            await host.ChatAsync("turn");
            await host.ReleaseBusyAsync();
        }

        internal SqliteConnection Open()
        {
            var connection = new SqliteConnection(
                new SqliteConnectionStringBuilder
                {
                    DataSource = Manager.ArchiveDatabase,
                    Pooling = false,
                }.ToString()
            );
            connection.Open();
            return connection;
        }

        internal long Count(string table)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = $"SELECT count(*) FROM {table}";
            return (long)command.ExecuteScalar()!;
        }

        internal void Execute(string sql)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = sql;
            command.ExecuteNonQuery();
        }

        public async ValueTask DisposeAsync()
        {
            await Mcp.DisposeAsync();
            await Manager.ShutdownAsync();
            await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    private static JsonObject[] Items(JsonObject page) =>
        page["items"]!.AsArray().OfType<JsonObject>().ToArray();

    private static string? Text(JsonNode? value) => SessionWait.Text(value);

    private static async Task<Fixture> WithHistory()
    {
        if (!LocalExecManager.IsSupported || OperatingSystem.IsWindows())
            return null!;
        var f = await Fixture.Create();
        f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await f.TurnAsync([
            Call("exec", "exec", new JsonObject { ["command"] = "true" }),
            Call("note", "write", new JsonObject { ["filePath"] = "note.txt", ["content"] = "x" }),
            Call(
                "secret",
                "write",
                new JsonObject { ["filePath"] = "secret.txt", ["content"] = "x" }
            ),
            Call("look", "read", new JsonObject { ["filePath"] = "note.txt" }),
            Call(
                "script",
                "run_script",
                new JsonObject
                {
                    ["code"] =
                        "call_tool('write', {'filePath': 'from-script.txt', 'content': 'y'})\nreturn 1\n",
                }
            ),
        ]);
        return f;
    }

    [Fact]
    public async Task Live_tool_rows_are_indexed_with_target_rules_and_changes_hide_reads()
    {
        await using var f = await WithHistory();
        if (f is null)
            return;
        var all = Items(f.Manager.Activity.Query(new ActivityQuery(Kind: "all")));
        Assert.Equal(6, all.Length);
        var exec = all.Single(row => Text(row["tool"]) == "exec");
        Assert.Equal("node", Text(exec["source"]));
        Assert.Equal("master", Text(exec["node"]));
        Assert.Equal("exec", Text(exec["kind"]));
        Assert.Equal("ok", Text(exec["outcome"]));
        Assert.Equal("effects", Text(exec["sessionId"]));
        Assert.Equal("main", Text(exec["agent"]));
        Assert.Equal("main", Text(exec["currentAgent"]));
        Assert.Equal("true", Text(exec["summary"]));
        Assert.NotNull(exec["refs"]?["execId"]);

        var denied = all.Single(row => Text(row["summary"])?.Contains("secret.txt") == true);
        Assert.Equal("denied", Text(denied["outcome"]));
        Assert.Equal("tool_authorization_denied", Text(denied["errorType"]));
        Assert.Contains(
            denied["rules"]!.AsArray(),
            rule => Text(rule?["id"]) == "no-secret" && Text(rule?["effect"]) == "deny"
        );

        var sub = all.Single(row => Text(row["summary"])?.Contains("from-script.txt") == true);
        Assert.Equal("write", Text(sub["tool"]));
        Assert.Equal("master", Text(sub["node"]));
        Assert.Equal(1, sub["sub"]!.GetValue<long>());
        Assert.Equal("files", Text(sub["kind"]));

        // The default view shows changes: no reads and no script containers.
        var changes = Items(f.Manager.Activity.Query(new ActivityQuery()));
        Assert.DoesNotContain(changes, row => Text(row["kind"]) is "read" or "script");
        Assert.Equal(4, changes.Length);
        Assert.Single(Items(f.Manager.Activity.Query(new ActivityQuery(Outcome: "problems"))));
        Assert.Single(Items(f.Manager.Activity.Query(new ActivityQuery(Kind: "read"))));
        Assert.Equal(
            2,
            Items(f.Manager.Activity.Query(new ActivityQuery(Kind: "all", Text: "note.txt"))).Length
        );

        // Newest-first paging covers every row once.
        var seen = new List<string>();
        long? beforeTime = null;
        string? beforeKey = null;
        while (true)
        {
            var page = f.Manager.Activity.Query(
                new ActivityQuery(
                    Kind: "all",
                    Limit: 2,
                    BeforeTime: beforeTime,
                    BeforeKey: beforeKey
                )
            );
            seen.AddRange(Items(page).Select(row => Text(row["key"])!));
            if (page["hasMore"]!.GetValue<bool>() is false)
                break;
            beforeTime = page["next"]!["beforeTime"]!.GetValue<long>();
            beforeKey = Text(page["next"]!["beforeKey"]);
        }
        Assert.Equal(all.Select(row => Text(row["key"])!), seen);
    }

    [Fact]
    public async Task Backfill_rebuilds_a_missing_or_emptied_index_resumes_from_checkpoints_and_never_fails_archive_writes()
    {
        await using var f = await WithHistory();
        if (f is null)
            return;
        var expected = Items(f.Manager.Activity.Query(new ActivityQuery(Kind: "all")))
            .ToDictionary(row => Text(row["key"])!, row => row.ToJsonString());
        Assert.Equal(6, expected.Count);

        // A removed index: later Archive writes still commit, and the backfill rebuilds it.
        f.Execute($"DROP TABLE {ArchiveToolEffects.Table}");
        await f.TurnAsync([Call("later", "exec", new JsonObject { ["command"] = "true" })]);
        Assert.Contains(f.Owner.History(), row => row.ToJsonString().Contains("\"later\""));
        await f.Manager.Activity.BackfillAsync(CancellationToken.None, batchSize: 1);
        var rebuilt = Items(f.Manager.Activity.Query(new ActivityQuery(Kind: "all")));
        Assert.Equal(7, rebuilt.Length);
        foreach (var (key, json) in expected)
            Assert.Equal(json, rebuilt.Single(row => Text(row["key"]) == key).ToJsonString());
        Assert.True(f.Manager.Activity.Coverage()["complete"]!.GetValue<bool>());

        // An emptied index while its checkpoints claim coverage also starts over.
        f.Execute($"DELETE FROM {ArchiveToolEffects.Table}");
        await f.Manager.Activity.BackfillAsync(CancellationToken.None);
        Assert.Equal(7, Items(f.Manager.Activity.Query(new ActivityQuery(Kind: "all"))).Length);

        // A cancelled pass keeps its checkpoint; the next pass resumes and completes.
        f.Execute($"DROP TABLE {ArchiveToolEffects.Table}");
        using (var cancel = new CancellationTokenSource())
        {
            var passes = 0;
            void Count() => passes++;
            f.Manager.Activity.Changed += Count;
            f.Manager.Activity.ChangeDelay = TimeSpan.Zero;
            cancel.CancelAfter(TimeSpan.FromMilliseconds(1));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                f.Manager.Activity.BackfillAsync(cancel.Token, batchSize: 1)
            );
            f.Manager.Activity.Changed -= Count;
        }
        await f.Manager.Activity.BackfillAsync(CancellationToken.None, batchSize: 1);
        Assert.Equal(7, f.Count(ArchiveToolEffects.Table));

        // A shape version change drops and rebuilds the derived rows.
        f.Execute(
            $"UPDATE {ArchiveToolEffects.MetadataTable} SET value=0 WHERE key='{ArchiveToolEffects.VersionKey}'"
        );
        f.Execute($"UPDATE {ArchiveToolEffects.Table} SET summary='stale'");
        await f.Manager.Activity.BackfillAsync(CancellationToken.None);
        Assert.DoesNotContain(
            Items(f.Manager.Activity.Query(new ActivityQuery(Kind: "all"))),
            row => Text(row["summary"]) == "stale"
        );
    }

    [Fact]
    public async Task Rolled_back_archive_rows_take_their_index_rows_with_them()
    {
        await using var f = await WithHistory();
        if (f is null)
            return;
        var store = f.Owner.Archive;
        var tool = store.ReadMessages().Last(record => record.Role == "tool");
        store.RollbackInsertedMessages([tool]);
        Assert.DoesNotContain(
            Items(f.Manager.Activity.Query(new ActivityQuery(Kind: "all"))),
            row => row["seq"]?.GetValue<long>() == tool.Seq
        );
    }

    [Fact]
    public async Task Unattended_script_calls_are_recorded_directly_with_their_origin()
    {
        await using var f = await WithHistory();
        if (f is null)
            return;
        var tools = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            f.Owner,
            f.Manager,
            f.Registry,
            unattended: true,
            unattendedOrigin: "timer"
        );
        await tools.ExecuteAsync(
            Call(
                "",
                "run_script",
                new JsonObject
                {
                    ["code"] =
                        "call_tool('write', {'filePath': 'quiet.txt', 'content': 'z'})\nreturn 1\n",
                }
            ),
            CancellationToken.None
        );
        await f.Manager.Activity.PendingDirect;
        var quiet = Assert.Single(
            Items(f.Manager.Activity.Query(new ActivityQuery(Origin: "timer-script")))
        );
        Assert.Equal("write", Text(quiet["tool"]));
        Assert.Equal("master", Text(quiet["node"]));
        Assert.Equal("effects", Text(quiet["sessionId"]));
        Assert.Equal("timer", Text(quiet["initiator"]?["kind"]));
        Assert.StartsWith("tsr_", Text(quiet["runId"]));
        Assert.Null(quiet["seq"]);
        Assert.True(File.Exists(Path.Combine(f.Work, "quiet.txt")));

        // Direct rows are not derived, so a rebuild keeps them.
        f.Execute($"DROP TABLE {ArchiveToolEffects.Table}");
        await f.Manager.Activity.BackfillAsync(CancellationToken.None);
        Assert.Single(Items(f.Manager.Activity.Query(new ActivityQuery(Origin: "timer-script"))));
    }

    [Fact]
    public void Initiators_come_from_sender_records_and_trusted_wrappers()
    {
        JsonObject Message(string? system, JsonObject? sender = null)
        {
            var message = new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["system"] = system ?? "" }),
            };
            if (sender is not null)
                message["__meta"] = new JsonObject { ["sender"] = sender };
            return message;
        }
        var admin = ArchiveToolEffects.Initiator(1, Message(null, InputSender.Administrator()))!;
        Assert.Equal(("administrator", null), (admin.Kind, admin.Id));
        var alice = ArchiveToolEffects.Initiator(1, Message(null, InputSender.Identity("alice")))!;
        Assert.Equal(("identity", "alice"), (alice.Kind, alice.Id));
        var child = ArchiveToolEffects.Initiator(
            2,
            Message(
                "<foxwarm-message type=\"inter-agent\" sourceSessionId=\"lead\" time=\"t\">\nhi\n</foxwarm-message>"
            )
        )!;
        Assert.Equal(("session", "lead"), (child.Kind, child.Id));
        var timer = ArchiveToolEffects.Initiator(
            3,
            Message(
                "<foxwarm-message type=\"timer\" timerId=\"tmr_1\" mode=\"once\">\nx\n</foxwarm-message>"
            )
        )!;
        Assert.Equal(("timer", "tmr_1"), (timer.Kind, timer.Id));
        var hook = ArchiveToolEffects.Initiator(
            4,
            Message("<foxwarm-system kind=\"external-input\" webhook=\"deploy\" />")
        )!;
        Assert.Equal(("webhook", "deploy"), (hook.Kind, hook.Id));
        // Background notices are not initiators.
        Assert.Null(
            ArchiveToolEffects.Initiator(
                5,
                Message("<foxwarm-system kind=\"event\" type=\"background-process-finished\" />")
            )
        );
    }

    [Fact]
    public void Kind_classification_in_sql_matches_the_code_table()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        connection.Open();
        var cases = new (string? Source, string Tool, string? Action)[]
        {
            ("node", "exec", null),
            ("node", "write", null),
            ("node", "read", null),
            ("builtin", "node", "list"),
            ("builtin", "node", "create"),
            ("builtin", "task", "complete"),
            ("builtin", "send_to_session", null),
            ("builtin", "set_config", null),
            ("builtin", "run_script", null),
            ("node", "browser_click", null),
            ("node", "browser_read", null),
            ("mcp", "exec", null),
            (null, "something_new", null),
            ("builtin", "wait", null),
        };
        foreach (var (source, tool, action) in cases)
        {
            using var command = connection.CreateCommand();
            command.CommandText =
                $"SELECT {ActivityKinds.Sql} FROM (SELECT $source source,$tool tool,$action action)";
            command.Parameters.AddWithValue("$source", (object?)source ?? DBNull.Value);
            command.Parameters.AddWithValue("$tool", tool);
            command.Parameters.AddWithValue("$action", (object?)action ?? DBNull.Value);
            Assert.Equal(ActivityKinds.Of(source, tool, action), (string)command.ExecuteScalar()!);
        }
        Assert.Equal("nodes", ActivityKinds.Of("builtin", "node", "create"));
        Assert.Equal("read", ActivityKinds.Of("builtin", "node", "list"));
        Assert.Equal("mcp", ActivityKinds.Of("mcp", "exec", null));
        Assert.Equal("browser", ActivityKinds.Of("node", "browser_click", null));
    }
}
