using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class ForkDualReturnTests
{
    private const string Assignment = "FORK-ASSIGNMENT-7f3";

    private static JsonObject Call(string id, string name, JsonObject args) =>
        new()
        {
            ["type"] = "function_call",
            ["call_id"] = id,
            ["name"] = name,
            ["arguments"] = args.ToJsonString(),
        };

    private static JsonObject Final(string text) =>
        new()
        {
            ["type"] = "message",
            ["role"] = "assistant",
            ["content"] = new JsonArray(
                new JsonObject { ["type"] = "output_text", ["text"] = text }
            ),
        };

    private static Task Respond(
        System.Net.Sockets.NetworkStream stream,
        params JsonObject[] output
    ) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            200,
            "text/event-stream",
            Encoding.UTF8.GetBytes(
                "data: "
                    + new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject
                        {
                            ["output"] = new JsonArray(
                                output.Select(item => (JsonNode)item).ToArray()
                            ),
                        },
                    }.ToJsonString()
                    + "\n\n"
            )
        );

    private static ResponsesClientOptions Options(Uri uri) => new(uri, "wire", "a", "", "", 713);

    private static string Output(SessionOwner owner, string callId) =>
        owner
            .History()
            .Where(row => SessionWait.Text(row["role"]) == "tool")
            .SelectMany(row => row["parts"]!.AsArray())
            .Select(part => part!["functionResponse"]!)
            .Last(response => SessionWait.Text(response["tool_use_id"]) == callId)["response"]![
            "output"
        ]!.GetValue<string>();

    private static int Occurrences(string text, string value)
    {
        var count = 0;
        for (
            var index = text.IndexOf(value, StringComparison.Ordinal);
            index >= 0;
            index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal)
        )
            count++;
        return count;
    }

    private static async Task UntilAsync(Func<bool> condition, string description)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(20);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
                throw new TimeoutException(description);
            await Task.Delay(20);
        }
    }

    private static async Task RunParentAsync(ScriptFixture f)
    {
        await f.Owner.Entry.SaveLane.AdmitAsync(
            QueueItem.UserText("split the work"),
            SaveKind.Strict
        );
        await f
            .Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id)
            .WaitAsync(TimeSpan.FromSeconds(20));
    }

    [Fact]
    public async Task Tool_created_fork_returns_in_both_sessions_and_the_child_starts_from_its_own_call()
    {
        ScriptFixture f = null!;
        var childBodies = new List<string>();
        await using var peer = new ScriptedResponsesSequenceServer(
            4,
            async (_, stream, request) =>
            {
                var body = request.Body;
                if (
                    body.Contains(
                        "Fork complete: you are the child session",
                        StringComparison.Ordinal
                    )
                )
                {
                    lock (childBodies)
                        childBodies.Add(body);
                    // The first child reply omits a report so the existing reminder must follow.
                    await Respond(
                        stream,
                        Final(
                            body.Contains("child-reminder", StringComparison.Ordinal)
                                ? "[NO_ACTION]"
                                : "child part done"
                        )
                    );
                }
                else if (!body.Contains("function_call_output", StringComparison.Ordinal))
                    await Respond(
                        stream,
                        Call(
                            "fork-call",
                            "create_child_session",
                            new()
                            {
                                ["suffix"] = "worker",
                                ["fork"] = true,
                                ["message"] = Assignment,
                            }
                        ),
                        Call(
                            "parent-read",
                            "read",
                            new() { ["filePath"] = Path.Combine(f.Work, "known.txt") }
                        )
                    );
                else
                    await Respond(stream, Final("parent part done"));
            }
        );
        await using var fixture = await ScriptFixture.Create(
            suppliedOptions: Options(peer.BaseUri)
        );
        f = fixture;
        await File.WriteAllTextAsync(Path.Combine(f.Work, "known.txt"), "parent-only content");
        var childId = f.Owner.Id + "_worker";

        await RunParentAsync(f);
        await UntilAsync(
            () =>
                peer.RequestCount == 4
                && f.Manager.Find(childId) is { } created
                && !created.Entry.Snapshot().Busy
                && !created.Processing,
            "forked child turn and its reminder turn"
        );

        var parentResult = Output(f.Owner, "fork-call");
        Assert.StartsWith(
            $"Child session created: `{childId}` (fork). You are the parent session `{f.Owner.Id}`",
            parentResult
        );
        Assert.Contains("has started on this call's message", parentResult);
        Assert.Contains("parent-only content", Output(f.Owner, "parent-read"));

        var child = f.Manager.Find(childId)!;
        Assert.Equal(
            SessionBoundary.ForkChildResult(f.Owner.Id, childId, null, instructed: true),
            Output(child, "fork-call")
        );
        Assert.Equal(SessionBoundary.ForkSkippedCall(f.Owner.Id), Output(child, "parent-read"));
        // The instruction exists only as the copied call argument: no separate delivery.
        static string Json(IEnumerable<JsonObject> rows) =>
            new JsonArray(rows.Select(row => (JsonNode)row.DeepClone()).ToArray()).ToJsonString();
        var callRow = f
            .Owner.History()
            .Single(row =>
                row.ToJsonString().Contains("fork-call", StringComparison.Ordinal)
                && SessionWait.Text(row["role"]) == "model"
            );
        Assert.True(Occurrences(callRow.ToJsonString(), Assignment) > 0);
        Assert.Equal(
            Occurrences(callRow.ToJsonString(), Assignment),
            Occurrences(Json(child.History()), Assignment)
        );
        Assert.Equal(1, Occurrences(childBodies[0], Assignment));
        Assert.Equal(2, childBodies.Count);
        Assert.Contains("child-reminder", childBodies[1]);
        Assert.True(
            child.Entry.Snapshot().AuthorityEnvelope["childHandoffState"]![
                "resolved"
            ]!.GetValue<bool>()
        );
        Assert.Null(child.Entry.LastBackgroundProcessorFailure);
    }

    [Fact]
    public async Task Fork_without_instruction_stays_idle_and_task_fork_omits_the_visible_message_from_its_assignment()
    {
        ScriptFixture f = null!;
        string? taskId = null;
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (_, stream, request) =>
            {
                if (!request.Body.Contains("function_call_output", StringComparison.Ordinal))
                    await Respond(
                        stream,
                        Call(
                            "idle-fork",
                            "create_child_session",
                            new() { ["suffix"] = "idle", ["fork"] = true }
                        ),
                        Call(
                            "task-fork",
                            "create_child_session",
                            new()
                            {
                                ["suffix"] = "tasked",
                                ["fork"] = true,
                                ["taskId"] = taskId,
                                ["message"] = Assignment,
                            }
                        )
                    );
                else
                    await Respond(stream, Final("parent done"));
            }
        );
        await using var fixture = await ScriptFixture.Create(
            suppliedOptions: Options(peer.BaseUri)
        );
        f = fixture;
        var created = await f.Manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "forked task",
                ["description"] = "task body",
            },
            f.Owner.Id
        );
        taskId = SessionWait.Text(created.Payload["task"]!["id"]);
        var taskedId = f.Owner.Id + "_tasked";
        f.Manager.TopologyChanged += () =>
        {
            if (f.Manager.Find(taskedId) is { } tasked)
                tasked.Registry.TriggerOverride = _ => Task.CompletedTask;
        };

        await RunParentAsync(f);
        Assert.Equal(2, peer.RequestCount);

        var idleId = f.Owner.Id + "_idle";
        var idle = f.Manager.Find(idleId)!;
        Assert.Contains("It stays idle until it receives a message.", Output(f.Owner, "idle-fork"));
        Assert.Equal(
            SessionBoundary.ForkChildResult(f.Owner.Id, idleId, null, instructed: false),
            Output(idle, "idle-fork")
        );
        Assert.Equal(SessionBoundary.ForkSkippedCall(f.Owner.Id), Output(idle, "task-fork"));
        Assert.Empty(idle.Entry.Snapshot().Queue);
        Assert.Null(idle.Entry.Snapshot().AuthorityEnvelope["childHandoffState"]);

        var tasked = f.Manager.Find(taskedId)!;
        Assert.Contains("Task assignment sent.", Output(f.Owner, "task-fork"));
        Assert.Equal(
            SessionBoundary.ForkChildResult(f.Owner.Id, taskedId, taskId, instructed: true),
            Output(tasked, "task-fork")
        );
        var assignment = new JsonArray(
            Assert
                .Single(tasked.Entry.Snapshot().Queue)
                .Parts!.Select(part => (JsonNode)part.DeepClone())
                .ToArray()
        ).ToJsonString();
        Assert.Contains(taskId!, assignment);
        Assert.Contains("task body", assignment);
        Assert.DoesNotContain(Assignment, assignment);
    }

    [Fact]
    public async Task ToolScript_fork_cannot_see_the_inner_call_and_still_receives_its_message()
    {
        ScriptFixture f = null!;
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (_, stream, request) =>
            {
                if (!request.Body.Contains("function_call_output", StringComparison.Ordinal))
                    await Respond(
                        stream,
                        Call(
                            "script",
                            "run_script",
                            new()
                            {
                                ["code"] =
                                    "return call_tool('create_child_session', {'suffix':'worker','fork':True,'message':args['m']})",
                                ["args"] = new JsonObject { ["m"] = Assignment },
                            }
                        )
                    );
                else
                    await Respond(stream, Final("parent done"));
            }
        );
        await using var fixture = await ScriptFixture.Create(
            suppliedOptions: Options(peer.BaseUri)
        );
        f = fixture;
        var childId = f.Owner.Id + "_worker";
        f.Manager.TopologyChanged += () =>
        {
            if (f.Manager.Find(childId) is { } created)
                created.Registry.TriggerOverride = _ => Task.CompletedTask;
        };

        await RunParentAsync(f);
        Assert.Equal(2, peer.RequestCount);
        var child = f.Manager.Find(childId)!;
        Assert.Equal(SessionBoundary.ForkSkippedCall(f.Owner.Id), Output(child, "script"));
        var delivered = Assert.Single(child.Entry.Snapshot().Queue);
        Assert.Equal(QueueItemType.Intersession, delivered.Type);
        Assert.Contains(
            Assignment,
            new JsonArray(
                delivered.Parts!.Select(part => (JsonNode)part.DeepClone()).ToArray()
            ).ToJsonString()
        );
    }
}
