using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class DeliverySeqTests
{
    private static JsonObject Call(string id, string name, JsonObject args) =>
        new()
        {
            ["type"] = "function_call",
            ["call_id"] = id,
            ["name"] = name,
            ["arguments"] = args.ToJsonString(),
        };

    private static JsonObject Final() =>
        new()
        {
            ["type"] = "message",
            ["role"] = "assistant",
            ["content"] = new JsonArray(
                new JsonObject { ["type"] = "output_text", ["text"] = "done" }
            ),
        };

    private static Task Respond(System.Net.Sockets.NetworkStream stream, JsonArray output) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            200,
            "text/event-stream",
            Encoding.UTF8.GetBytes(
                "data: "
                    + new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject { ["output"] = output },
                    }.ToJsonString()
                    + "\n\n"
            )
        );

    private static ResponsesClientOptions Options(Uri uri) => new(uri, "wire", "a", "", "", 713);

    private static JsonObject Send(string target, string message) =>
        new() { ["sessionId"] = target, ["message"] = message };

    private static string Script(string target, params string[] messages) =>
        string.Join(
            "\n",
            messages.Select(message =>
                $"call_tool('send_to_session', {{'sessionId': '{target}', 'message': '{message}'}})"
            )
        ) + "\nreturn 'ok'";

    private static IEnumerable<(string Text, string? DeliverySeq)> Wrappers(SessionOwner owner) =>
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
                var opening = text.Split('\n', 2)[0];
                var match = Regex.Match(opening, "deliverySeq=\"([^\"]*)\"");
                return (text, match.Success ? match.Groups[1].Value : null);
            });

    [Fact]
    public async Task Deliveries_carry_the_sender_model_message_position_on_both_sides()
    {
        string a = "",
            b = "";
        var ownerRequests = -1;
        await using var peer = new ScriptedResponsesSequenceServer(
            20,
            async (_, stream, request) =>
                await Respond(
                    stream,
                    // The created child runs its own first turn against the same provider.
                    !request.Body.Contains("deliver everything", StringComparison.Ordinal)
                        ? new JsonArray(Final())
                        : Interlocked.Increment(ref ownerRequests) switch
                        {
                            0 => new JsonArray(
                                Call("p1", "send_to_session", Send(a, "parallel to a")),
                                Call(
                                    "p2",
                                    "run_script",
                                    new() { ["code"] = Script(b, "script one", "script two") }
                                ),
                                Call(
                                    "p3",
                                    "create_child_session",
                                    new() { ["suffix"] = "kid", ["message"] = "child start" }
                                )
                            ),
                            1 => new JsonArray(
                                Call("d1", "send_to_session", Send(a, "direct to a"))
                            ),
                            2 => new JsonArray(
                                Call(
                                    "s1",
                                    "run_script",
                                    new() { ["code"] = Script(b, "lone script") }
                                )
                            ),
                            3 => new JsonArray(
                                Call(
                                    "t1",
                                    "task",
                                    new()
                                    {
                                        ["action"] = "create",
                                        ["title"] = "Check it",
                                        ["ownerSessionId"] = a,
                                        ["notifySession"] = true,
                                    }
                                )
                            ),
                            _ => new JsonArray(Final()),
                        }
                )
        );
        await using var f = await ScriptFixture.Create(suppliedOptions: Options(peer.BaseUri));
        var targetA = await f.Manager.CreateNamedAsync("main", "peer-a", null, null);
        var targetB = await f.Manager.CreateNamedAsync("main", "peer-b", null, null);
        targetA.Registry.TriggerOverride = _ => Task.CompletedTask;
        targetB.Registry.TriggerOverride = _ => Task.CompletedTask;
        a = targetA.Id;
        b = targetB.Id;
        await f.Owner.Entry.SaveLane.AdmitAsync(
            QueueItem.UserText("deliver everything"),
            SaveKind.Strict
        );
        await f
            .Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id)
            .WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(4, ownerRequests);

        var history = f.Owner.History();
        var anchors = history
            .Where(message =>
                SessionWait.Text(message["role"]) == "model"
                && (message["parts"] as JsonArray)!.Any(part => part?["functionCall"] is not null)
            )
            .Select(message => (long)SessionWait.Number(message["__meta"]!["seq"])!)
            .ToArray();
        Assert.Equal(4, anchors.Length);
        var (batch, direct, script, task) = (anchors[0], anchors[1], anchors[2], anchors[3]);

        var toA = Wrappers(targetA).ToArray();
        Assert.Equal(3, toA.Length);
        Assert.Contains("type=\"inter-agent\"", toA[0].Text);
        Assert.Equal($"{batch}.1", toA[0].DeliverySeq);
        Assert.Equal($"{direct}", toA[1].DeliverySeq);
        Assert.Contains("type=\"task\"", toA[2].Text);
        Assert.Equal($"{task}", toA[2].DeliverySeq);
        Assert.Equal(
            new[] { $"{batch}.2.1", $"{batch}.2.2", $"{script}.1.1" },
            Wrappers(targetB).Select(item => item.DeliverySeq)
        );
        var child = f
            .Manager.LocalProjections()
            .Select(row => SessionWait.Text(row["id"])!)
            .Single(id => id.EndsWith("kid", StringComparison.Ordinal));
        var childOwner = await f.Manager.RequiredAsync(child);
        Assert.Equal($"{batch}.3", Assert.Single(Wrappers(childOwner)).DeliverySeq);

        // The trusted wrapper keeps its original attributes and body; only the attribute is added.
        Assert.Matches(
            "^<foxwarm-message type=\"inter-agent\" sourceSessionId=\"[^\"]+\" deliverySeq=\"[0-9.]+\" replyTargetSessionId=",
            toA[0].Text
        );
        Assert.EndsWith("\nparallel to a\n</foxwarm-message>", toA[0].Text);

        var responses = history
            .Where(message => SessionWait.Text(message["role"]) == "tool")
            .SelectMany(message => (message["parts"] as JsonArray)!)
            .Select(part => part!["functionResponse"]!.AsObject())
            .ToDictionary(response => SessionWait.Text(response["tool_use_id"])!);
        Assert.Equal(
            $"{batch}.1",
            SessionWait.Text(responses["p1"]["__meta"]!["sessionMessages"]![0]!["deliverySeq"])
        );
        Assert.Equal(
            $"{direct}",
            SessionWait.Text(responses["d1"]["__meta"]!["sessionMessages"]![0]!["deliverySeq"])
        );
        Assert.Equal(
            new[] { $"{batch}.2.1", $"{batch}.2.2" },
            responses["p2"]["__meta"]!["toolScriptSubCalls"]!
                .AsArray()
                .Select(call => SessionWait.Text(call!["sessionMessage"]!["deliverySeq"]))
        );
        Assert.Equal(
            $"{script}.1.1",
            SessionWait.Text(
                responses["s1"]["__meta"]!["toolScriptSubCalls"]![0]!["sessionMessage"]![
                    "deliverySeq"
                ]
            )
        );
    }

    [Fact]
    public async Task Timer_scripts_without_a_model_call_use_the_run_ID()
    {
        await using var f = await ScriptFixture.Create();
        var target = await f.Manager.CreateNamedAsync("main", "watched", null, null);
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        var receipt = await f.Manager.ExecuteTimerToolAsync(
            f.Owner,
            "create_timer",
            new JsonObject
            {
                ["action"] = "toolscript",
                ["script"] = new JsonObject { ["code"] = Script(target.Id, "first", "second") },
                ["afterSeconds"] = .03,
            },
            default
        );
        Assert.Null(receipt["error"]);
        var deadline = DateTime.UtcNow.AddSeconds(8);
        while (Wrappers(target).Count() < 2 && DateTime.UtcNow < deadline)
            await Task.Delay(10);
        var ids = Wrappers(target).Select(item => item.DeliverySeq).ToArray();
        Assert.Equal(2, ids.Length);
        Assert.Matches("^ts:tsr_[^.]+\\.1$", ids[0]);
        Assert.Equal(ids[0]![..^1] + "2", ids[1]);
    }

    [Fact]
    public async Task Run_IDs_stay_unique_across_slices_without_a_model_call()
    {
        await using var f = await ScriptFixture.Create();
        var target = await f.Manager.CreateNamedAsync("main", "watched", null, null);
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        var definitions = new JsonArray();
        foreach (var item in ToolScriptToolDefinitions.Definitions())
            definitions.Add(item?.DeepClone());
        foreach (var item in AgentToolDefinitions.Definitions())
            definitions.Add(item.DeepClone());
        foreach (var item in UnifiedToolDefinitions.All())
            definitions.Add(item?.DeepClone());
        // Calls outside a model batch: the same unanchored shape as the timer dispatcher.
        var tools = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            f.Owner,
            f.Manager,
            SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work)
        );
        tools.BeginTurn();
        async Task<JsonObject> Call(string name, JsonObject args) =>
            (
                await tools.ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = "unanchored",
                        ["name"] = name,
                        ["args"] = args,
                    },
                    default
                )
            )!.AsObject();
        var send = (string message) =>
            $"call_tool('send_to_session', {{'sessionId': '{target.Id}', 'message': '{message}'}})";
        var waiting = await Call(
            "run_script",
            new JsonObject
            {
                ["code"] = string.Join(
                    "\n",
                    send("first"),
                    send("second"),
                    "ask_agent('next')",
                    send("third"),
                    "return 'ok'"
                ),
                ["mode"] = "background",
            }
        );
        Assert.True(
            waiting["status"]?.GetValue<string>() == "waiting",
            waiting.ToJsonString()
        );
        var runId = waiting["runId"]!.GetValue<string>();
        // The run-wide position is part of the persisted run record, so it survives restart.
        var persisted = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Path.Combine(f.Data, "state", "toolscript-runs", runId + ".json")
            )
        )!;
        Assert.Equal(2, persisted["subCallTotal"]!.GetValue<int>());
        var completed = await Call(
            "continue_script",
            new JsonObject
            {
                ["runId"] = runId,
                ["continuationId"] = waiting["continuationId"]!.DeepClone(),
                ["input"] = "go",
            }
        );
        Assert.Equal("completed", completed["status"]!.GetValue<string>());
        var ids = Wrappers(target).Select(item => item.DeliverySeq).ToArray();
        Assert.Equal(new[] { $"ts:{runId}.1", $"ts:{runId}.2", $"ts:{runId}.3" }, ids);
    }

    [Fact]
    public void Delivery_IDs_follow_the_position_format()
    {
        Assert.Equal("12", SessionManager.BatchDeliverySeq(12, 0, 1, script: false));
        Assert.Equal("12.1", SessionManager.BatchDeliverySeq(12, 0, 1, script: true));
        Assert.Equal("12.3", SessionManager.BatchDeliverySeq(12, 2, 4, script: false));
        Assert.Null(SessionManager.BatchDeliverySeq(null, 0, 1, script: false));
        Assert.Equal("12.3.2", SessionManager.SubCallDeliverySeq("12.3", "tsr_x", 2));
        Assert.Equal("ts:tsr_x.4", SessionManager.SubCallDeliverySeq(null, "tsr_x", 4));
        Assert.Null(SessionManager.SubCallDeliverySeq(null, null, 4));
    }
}
