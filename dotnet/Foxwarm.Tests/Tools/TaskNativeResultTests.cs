using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class TaskNativeResultTests
{
    private static async Task<ScriptFixture> Create(ResponsesClientOptions? options = null)
    {
        var f = await ScriptFixture.Create(suppliedOptions: options);
        var definitions = new JsonArray();
        foreach (
            var definition in ToolScriptToolDefinitions
                .Definitions()
                .Concat(UnifiedToolDefinitions.All())
                .Concat(AgentToolDefinitions.Definitions())
        )
            definitions.Add(definition?.DeepClone());
        f.Registry = SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work);
        f.Tools = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            f.Owner,
            f.Manager,
            f.Registry
        );
        f.Tools.BeginTurn();
        return f;
    }

    [Theory]
    [InlineData("task")]
    [InlineData("call_tool")]
    [InlineData("run_script")]
    public async Task Direct_unified_and_Monty_task_values_keep_native_receipts_and_detail_queries(
        string entry
    )
    {
        await using var f = await Create();
        async Task<JsonObject> Call(JsonObject args)
        {
            if (entry == "task")
                return await f.Call(entry, args);
            if (entry == "call_tool")
                return await f.Call(
                    entry,
                    new JsonObject { ["toolId"] = "builtin:task", ["args"] = args }
                );
            var run = await f.Call(
                entry,
                new JsonObject
                {
                    ["code"] = "return call_tool('builtin:task', args)",
                    ["args"] = args,
                }
            );
            Assert.True(SessionWait.Text(run["status"]) == "completed", run.ToJsonString());
            return run["result"]!.AsObject();
        }
        static void Receipt(JsonObject value, string id, string status, string? owner)
        {
            Assert.Equal(
                new[] { "ownerSessionId", "sentNotifications", "status", "taskId" },
                value.Select(pair => pair.Key).Order()
            );
            Assert.Equal(id, SessionWait.Text(value["taskId"]));
            Assert.Equal(status, SessionWait.Text(value["status"]));
            Assert.Equal(owner, SessionWait.Text(value["ownerSessionId"]));
            Assert.Equal(0, value["sentNotifications"]!.GetValue<int>());
        }
        var created = await Call(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "native task",
                ["description"] = "original scope",
            }
        );
        Assert.Null(created["error"]);
        var id = created["taskId"]!.GetValue<string>();
        Receipt(created, id, "open", null);
        var formatted = Foxwarm.ConfigurationYaml.Parse(
            ToolResponseFormatting.Format(created),
            "task receipt"
        );
        Assert.True(JsonNode.DeepEquals(created, formatted));
        Receipt(
            await Call(new JsonObject { ["action"] = "claim", ["taskId"] = id }),
            id,
            "active",
            f.Owner.Id
        );
        Receipt(
            await Call(
                new JsonObject
                {
                    ["action"] = "update",
                    ["taskId"] = id,
                    ["title"] = "renamed task",
                    ["notifySession"] = true,
                }
            ),
            id,
            "active",
            f.Owner.Id
        );
        Assert.Equal(
            "renamed task",
            SessionWait.Text(
                (await Call(new JsonObject { ["action"] = "get", ["taskId"] = id }))["task"]?[
                    "title"
                ]
            )
        );
        var progress = new string('n', 1998) + "😀";
        Receipt(
            await Call(
                new JsonObject
                {
                    ["action"] = "update",
                    ["taskId"] = id,
                    ["title"] = "revised task",
                    ["description"] = "revised scope",
                    ["note"] = progress,
                }
            ),
            id,
            "active",
            f.Owner.Id
        );
        Receipt(
            await Call(
                new JsonObject
                {
                    ["action"] = "assign",
                    ["taskId"] = id,
                    ["ownerSessionId"] = f.Owner.Id,
                    ["notifySession"] = true,
                }
            ),
            id,
            "active",
            f.Owner.Id
        );
        var listed = await Call(new JsonObject { ["action"] = "list" });
        Assert.Null(listed["output"]);
        Assert.Equal(id, Assert.Single(listed["tasks"]!.AsArray())!["id"]!.GetValue<string>());
        Assert.Equal(
            "revised task",
            SessionWait.Text(Assert.Single(listed["tasks"]!.AsArray())?["title"])
        );
        var detail = await Call(new JsonObject { ["action"] = "get", ["taskId"] = id });
        Assert.Null(detail["output"]);
        Assert.Equal(f.Owner.Id, SessionWait.Text(detail["task"]?["createdBySessionId"]));
        Assert.Equal("revised scope", SessionWait.Text(detail["task"]?["description"]));
        Assert.Equal("revised task", SessionWait.Text(detail["task"]?["title"]));
        Assert.Contains(
            detail["notes"]!.AsArray(),
            note => SessionWait.Text(note?["text"]) == progress
        );
        var rejected = await Call(
            new JsonObject
            {
                ["action"] = "update",
                ["taskId"] = id,
                ["description"] = "must not be written",
                ["note"] = progress + "x",
                ["notifySession"] = true,
            }
        );
        Assert.Equal("TASK_INVALID_ARGS", SessionWait.Text(rejected["error"]?["type"]));
        Assert.True(
            JsonNode.DeepEquals(
                detail,
                await Call(new JsonObject { ["action"] = "get", ["taskId"] = id })
            )
        );
        Receipt(
            await Call(
                new JsonObject
                {
                    ["action"] = "complete",
                    ["taskId"] = id,
                    ["result"] = "done",
                }
            ),
            id,
            "completed",
            f.Owner.Id
        );
        detail = await Call(new JsonObject { ["action"] = "get", ["taskId"] = id });
        Assert.Equal("done", SessionWait.Text(detail["task"]?["result"]));
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        Assert.Empty(f.Tools.ConsumeReceipts());
        var cancelled = await Call(
            new JsonObject { ["action"] = "create", ["title"] = "cancel me" }
        );
        var cancelledId = cancelled["taskId"]!.GetValue<string>();
        Receipt(
            await Call(
                new JsonObject
                {
                    ["action"] = "cancel",
                    ["taskId"] = cancelledId,
                    ["reason"] = "not needed",
                }
            ),
            cancelledId,
            "cancelled",
            null
        );
    }

    [Fact]
    public async Task Ordinary_nested_Monty_passes_created_taskId_to_real_child_assignment_without_decoding()
    {
        await using var peer = new LoopbackResponsesServer(
            async (stream, _) =>
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    System.Text.Encoding.UTF8.GetBytes(
                        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"assignment consumed\"}]}]}}\n\n"
                    )
                )
        );
        await using var f = await Create(
            new ResponsesClientOptions(peer.BaseUri, "wire", "a", "", "", 713)
        );
        var run = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('run_script', {'code':args['code'], 'args':args['input']})['result']",
                ["args"] = new JsonObject
                {
                    ["code"] =
                        "created = call_tool(\"task\", args[\"task\"])\nchild = call_tool(\"create_child_session\", dict(args[\"child\"], taskId=created[\"taskId\"]))\nreturn {'created':created, 'child':child, 'detail':call_tool('task', {'action':'get', 'taskId':created['taskId']})}",
                    ["input"] = new JsonObject
                    {
                        ["task"] = new JsonObject
                        {
                            ["action"] = "create",
                            ["title"] = "dependent assignment",
                            ["description"] = "complete assigned work",
                        },
                        ["child"] = new JsonObject { ["suffix"] = "native-task-child" },
                    },
                },
            }
        );
        Assert.True(SessionWait.Text(run["status"]) == "completed", run.ToJsonString());
        var result = run["result"]!;
        var id = result["created"]!["taskId"]!.GetValue<string>();
        var task = result["detail"]!["task"]!;
        Assert.Equal(id, SessionWait.Text(task["id"]));
        var childId = task["attachedSessionId"]!.GetValue<string>();
        Assert.Equal(childId, SessionWait.Text(task["ownerSessionId"]));
        Assert.Equal(f.Owner.Id, SessionWait.Text(task["createdBySessionId"]));
        Assert.Equal(1, result["child"]!["sentNotifications"]!.GetValue<int>());
        var child = await f.Manager.RequiredAsync(childId);
        Assert.Equal(
            f.Owner.Id,
            child.Entry.Snapshot().AuthorityEnvelope["parentSessionId"]?.GetValue<string>()
        );
        await child.DrainForegroundAsync();
        Assert.Equal(1, peer.RequestCount);
        Assert.Empty(child.Entry.Snapshot().Queue);
        var assignment = child
            .Entry.Snapshot()
            .History.Materialize()
            .Single(message => message.ToJsonString().Contains("complete assigned work"));
        Assert.Contains(id, assignment.ToJsonString());
        Assert.Contains("complete assigned work", assignment.ToJsonString());
        Assert.Null(result["created"]?["output"]);
        Assert.Null(result["detail"]?["__toolPostAction"]);
        Assert.Empty(f.Tools.ConsumeReceipts());
    }
}
