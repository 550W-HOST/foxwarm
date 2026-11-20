using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class CurrentSessionTurnActionTests
{
    private static List<JsonObject> HandoffExchange(string name, string key, string value)
    {
        var args = new JsonObject
        {
            ["sessionId"] = "main/recipient",
            ["message"] = "report",
            [key] = value,
        };
        return
        [
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "work" }),
            },
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "handoff",
                            ["name"] = name,
                            ["args"] = args,
                        },
                    }
                ),
            },
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "handoff",
                            ["name"] = name,
                            ["response"] = new JsonObject { ["output"] = "sent" },
                        },
                    }
                ),
            },
        ];
    }

    [Theory]
    [InlineData("send_to_session", "currentSessionTurnAction", "end_turn", false)]
    [InlineData("send_to_session", "currentSessionTurnAction", "wait", false)]
    [InlineData("create_child_session", "currentSessionTurnAction", "end_turn", false)]
    [InlineData("send_to_session", "currentSessionTurnAction", "continue", true)]
    [InlineData("send_to_session", "currentSessionTurnAction", "finish", true)]
    // History persisted before the rename keeps its classification.
    [InlineData("send_to_session", "afterSend", "finish", false)]
    [InlineData("create_child_session", "afterSend", "wait", false)]
    [InlineData("send_to_session", "afterSend", "continue", true)]
    public void Terminal_handoff_classification_reads_current_and_persisted_names(
        string name,
        string key,
        string value,
        bool incomplete
    ) =>
        Assert.Equal(
            incomplete,
            SessionContinuation.IsIncomplete(HandoffExchange(name, key, value))
        );

    [Fact]
    public async Task Live_calls_use_the_new_name_and_reject_the_old_one_before_effects()
    {
        await using var f = await ScriptFixture.Create();
        var target = await f.Manager.CreateNamedAsync("main", "recipient", null, null);
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        JsonObject Send(string key, string value) =>
            new()
            {
                ["sessionId"] = target.Id,
                ["message"] = "report " + key + " " + value,
                [key] = value,
            };

        foreach (
            var args in new[]
            {
                Send("afterSend", "finish"),
                Send("afterSend", "continue"),
                Send("currentSessionTurnAction", "finish"),
            }
        )
        {
            var rejected = await f.Manager.ExecuteAgentToolAsync(f.Owner, "send_to_session", args);
            Assert.NotNull(rejected.Response["error"]);
            Assert.False(rejected.Finish);
            if (args.ContainsKey("afterSend"))
                Assert.Contains(
                    "renamed to currentSessionTurnAction",
                    rejected.Response.ToJsonString()
                );
        }
        Assert.Empty(target.Entry.Snapshot().Queue);

        var ended = await f.Manager.ExecuteAgentToolAsync(
            f.Owner,
            "send_to_session",
            Send("currentSessionTurnAction", "end_turn")
        );
        Assert.Null(ended.Response["error"]);
        Assert.True(ended.Finish);
        Assert.Null(ended.Response["__waitTarget"]);

        var waiting = await f.Manager.ExecuteAgentToolAsync(
            f.Owner,
            "send_to_session",
            Send("currentSessionTurnAction", "wait")
        );
        Assert.False(waiting.Finish);
        Assert.Equal(target.Id, SessionWait.Text(waiting.Response["__waitTarget"]));

        var continued = await f.Manager.ExecuteAgentToolAsync(
            f.Owner,
            "send_to_session",
            Send("currentSessionTurnAction", "continue")
        );
        Assert.False(continued.Finish);
        Assert.Null(continued.Response["__waitTarget"]);
        Assert.Equal(3, target.Entry.Snapshot().Queue.Count);
    }
}
