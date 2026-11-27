using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.ToolScript;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

// UI-only evidence of each committed Session-sourced delivery a call causes: sends, a child's
// initial message and Task notifications, directly and from ToolScript.
public sealed class SessionDeliveryRecordTests
{
    private static bool MontySupported => OperatingSystem.IsLinux() && MontyWorker.IsSupported;

    private static async Task<TurnToolExecution> Exec(
        SessionToolExecutor tools,
        string id,
        string name,
        JsonObject args
    )
    {
        var execution = await tools.ExecuteAttributedAsync(
            new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
                ["args"] = args,
            },
            default
        );
        return execution;
    }

    // The fixture's registry plus the Session coordination tools.
    private static SessionToolExecutor ToolsFor(ScriptFixture f, SessionOwner owner)
    {
        var definitions = WorkspaceTools.Definitions();
        foreach (var item in ToolScriptToolDefinitions.Definitions())
            definitions.Add(item?.DeepClone());
        foreach (var item in AgentToolDefinitions.Definitions())
            definitions.Add(item.DeepClone());
        foreach (var item in UnifiedToolDefinitions.All())
            definitions.Add(item?.DeepClone());
        foreach (var item in LocalExecManager.Definitions())
            definitions.Add(item?.DeepClone());
        var tools = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            owner,
            f.Manager,
            SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work)
        );
        tools.BeginTurn();
        return tools;
    }

    // The trusted envelopes a Session received, in order, from its history and queue.
    private static (Dictionary<string, string> Attributes, string Body)[] Envelopes(SessionOwner owner) =>
        owner
            .History()
            .Where(message => SessionWait.Text(message["role"]) == "user")
            .SelectMany(message => (message["parts"] as JsonArray)!.OfType<JsonObject>())
            .Concat(owner.Entry.Snapshot().Queue.SelectMany(item => item.Parts ?? []))
            .Select(part => SessionWait.Text(part?["system"]))
            .OfType<string>()
            .Where(text => text.StartsWith("<foxwarm-message", StringComparison.Ordinal))
            .Select(text =>
            {
                var split = text.Split('\n', 2);
                var attributes = Regex
                    .Matches(split[0], "([A-Za-z]+)=\"([^\"]*)\"")
                    .ToDictionary(match => match.Groups[1].Value, match => match.Groups[2].Value);
                var body = split[1];
                return (attributes, body[..body.LastIndexOf("\n</foxwarm-message>", StringComparison.Ordinal)]);
            })
            .ToArray();

    private static JsonObject[] Records(TurnToolExecution execution) =>
        execution.SessionMessages?.OfType<JsonObject>().ToArray() ?? [];

    private static string? TaskField(JsonObject record, string field) =>
        SessionWait.Text(record["task"]?[field]);

    private static void AssertMatches(JsonObject record, (Dictionary<string, string> Attributes, string Body) envelope)
    {
        Assert.Equal(envelope.Body, SessionWait.Text(record["message"]));
        Assert.Equal(
            envelope.Attributes.GetValueOrDefault("deliverySeq"),
            SessionWait.Text(record["deliverySeq"])
        );
        if (record["task"] is not null)
        {
            Assert.Equal(envelope.Attributes["taskId"], TaskField(record, "taskId"));
            Assert.Equal(envelope.Attributes["event"], TaskField(record, "event"));
            Assert.Equal(envelope.Attributes["recipient"], TaskField(record, "recipient"));
        }
    }

    [Fact]
    public async Task Direct_Task_and_child_calls_record_each_delivery_with_its_role_and_exact_body()
    {
        await using var f = await ScriptFixture.Create();
        var tools = ToolsFor(f, f.Owner);
        var peer = await f.Manager.CreateNamedAsync("main", "peer", null, null);
        var next = await f.Manager.CreateNamedAsync("main", "next", null, null);

        var created = await Exec(
            tools,
            "create",
            "task",
            new()
            {
                ["action"] = "create",
                ["title"] = "Review",
                ["description"] = "Read the change.",
                ["ownerSessionId"] = peer.Id,
                ["notifySession"] = true,
            }
        );
        var taskId = SessionWait.Text(created.Response!["taskId"])!;
        var assignment = Assert.Single(Records(created));
        Assert.Equal("create", SessionWait.Text(assignment["id"]));
        Assert.Equal(peer.Id, SessionWait.Text(assignment["targetSessionId"]));
        Assert.Equal("assigned", TaskField(assignment, "event"));
        Assert.Equal("owner", TaskField(assignment, "recipient"));
        Assert.Equal("Review", TaskField(assignment, "title"));
        AssertMatches(assignment, Assert.Single(Envelopes(peer)));

        // A transfer notifies the previous owner and the new owner: two records, in order.
        var transferred = Records(
            await Exec(
                tools,
                "assign",
                "task",
                new()
                {
                    ["action"] = "assign",
                    ["taskId"] = taskId,
                    ["ownerSessionId"] = next.Id,
                    ["notifySession"] = true,
                }
            )
        );
        Assert.Equal(new[] { "assign", "assign#2" }, transferred.Select(item => SessionWait.Text(item["id"])));
        Assert.Equal(new[] { peer.Id, next.Id }, transferred.Select(item => SessionWait.Text(item["targetSessionId"])));
        Assert.Equal(new[] { "previous-owner", "owner" }, transferred.Select(item => TaskField(item, "recipient")));
        Assert.All(transferred, item => Assert.Equal("transferred", TaskField(item, "event")));
        AssertMatches(transferred[0], Envelopes(peer)[1]);
        AssertMatches(transferred[1], Assert.Single(Envelopes(next)));

        var note = Assert.Single(
            Records(
                await Exec(
                    tools,
                    "note",
                    "task",
                    new()
                    {
                        ["action"] = "update",
                        ["taskId"] = taskId,
                        ["note"] = "Is the old format still read?",
                        ["notifySession"] = true,
                    }
                )
            )
        );
        Assert.Equal("note", TaskField(note, "event"));
        Assert.Equal("owner", TaskField(note, "recipient"));
        AssertMatches(note, Envelopes(next)[1]);

        // The owner's completion reports to the creator.
        var completion = Assert.Single(
            Records(
                await Exec(
                    ToolsFor(f, next),
                    "complete",
                    "task",
                    new()
                    {
                        ["action"] = "complete",
                        ["taskId"] = taskId,
                        ["result"] = "## Result\nAll read.",
                    }
                )
            )
        );
        Assert.Equal(f.Owner.Id, SessionWait.Text(completion["targetSessionId"]));
        Assert.Equal("completed", TaskField(completion, "event"));
        Assert.Equal("creator", TaskField(completion, "recipient"));
        AssertMatches(completion, Assert.Single(Envelopes(f.Owner)));
        Assert.Contains("## Result\nAll read.", SessionWait.Text(completion["message"]));

        // No delivery, no record: notification omitted, and completions that notify nobody.
        Assert.Empty(
            Records(
                await Exec(
                    tools,
                    "silent",
                    "task",
                    new()
                    {
                        ["action"] = "create",
                        ["title"] = "Silent",
                        ["ownerSessionId"] = peer.Id,
                    }
                )
            )
        );
        var own = SessionWait.Text(
            (await Exec(tools, "own", "task", new() { ["action"] = "create", ["title"] = "Own" }))
                .Response!["taskId"]
        )!;
        await Exec(tools, "claim", "task", new() { ["action"] = "claim", ["taskId"] = own });
        Assert.Empty(
            Records(
                await Exec(
                    tools,
                    "self",
                    "task",
                    new() { ["action"] = "complete", ["taskId"] = own, ["result"] = "done" }
                )
            )
        );
        var userTask = await f.Manager.Tasks.ExecuteAsUserAsync(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "From the user",
                ["ownerSessionId"] = peer.Id,
                ["notifySession"] = false,
            }
        );
        Assert.Empty(
            Records(
                await Exec(
                    ToolsFor(f, peer),
                    "user-complete",
                    "task",
                    new()
                    {
                        ["action"] = "complete",
                        ["taskId"] = SessionWait.Text(userTask["task"]!["id"]),
                        ["result"] = "done",
                    }
                )
            )
        );
    }

    [Fact]
    public async Task User_create_and_assign_notify_unless_they_opt_out_and_name_the_recipient()
    {
        await using var f = await ScriptFixture.Create();
        var first = await f.Manager.CreateNamedAsync("main", "first", null, null);
        var second = await f.Manager.CreateNamedAsync("main", "second", null, null);
        var created = await f.Manager.Tasks.ExecuteAsUserAsync(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "From the user",
                ["ownerSessionId"] = first.Id,
            }
        );
        var taskId = SessionWait.Text(created["task"]!["id"])!;
        var assigned = Assert.Single(Envelopes(first)).Attributes;
        Assert.Equal(("assigned", "owner", "user"), (assigned["event"], assigned["recipient"], assigned["sourceKind"]));
        Assert.False(assigned.ContainsKey("sourceSessionId"));
        await f.Manager.Tasks.ExecuteAsUserAsync(
            new JsonObject
            {
                ["action"] = "assign",
                ["taskId"] = taskId,
                ["ownerSessionId"] = second.Id,
            }
        );
        Assert.Equal("previous-owner", Envelopes(first)[1].Attributes["recipient"]);
        Assert.Equal("owner", Assert.Single(Envelopes(second)).Attributes["recipient"]);
        // Comments stay opt-in.
        await f.Manager.Tasks.ExecuteAsUserAsync(
            new JsonObject
            {
                ["action"] = "comment",
                ["taskId"] = taskId,
                ["note"] = "Quiet",
            }
        );
        Assert.Single(Envelopes(second));
        await f.Manager.Tasks.ExecuteAsUserAsync(
            new JsonObject
            {
                ["action"] = "assign",
                ["taskId"] = taskId,
                ["ownerSessionId"] = first.Id,
                ["notifySession"] = false,
            }
        );
        Assert.Equal(2, Envelopes(first).Length);
    }

    [Fact]
    public async Task Child_creation_records_its_Task_assignment_or_its_initial_message()
    {
        await using var f = await ScriptFixture.Create();
        var tools = ToolsFor(f, f.Owner);
        var linked = SessionWait.Text(
            (await Exec(tools, "t", "task", new() { ["action"] = "create", ["title"] = "Linked" }))
                .Response!["taskId"]
        )!;
        var withTask = await Exec(
            tools,
            "child-task",
            "create_child_session",
            new()
            {
                ["suffix"] = "linked",
                ["taskId"] = linked,
                ["message"] = "Use the disposable harness.",
            }
        );
        var assignment = Assert.Single(Records(withTask));
        var child = await f.Manager.RequiredAsync(SessionWait.Text(assignment["targetSessionId"])!);
        Assert.EndsWith("linked", child.Id, StringComparison.Ordinal);
        Assert.Equal("assigned", TaskField(assignment, "event"));
        Assert.Equal("owner", TaskField(assignment, "recipient"));
        Assert.EndsWith(
            "\n\nAdditional instruction:\nUse the disposable harness.",
            SessionWait.Text(assignment["message"])
        );
        AssertMatches(assignment, Assert.Single(Envelopes(child)));

        var plain = Assert.Single(
            Records(
                await Exec(
                    tools,
                    "child-plain",
                    "create_child_session",
                    new() { ["suffix"] = "plain", ["message"] = "Report when done." }
                )
            )
        );
        Assert.Null(plain["task"]);
        Assert.Equal("Report when done.", SessionWait.Text(plain["message"]));
        Assert.Equal("inter-agent", Assert.Single(Envelopes(await f.Manager.RequiredAsync(SessionWait.Text(plain["targetSessionId"])!))).Attributes["type"]);
    }

    [Fact]
    public async Task Scripts_record_every_delivery_of_each_subcall_including_nested_runs_and_failures()
    {
        if (!MontySupported)
            return;
        await using var f = await ScriptFixture.Create();
        var tools = ToolsFor(f, f.Owner);
        var peer = await f.Manager.CreateNamedAsync("main", "peer", null, null);
        var directory = f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory;
        var inner = Path.Combine(directory, "inner.py");
        var outer = Path.Combine(directory, "outer.py");
        await File.WriteAllTextAsync(
            inner,
            "task = call_tool('task', {'action': 'create', 'title': 'Nested', 'description': 'Deep'})\n"
                + "call_tool('create_child_session', {'suffix': 'deep', 'taskId': task['taskId']})\n"
                + "return task['taskId']\n"
        );
        await File.WriteAllTextAsync(
            outer,
            "r = call_tool('run_script', {'filePath': " + JsonSerializer.Serialize(inner) + "})\n"
                + $"call_tool('send_to_session', {{'sessionId': '{peer.Id}', 'message': 'Heads-up'}})\n"
                + "return r\n"
        );
        var execution = await Exec(
            tools,
            "script",
            "run_script",
            new()
            {
                ["code"] =
                    $"t = call_tool('task', {{'action': 'create', 'title': 'Scripted', 'ownerSessionId': '{peer.Id}', 'notifySession': True}})\n"
                    + $"call_tool('builtin:send_to_session', {{'sessionId': '{peer.Id}', 'message': 'Plain'}})\n"
                    + "call_tool('run_script', {'filePath': "
                    + JsonSerializer.Serialize(outer)
                    + "})\n"
                    + "raise ValueError('after the deliveries')\n",
            }
        );
        Assert.Equal("failed", SessionWait.Text(execution.Response!["status"]));
        // The script's own call has no direct records; they belong to its subcalls.
        Assert.Null(execution.SessionMessages);
        var subCalls = execution.ToolScriptSubCalls!.OfType<JsonObject>().ToArray();
        Assert.Equal(3, subCalls.Length);
        JsonObject[] Of(JsonObject subCall) =>
            (subCall["sessionMessages"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];
        var created = Assert.Single(Of(subCalls[0]));
        Assert.Equal("assigned", TaskField(created, "event"));
        Assert.Equal(SessionWait.Text(subCalls[0]["id"]), SessionWait.Text(created["id"]));
        Assert.Null(Assert.Single(Of(subCalls[1]))["task"]);
        // Two levels down: the child's assignment, then the outer file's send, under one subcall.
        var nested = Of(subCalls[2]);
        Assert.Equal(2, nested.Length);
        Assert.Equal("assigned", TaskField(nested[0], "event"));
        Assert.EndsWith("deep", SessionWait.Text(nested[0]["targetSessionId"]), StringComparison.Ordinal);
        Assert.Equal("Heads-up", SessionWait.Text(nested[1]["message"]));
        Assert.Equal(
            new[] { SessionWait.Text(subCalls[2]["id"]), SessionWait.Text(subCalls[2]["id"]) + "#2" },
            nested.Select(item => SessionWait.Text(item["id"]))
        );
        Assert.All(subCalls, subCall => Assert.Null(subCall["sessionMessage"]));
        var envelopes = Envelopes(peer);
        AssertMatches(created, envelopes[0]);
        AssertMatches(nested[1], envelopes[2]);
    }

    [Fact]
    public async Task A_background_run_reports_deliveries_after_its_hand_off_with_its_finish_event()
    {
        if (!MontySupported)
            return;
        await using var f = await ScriptFixture.Create();
        var tools = ToolsFor(f, f.Owner);
        var peer = await f.Manager.CreateNamedAsync("main", "peer", null, null);
        var release = Path.Combine(f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory, "release");
        var execution = await Exec(
            tools,
            "background",
            "run_script",
            new()
            {
                ["mode"] = "background",
                ["timeoutSecs"] = 1,
                ["code"] =
                    $"call_tool('send_to_session', {{'sessionId': '{peer.Id}', 'message': 'Before'}})\n"
                    + "call_tool('exec', {'command': "
                    + JsonSerializer.Serialize(
                        $"for n in $(seq 1 1500); do test -f '{release}' && break; sleep 0.02; done"
                    )
                    + ", 'timeout': 60})\n"
                    + $"call_tool('send_to_session', {{'sessionId': '{peer.Id}', 'message': 'After'}})\n"
                    + $"call_tool('task', {{'action': 'create', 'title': 'Later', 'ownerSessionId': '{peer.Id}', 'notifySession': True}})\n"
                    + "return 'ok'\n",
            }
        );
        Assert.Equal("running", SessionWait.Text(execution.Response!["status"]));
        var runId = SessionWait.Text(execution.Response!["runId"])!;
        var shown = execution
            .ToolScriptSubCalls!.OfType<JsonObject>()
            .SelectMany(subCall => (subCall["sessionMessages"] as JsonArray ?? []).OfType<JsonObject>())
            .Select(item => SessionWait.Text(item["message"]))
            .ToArray();
        Assert.Equal(new[] { "Before" }, shown);
        await File.WriteAllTextAsync(release, "go");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        QueueItem? finished = null;
        while (finished is null)
        {
            finished = f.Owner.Entry.WithState(state =>
                state.Queue.FirstOrDefault(item => SessionWait.Text(item.OpenFields?["execId"]) == runId)
            );
            if (finished is null)
                await Task.Delay(20, deadline.Token);
        }
        var later = (finished.OpenFields!["sessionMessages"] as JsonArray)!.OfType<JsonObject>().ToArray();
        Assert.Equal(2, later.Length);
        Assert.Equal("After", SessionWait.Text(later[0]["message"]));
        Assert.Equal("assigned", TaskField(later[1], "event"));
        // The model-visible event text is unchanged; the records are display-only fields.
        Assert.DoesNotContain("After", finished.Parts![0]["system"]!.GetValue<string>());
        var envelopes = Envelopes(peer);
        AssertMatches(later[0], envelopes[1]);
        AssertMatches(later[1], envelopes[2]);
    }

    private static JsonObject Delivery(string id, string target, string message, string? seq = null)
    {
        var record = new JsonObject
        {
            ["id"] = id,
            ["targetSessionId"] = target,
            ["message"] = message,
        };
        if (seq is not null)
            record["deliverySeq"] = seq;
        return record;
    }

    [Fact]
    public void Activity_rows_read_the_subcall_delivery_list_and_the_older_single_record()
    {
        var listed = ArchiveToolEffects.FromSubCall(
            new JsonObject
            {
                ["id"] = "tsc_a",
                ["name"] = "run_script",
                ["status"] = "failed",
                ["sessionMessages"] = new JsonArray(
                    Delivery("tsc_a", "worker-a", "one"),
                    Delivery("tsc_a#2", "worker-b", "two")
                ),
            },
            1,
            "owner",
            4,
            0,
            "main",
            1000,
            "model",
            null,
            "tsr_1"
        );
        Assert.Contains("worker-a", listed.Refs);
        Assert.Contains("worker-b", listed.Refs);
        var legacy = ArchiveToolEffects.FromSubCall(
            new JsonObject
            {
                ["id"] = "tsc_b",
                ["name"] = "send_to_session",
                ["status"] = "completed",
                ["sessionMessage"] = Delivery("tsc_b", "worker-c", "old"),
            },
            1,
            "owner",
            4,
            0,
            "main",
            1000,
            "model",
            null,
            "tsr_1"
        );
        Assert.Contains("worker-c", legacy.Refs);
        var direct = ArchiveToolEffects.FromDirectCall(
            "owner",
            "main",
            "model",
            1000,
            null,
            "run_script",
            null,
            new JsonObject(),
            "detached",
            null,
            "tsr_1",
            new JsonArray(Delivery("tsc_c", "worker-d", "after"), Delivery("tsc_c#2", "worker-e", "task"))
        );
        Assert.Contains("worker-d", direct.Refs);
        Assert.Contains("worker-e", direct.Refs);
    }

    [Fact]
    public async Task Session_Sequence_reads_every_listed_subcall_delivery_and_older_single_ones()
    {
        await using var f = await ScriptFixture.Create();
        var receiver = await f.Manager.CreateNamedAsync("main", "receiver", null, null);
        var t0 = (long)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 60_000;
        JsonObject SubCall(string id, string status, JsonObject extra)
        {
            var subcall = new JsonObject
            {
                ["id"] = id,
                ["name"] = "call_tool",
                ["status"] = status,
                ["startedAt"] = t0 + 10,
                ["durationMs"] = 5,
            };
            foreach (var (key, value) in extra)
                subcall[key] = value?.DeepClone();
            return subcall;
        }
        await SessionSequenceProjectionTests.Append(
            f.Owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "start" }),
                ["__meta"] = new JsonObject { ["timestamp"] = t0 - 1000 },
            },
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "s1",
                            ["name"] = "run_script",
                            ["args"] = new JsonObject { ["code"] = "x" },
                        },
                    }
                ),
                ["__meta"] = new JsonObject { ["timestamp"] = t0 },
            },
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "s1",
                            ["name"] = "run_script",
                            ["response"] = new JsonObject { ["status"] = "failed" },
                            ["executionTiming"] = new JsonObject
                            {
                                ["startedAt"] = t0 + 5,
                                ["completedAt"] = t0 + 40,
                                ["durationMs"] = 35,
                            },
                            ["__meta"] = new JsonObject
                            {
                                ["toolScriptSubCalls"] = new JsonArray(
                                    SubCall(
                                        "a",
                                        "failed",
                                        new JsonObject
                                        {
                                            ["sessionMessages"] = new JsonArray(
                                                Delivery("a", receiver.Id, "listed one", "9.1.1"),
                                                Delivery("a#2", receiver.Id, "listed two", "9.1.1")
                                            ),
                                        }
                                    ),
                                    SubCall(
                                        "b",
                                        "completed",
                                        new JsonObject
                                        {
                                            ["sessionMessage"] = Delivery("b", receiver.Id, "older single", "9.1.2"),
                                        }
                                    ),
                                    SubCall(
                                        "c",
                                        "failed",
                                        new JsonObject
                                        {
                                            ["sessionMessage"] = Delivery("c", receiver.Id, "older failed", "9.1.3"),
                                        }
                                    )
                                ),
                            },
                        },
                    }
                ),
                ["__meta"] = new JsonObject { ["timestamp"] = t0 + 40 },
            }
        );
        var result = new SessionSequenceProjection(
            new SessionRuntime(f.Manager),
            f.Manager.ArchiveDatabase
        ).BuildPage(new(), null);
        var previews = (result["links"] as JsonArray)!
            .OfType<JsonObject>()
            .Where(link => SessionWait.Text(link["kind"]) == "message")
            .Select(link => SessionWait.Text(link["preview"]))
            .Order()
            .ToArray();
        Assert.Equal(new[] { "listed one", "listed two", "older single" }, previews);
    }
}
