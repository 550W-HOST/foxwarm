using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ClaudeRuntimeTests
{
    [Theory]
    [InlineData(false, "send")]
    [InlineData(true, "send")]
    [InlineData(false, "task")]
    [InlineData(false, "no-action")]
    public async Task Empty_EndConversation_requires_the_normal_child_report_and_uses_supported_guidance(
        bool removedHandoffFields,
        string completion
    )
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        string? taskId = null;
        SessionOwner child;
        if (completion == "task")
        {
            var created = await f.Main.Manager.Tasks.ExecuteAsync(
                new JsonObject { ["action"] = "create", ["title"] = "owned runtime work" },
                f.Main.Target.Id
            );
            taskId = created.Payload["task"]!["id"]!.GetValue<string>();
            var attached = await f.Main.Manager.Tasks.CreateAttachedChildAsync(
                taskId,
                f.Main.Target.Id,
                async () =>
                {
                    var result = await f.Main.Manager.CreateChildAsync(
                        f.Main.Target,
                        "report",
                        null,
                        null,
                        null,
                        null,
                        taskId: taskId,
                        runtime: "claude-code"
                    );
                    result.Child.Registry.TriggerOverride = _ => Task.CompletedTask;
                    return result.Child;
                }
            );
            child = attached.Child;
        }
        else
        {
            child = (
                await f.Main.Manager.CreateChildAsync(
                    f.Main.Target,
                    "report",
                    null,
                    null,
                    null,
                    null,
                    runtime: "claude-code"
                )
            ).Child;
            child.Registry.TriggerOverride = _ => Task.CompletedTask;
            await f.Main.Manager.SendAsync(
                f.Main.Target,
                child.Id,
                "assigned work requiring a decision"
            );
        }
        f.Owner = child;
        var calls = new JsonArray();
        if (completion == "send")
        {
            var args = new JsonObject();
            // Older callers still pass the removed review fields; they are ignored.
            if (removedHandoffFields)
                args["handoffRecall"] = "Report the completed assigned work to its parent.";
            args["sessionId"] = "<parent>";
            args["message"] = "completed once";
            args["currentSessionTurnAction"] = "continue";
            if (removedHandoffFields)
                args["handoffConfirmation"] =
                    "The assignment is complete and this is the required report.";
            calls.Add(Call("send_to_session", args));
        }
        if (completion == "task")
            calls.Add(
                Call(
                    "task",
                    new JsonObject
                    {
                        ["action"] = "complete",
                        ["taskId"] = taskId,
                        ["result"] = "completed once",
                    }
                )
            );
        await f.PeerAsync(
            new JsonObject
            {
                ["emptyOnce"] = true,
                ["answer"] = completion == "no-action" ? "[NO_ACTION]" : "done",
                ["calls"] = calls,
            }
        );
        await f.RunAsync(text: null);
        if (completion == "task")
        {
            // A Task assignment keeps its existing boundary decision. Empty success is not Task completion.
            Assert.Single(f.Lines("inputs.jsonl"));
            var pending = (
                await f.Main.Manager.Tasks.ExecuteAsync(
                    new JsonObject { ["action"] = "get", ["taskId"] = taskId },
                    null
                )
            ).Payload["task"]!;
            Assert.NotEqual("completed", pending["status"]!.GetValue<string>());
            await f.Main.Manager.SendAsync(
                f.Main.Target,
                child.Id,
                "complete the attached task and report its outcome"
            );
            await f.RunAsync(text: null);
        }
        Assert.Null(child.Entry.LastBackgroundProcessorFailure);
        Assert.False(SessionBoundary.NeedsChildHandoff(child.Entry.Snapshot().AuthorityEnvelope));
        Assert.Empty(child.Entry.Snapshot().Queue);
        var inputs = f.Lines("inputs.jsonl");
        Assert.Equal(2, inputs.Length);
        static string InputText(JsonObject input) =>
            string.Join(
                "\n",
                input["input"]!["message"]!["content"]!
                    .AsArray()
                    .Select(part => SessionWait.Text(part?["text"]))
            );
        var initial = InputText(inputs[0]);
        var reminder = InputText(inputs[1]);
        if (completion != "task")
        {
            Assert.Contains("child-reminder", reminder);
            AssertSupportedGuidance(reminder);
            AssertSupportedGuidance(initial);
        }
        else
        {
            Assert.Contains(taskId!, initial);
            var task = (
                await f.Main.Manager.Tasks.ExecuteAsync(
                    new JsonObject { ["action"] = "get", ["taskId"] = taskId },
                    null
                )
            ).Payload["task"]!;
            Assert.Equal("completed", task["status"]!.GetValue<string>());
        }
        var parentQueue = f.Main.Target.Entry.Snapshot().Queue;
        Assert.Equal(completion == "no-action" ? 0 : 1, parentQueue.Count);
        if (completion != "no-action")
        {
            Assert.Single(f.Lines("results.jsonl"));
            Assert.False(
                f.Lines("results.jsonl")[0]["result"]?["isError"]?.GetValue<bool>() ?? false
            );
        }
        // Empty native completion adds observations/reminder only, never a fake empty assistant row.
        Assert.DoesNotContain(
            child.Entry.Snapshot().History.Materialize(),
            row => SessionWait.Text(row["role"]) == "model" && row["parts"]!.AsArray().Count == 0
        );
    }

    [Fact]
    public async Task Ordinary_children_keep_their_finish_and_wait_guidance()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        var child = (
            await f.Main.Manager.CreateChildAsync(f.Main.Target, "ordinary", null, null, null, null)
        ).Child;
        child.Registry.TriggerOverride = _ => Task.CompletedTask;
        var boundary = child.Entry.Snapshot().History.Materialize()[0]["parts"]![0]![
            "system"
        ]!.GetValue<string>();
        await child.Entry.SaveLane.QueueChildReminderAsync(f.Main.Target.Id);
        var reminder = child.Entry.Snapshot().Queue.Single().Parts![0][
            "system"
        ]!.GetValue<string>();
        foreach (var input in new[] { boundary, reminder })
        {
            var choices = Regex
                .Matches(input, "currentSessionTurnAction: \\\"([^\\\"]+)\\\"")
                .Select(match => match.Groups[1].Value)
                .ToArray();
            Assert.Contains("end_turn", choices);
            Assert.Contains("wait", choices);
        }
    }

    private static void AssertSupportedGuidance(string input)
    {
        var choices = Regex
            .Matches(input, "currentSessionTurnAction: \\\"([^\\\"]+)\\\"")
            .Select(match => match.Groups[1].Value)
            .ToArray();
        Assert.NotEmpty(choices);
        Assert.All(choices, value => Assert.Equal("continue", value));
        Assert.DoesNotContain("handoffRecall", input);
        Assert.DoesNotContain("handoffConfirmation", input);
    }
}
