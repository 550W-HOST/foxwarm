using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.Data.Sqlite;
using static Foxwarm.Tests.ActivityIndexTests;

namespace Foxwarm.Tests;

// Who started each indexed call, what reaches the model and how the derived tables recover.
public sealed class ActivityAttributionTests
{
    private static string? Text(JsonNode? value) => SessionWait.Text(value);

    private static JsonObject Sequenced(JsonObject row, long seq)
    {
        row["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = 1000 + seq };
        return row;
    }

    private static ArchiveMessageRecord Record(string session, long seq, JsonObject row) =>
        ArchiveMessageRecord.Create(session, "main", seq, 1000 + seq, Sequenced(row, seq));

    private const string Handoff =
        "<foxwarm-message type=\"inter-agent\" sourceSessionId=\"lead\" time=\"t\">\nplease look\n</foxwarm-message>";

    private static QueueItem Input(string system) =>
        new(QueueItemType.Intersession, [new JsonObject { ["system"] = system }]);

    private static QueueItem WebUi(JsonObject sender) =>
        new(
            QueueItemType.User,
            [new JsonObject { ["text"] = "go" }],
            OpenFields: InputSender.With(new JsonObject { ["userInput"] = true }, sender)
        );

    private static JsonObject Read(string id) =>
        Call(id, "read", new JsonObject { ["filePath"] = "note.txt" });

    private static async Task<ActivityIndexTests.Fixture?> Create()
    {
        if (!LocalExecManager.IsSupported || OperatingSystem.IsWindows())
            return null;
        var f = await ActivityIndexTests.Fixture.Create();
        f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await File.WriteAllTextAsync(Path.Combine(f.Work, "note.txt"), "x");
        return f;
    }

    private static JsonObject[] All(ActivityIndexTests.Fixture f, string? session = null) =>
        Items(
            f.Manager.Activity.Query(
                new ActivityQuery(
                    Kind: "all",
                    Limit: ActivityIndex.MaxLimit,
                    Sessions: session is null ? null : [session]
                )
            )
        );

    [Fact]
    public async Task The_first_turn_of_a_new_session_is_attributed_to_its_real_initiator()
    {
        await using var f = await Create();
        if (f is null)
            return;
        await f.InputAsync(Input(Handoff));
        await f.TurnAsync([Read("look")]);
        // The stored first input starts with the Session's own opening tag.
        var first = f.Owner.History().First(row => Text(row["role"]) == "user");
        Assert.Contains("kind=\"session\"", Text(first["parts"]![0]!["system"]));
        var row = Assert.Single(All(f));
        Assert.Equal("session", Text(row["initiator"]?["kind"]));
        Assert.Equal("lead", Text(row["initiator"]?["id"]));
        Assert.Equal(1, row["initiator"]?["seq"]?.GetValue<long>());
    }

    [Fact]
    public async Task Long_turns_keep_their_initiator_on_every_call()
    {
        await using var f = await Create();
        if (f is null)
            return;
        await f.InputAsync(WebUi(InputSender.Identity("alice")));
        await f.TurnAsync(
            Enumerable.Range(0, 120).Select(index => new[] { Read("r" + index) }).ToArray()
        );
        var rows = All(f);
        Assert.Equal(120, rows.Length);
        Assert.All(
            rows,
            row =>
            {
                Assert.Equal("identity", Text(row["initiator"]?["kind"]));
                Assert.Equal("alice", Text(row["initiator"]?["id"]));
            }
        );
    }

    [Fact]
    public async Task External_mcp_input_is_attributed_to_its_client_or_server_not_the_previous_sender()
    {
        await using var f = await Create();
        if (f is null)
            return;
        await f.InputAsync(WebUi(InputSender.Administrator()));
        await f.TurnAsync([Read("admin")]);
        await f.InputAsync(
            new QueueItem(
                QueueItemType.User,
                SessionBoundary.ExternalInput(
                    "<foxwarm-system kind=\"external-input\" externalId=\"ci-bot\" contextId=\"c1\">",
                    [new JsonObject { ["text"] = "run checks" }]
                )
            )
        );
        await f.TurnAsync([Read("client")]);
        await f.InputAsync(
            new QueueItem(
                QueueItemType.User,
                SessionBoundary.ExternalInput(
                    "<foxwarm-system kind=\"external-input\" server=\"ci\" endpoint=\"events\">",
                    [new JsonObject { ["text"] = "build failed" }]
                )
            )
        );
        await f.TurnAsync([Read("server")]);
        // A background notice does not start a turn of its own; it keeps the input before it.
        await f.InputAsync(
            new QueueItem(
                QueueItemType.Background,
                [
                    new JsonObject
                    {
                        ["system"] = SessionBoundary.SystemEvent(
                            "background-process-finished",
                            "x"
                        ),
                    },
                ]
            )
        );
        await f.TurnAsync([Read("background")]);
        var bySummary = All(f)
            .Select(row => (Initiator: row["initiator"], Key: Text(row["key"])))
            .Reverse()
            .Select(item => (Text(item.Initiator?["kind"]), Text(item.Initiator?["id"])))
            .ToArray();
        Assert.Equal(
            new (string?, string?)[]
            {
                ("administrator", null),
                ("mcp-client", "ci-bot"),
                ("mcp-server", "ci"),
                ("mcp-server", "ci"),
            },
            bySummary
        );
        Assert.Equal(
            2,
            Items(
                f.Manager.Activity.Query(new ActivityQuery(Kind: "all", Initiator: "mcp-server"))
            ).Length
        );
    }

    [Fact]
    public async Task Backfill_infers_initiators_of_older_rows_across_long_turns_and_batches()
    {
        await using var f = await Create();
        if (f is null)
            return;
        // Rows as earlier builds wrote them: no recorded target summary or initiator.
        var rows = new List<JsonObject>
        {
            new()
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["system"] =
                            "<foxwarm-system kind=\"session\" currentSessionId=\"effects\" />",
                    },
                    new JsonObject { ["system"] = Handoff }
                ),
            },
        };
        void Batch(string id)
        {
            rows.Add(
                new()
                {
                    ["role"] = "model",
                    ["parts"] = new JsonArray(new JsonObject { ["functionCall"] = Read(id) }),
                }
            );
            rows.Add(
                new()
                {
                    ["role"] = "tool",
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["functionResponse"] = new JsonObject
                            {
                                ["tool_use_id"] = id,
                                ["name"] = "read",
                                ["response"] = new JsonObject { ["output"] = "x" },
                            },
                        }
                    ),
                }
            );
        }
        for (var index = 0; index < 150; index++)
            Batch("old" + index);
        rows.Add(
            new()
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    SessionBoundary.ExternalInput(
                        "<foxwarm-system kind=\"external-input\" externalId=\"ci-bot\" contextId=\"c\">",
                        [new JsonObject { ["text"] = "next" }]
                    )
                ),
            }
        );
        Batch("after");
        f.Owner.Archive.WriteMessages(
            rows.Select((row, index) => Record(f.Owner.Id, index + 1, row)).ToArray()
        );
        f.Execute($"DROP TABLE {ArchiveToolEffects.Table}");
        foreach (var batchSize in new[] { 7, 500 })
        {
            await f.Manager.Activity.BackfillAsync(CancellationToken.None, batchSize);
            var bySeq = All(f)
                .GroupBy(row => row["seq"]!.GetValue<long>())
                .ToDictionary(group => group.Key, group => group.First());
            Assert.Equal(151, bySeq.Count);
            foreach (var (seq, row) in bySeq)
            {
                Assert.Equal("note.txt", Text(row["summary"]));
                Assert.Equal(
                    seq < 302 ? ("session", "lead") : ("mcp-client", "ci-bot"),
                    (Text(row["initiator"]?["kind"]), Text(row["initiator"]?["id"]))
                );
            }
            f.Execute($"DELETE FROM {ArchiveToolEffects.Table}");
        }
    }

    [Fact]
    public async Task The_model_cannot_read_audit_records_through_toolscript_recall()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        await f.Owner.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
            LocalSessionTurnHost.PrepareCanonicalAppend(
                state,
                [
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(new JsonObject { ["text"] = "visible input" }),
                        ["__meta"] = new JsonObject
                        {
                            ["sender"] = InputSender.Identity("alice-identity"),
                        },
                    },
                ],
                [],
                false,
                false,
                () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            )
        );
        Assert.Contains("alice-identity", f.Owner.Archive.ReadMessages()[0].MessageJson);
        var result = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "return call_tool('recall', {'target': 'msg#1'})" }
        );
        Assert.Contains("visible input", result.ToJsonString());
        Assert.DoesNotContain("alice-identity", result.ToJsonString());

        // A tool row that already holds such a copy is cleaned before any model request.
        var leaked = new JsonObject
        {
            ["role"] = "tool",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = "c1",
                        ["name"] = "run_script",
                        ["response"] = new JsonObject
                        {
                            ["result"] = new JsonObject
                            {
                                ["messages"] = new JsonArray(
                                    new JsonObject
                                    {
                                        ["role"] = "tool",
                                        ["__meta"] = new JsonObject
                                        {
                                            ["sender"] = InputSender.Identity("alice-identity"),
                                            ["initiator"] = new JsonObject
                                            {
                                                ["kind"] = "identity",
                                                ["id"] = "alice-identity",
                                            },
                                        },
                                    }
                                ),
                            },
                        },
                    },
                }
            ),
        };
        var history = new[]
        {
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "c1",
                            ["name"] = "run_script",
                            ["args"] = new JsonObject(),
                        },
                    }
                ),
            },
            leaked,
        };
        var request = ConcreteRequestHistory.PrepareRequest(history, "wire");
        Assert.DoesNotContain(
            "alice-identity",
            new JsonArray(request.Select(row => (JsonNode)row.DeepClone()).ToArray()).ToJsonString()
        );
        Assert.Contains("alice-identity", leaked.ToJsonString());
    }

    [Fact]
    public void An_unexpected_derived_table_shape_never_prevents_opening_the_archive()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "archive.sqlite");
        using (var connection = new SqliteConnection($"Data Source={path};Pooling=False"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                CREATE TABLE {ArchiveToolEffects.Table}(session_id TEXT, seq INTEGER);
                CREATE TABLE {ArchiveToolEffects.DirectTable}(id INTEGER PRIMARY KEY, future TEXT);
                INSERT INTO {ArchiveToolEffects.DirectTable}(future) VALUES('kept');
                CREATE INDEX idx_{ArchiveToolEffects.DirectTable}_time ON {ArchiveToolEffects.DirectTable}(future);
                CREATE TABLE {ArchiveToolEffects.MetadataTable}(other TEXT);
                """;
            command.ExecuteNonQuery();
        }
        var store = new SqliteArchiveMessageStore(path, "s");
        store.Initialize();
        store.WriteMessages([
            Record(
                "s",
                1,
                (
                    new JsonObject
                    {
                        ["role"] = "tool",
                        ["parts"] = new JsonArray(
                            new JsonObject
                            {
                                ["functionResponse"] = new JsonObject
                                {
                                    ["tool_use_id"] = "c",
                                    ["name"] = "exec",
                                    ["response"] = new JsonObject { ["output"] = "" },
                                },
                            }
                        ),
                    }
                )
            ),
        ]);
        using var check = new SqliteConnection($"Data Source={path};Pooling=False");
        check.Open();
        object? Scalar(string sql)
        {
            using var command = check.CreateCommand();
            command.CommandText = sql;
            return command.ExecuteScalar();
        }
        Assert.Equal(1L, Scalar($"SELECT count(*) FROM {ArchiveToolEffects.Table}"));
        Assert.Equal(0L, Scalar($"SELECT count(*) FROM {ArchiveToolEffects.DirectTable}"));
        var aside = (string)
            Scalar(
                $"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '{ArchiveToolEffects.DirectTable}_unknown_%'"
            )!;
        Assert.Equal("kept", Scalar($"SELECT future FROM {aside}"));
        Assert.Equal(
            ArchiveToolEffects.Version,
            Scalar(
                $"SELECT value FROM {ArchiveToolEffects.MetadataTable} WHERE key='{ArchiveToolEffects.VersionKey}'"
            )
        );
        // Reopening with the current shapes changes nothing further.
        new SqliteArchiveMessageStore(path, "s").Initialize();
        Assert.Equal(
            1L,
            Scalar(
                $"SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE '{ArchiveToolEffects.DirectTable}_unknown_%'"
            )
        );
        Assert.Equal(1L, Scalar($"SELECT count(*) FROM {ArchiveToolEffects.Table}"));
    }

    [Fact]
    public void Script_reads_keep_their_action_and_are_not_changes()
    {
        var target = SessionToolExecutor.TargetRecord(
            new ResolvedTool("task", "builtin", "task", new JsonObject { ["action"] = "list" }),
            "list"
        );
        var row = ArchiveToolEffects.FromSubCall(
            new JsonObject
            {
                ["name"] = "task",
                ["status"] = "ok",
                ["target"] = target,
            },
            1,
            "s",
            2,
            0,
            "main",
            1000,
            "model",
            null,
            null
        );
        Assert.Equal("list", row.Action);
        Assert.Equal("read", ActivityKinds.Of(row.Source, row.Tool, row.Action));
        var direct = ArchiveToolEffects.FromDirectCall(
            null,
            null,
            "external-mcp",
            1000,
            target,
            "task",
            null,
            new JsonObject(),
            "list",
            new(0, "mcp-client", "ci"),
            null
        );
        Assert.Equal("read", ActivityKinds.Of(direct.Source, direct.Tool, direct.Action));
    }

    [Fact]
    public async Task Summaries_are_masked_before_they_are_shortened()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            "{\"vector\":false,\"dbWorkers\":false}"
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            """
            {"default":"local","providers":{"local":{"providerType":"openai-responses","baseUrl":"http://127.0.0.1:1","models":["wire"]}}}
            """
        );
        var config = new ModelConfiguration(data);
        await using var manager = new SessionManager(
            data,
            Path.Combine(temp.Path, "work"),
            new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713),
            config.Models
        );
        const string secret = "sk-live-QQ0123456789abcdefghijklmnop";
        Assert.NotNull(manager.Secrets);
        manager.Secrets!.AddSource("probe", () => [new KnownSecret("probe", secret)]);
        for (var offset = 160; offset < 190; offset++)
        {
            var command = new string('a', offset) + " " + secret;
            // Masking the shortened preview instead would keep the secret's first characters.
            Assert.Contains(
                "sk-live",
                SessionToolExecutor.ToolArgsPreview(
                    "exec",
                    new JsonObject { ["command"] = command }
                )
            );
            var summary = SessionToolExecutor.ActivitySummary(
                manager,
                "exec",
                new JsonObject { ["command"] = command },
                null
            );
            Assert.DoesNotContain("sk-live", summary);
        }
    }

    [Fact]
    public async Task Unattended_records_name_their_timer()
    {
        await using var f = await Create();
        if (f is null)
            return;
        var tools = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            f.Owner,
            f.Manager,
            f.Registry,
            unattended: true,
            unattendedOrigin: "timer",
            unattendedOriginId: "tmr_7"
        );
        await tools.ExecuteAsync(
            Call(
                "",
                "run_script",
                new JsonObject { ["code"] = "call_tool('read', {'filePath': 'note.txt'})\n" }
            ),
            CancellationToken.None
        );
        await f.Manager.Activity.PendingDirect;
        var row = Assert.Single(
            Items(f.Manager.Activity.Query(new ActivityQuery(Kind: "all", Origin: "timer-script")))
        );
        Assert.Equal(
            ("timer", "tmr_7"),
            (Text(row["initiator"]?["kind"]), Text(row["initiator"]?["id"]))
        );
        Assert.Equal("read", Text(row["kind"]));
    }

    [Fact]
    public async Task Rows_left_under_an_old_identity_are_reindexed_under_the_moved_session()
    {
        await using var f = await Create();
        if (f is null)
            return;
        await f.InputAsync(Input(Handoff));
        await f.TurnAsync([Read("look")]);
        var caller = await f.Manager.CreateNamedAsync("main", "caller", null, null);
        await f.Manager.MoveIdentityAsync(
            caller,
            new JsonObject { ["sessionId"] = f.Owner.Id, ["newSessionId"] = "moved" }
        );
        Assert.Single(All(f, "moved"));
        // As a build without the index leaves it: the Archive moved, its index rows did not.
        f.Execute($"UPDATE {ArchiveToolEffects.Table} SET session_id='effects'");
        Assert.Empty(All(f, "moved"));
        await using var restarted = new ActivityIndex(f.Manager);
        Assert.False(restarted.Coverage()["complete"]!.GetValue<bool>());
        await restarted.BackfillAsync(CancellationToken.None);
        Assert.True(restarted.Coverage()["complete"]!.GetValue<bool>());
        var row = Assert.Single(All(f, "moved"));
        Assert.Equal("lead", Text(row["initiator"]?["id"]));
        Assert.Empty(All(f, "effects"));
    }
}
