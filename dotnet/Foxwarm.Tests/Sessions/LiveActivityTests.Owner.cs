using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class LiveActivityTests
{
    [Fact]
    public void Committed_reasoning_and_summaries_since_the_latest_input_publish_once_per_change()
    {
        var owner = Busy(Owner());
        var events = new List<SessionRuntimeEvent>();
        owner.Changed += events.Add;
        Append(owner, User("Start"));
        Assert.Null(Activity(owner));
        Assert.Equal(0, StateChanges(events));

        Append(owner, Model(Thinking("**Planning the work**\nBody."), Exec("a", "Doing A")));
        Assert.Equal(("Planning the work", "Doing A", "tool"), Value(owner));
        Assert.Equal(1, StateChanges(events));
        // Results, body text and calls without a summary keep the activity and publish nothing.
        Append(owner, Result("a"));
        Append(owner, Model(new JsonObject { ["text"] = "Interim prose" }, Exec("b", null)));
        Append(owner, Result("b"));
        Assert.Equal(("Planning the work", "Doing A", "tool"), Value(owner));
        Assert.Equal(1, StateChanges(events));

        Append(owner, Model(Thinking("Plain reasoning\n**Not a heading**")));
        Append(owner, Model(Thinking("**Checking results**\nBody.")));
        Assert.Equal(("Checking results", "Doing A", "reasoning"), Value(owner));
        Assert.Equal(2, StateChanges(events));
        // Display-only rows are not evidence.
        var hidden = Model(Exec("hidden", "Hidden call"));
        hidden["modelVisible"] = false;
        Append(owner, hidden);
        Assert.Equal(("Checking results", "Doing A", "reasoning"), Value(owner));

        // The activity is presented only while the Session is busy.
        owner.Entry.WithState(state => state.Busy = false);
        Assert.Null(Activity(owner));
        Assert.Contains("activity", Busy(owner).RuntimeSnapshot().Select(pair => pair.Key));
        Assert.DoesNotContain(owner.History(), row => row.ToJsonString().Contains("\"activity\""));
    }

    [Fact]
    public void Every_delivered_input_starts_a_new_segment_and_bookkeeping_does_not()
    {
        var owner = Busy(Owner());
        Append(owner, User("Start"), Model(Exec("a", "Doing A")), Result("a"));
        Assert.Equal("Doing A", Value(owner).Tool);
        var taskReminder = System(
            "<foxwarm-system kind=\"task-reminder\" seq=\"9\">\nTask open\n</foxwarm-system>"
        );
        taskReminder["__meta"] = new JsonObject { ["taskReminder"] = true };
        var compacted = System(
            "<foxwarm-system kind=\"session-boundary\" event=\"compact-completed\" parentSessionId=\"(none)\" currentSessionId=\"s\" time=\"t\" />"
        );
        var compactGoal = Row(
            "user",
            new JsonObject
            {
                ["system"] =
                    "<foxwarm-system kind=\"session-boundary\" event=\"compact-completed\" currentSessionId=\"s\" />",
            },
            new JsonObject
            {
                ["system"] =
                    "<foxwarm-system kind=\"goal-reminder\" hint=\"h\">\nKeep going\n</foxwarm-system>",
            }
        );
        compactGoal["__meta"] = new JsonObject
        {
            ["goalReminder"] = true,
            ["goalReminderKind"] = "compact-completion",
        };
        foreach (
            var row in new[]
            {
                Result("a"),
                taskReminder,
                compacted,
                compactGoal,
                System("<foxwarm-system kind=\"session-settings-changed\" model=\"x\" />"),
                System("<foxwarm-system kind=\"session-boundary\" event=\"first-run\" currentSessionId=\"s\" />"),
                Row("user", new JsonObject { ["toolUseId"] = "a", ["text"] = "tool output" }),
            }
        )
        {
            Append(owner, row);
            Assert.Equal("Doing A", Value(owner).Tool);
        }
        foreach (
            var input in new[]
            {
                User("A correction while working"),
                System(
                    "<foxwarm-message type=\"inter-agent\" sourceSessionId=\"peer/one\">\nPeer report\n</foxwarm-message>"
                ),
                System(
                    "<foxwarm-system kind=\"event\" type=\"background-process-finished\">\nDone\n</foxwarm-system>"
                ),
            }
        )
        {
            Append(owner, input);
            Assert.Null(Activity(owner));
            Append(owner, Model(Exec("after", "After input")));
            Assert.Equal("After input", Value(owner).Tool);
        }
        // A context block also ends earlier evidence.
        var block = Row("user", new JsonObject { ["text"] = "Compacted summary" });
        block["__meta"] = new JsonObject { ["contextBlock"] = new JsonObject { ["id"] = 1 } };
        Append(owner, block);
        Assert.Null(Activity(owner));
        Append(owner, Model(Thinking("**After the block**")));
        Assert.Equal(("After the block", null, "reasoning"), Value(owner));
    }

    [Fact]
    public void A_running_call_marks_the_batch_position_and_routed_calls_have_summaries()
    {
        var owner = Busy(Owner());
        var routed = Call(
            "b3",
            "ctl",
            new JsonObject
            {
                ["command"] = "tool call node:worker/exec --args @args",
                ["values"] = new JsonObject
                {
                    ["args"] = new JsonObject { ["summary"] = "Third via ctl", ["command"] = "true" },
                },
            }
        );
        var mcp = Call(
            "b5",
            "ctl",
            new JsonObject
            {
                ["command"] = "tool call mcp:server/exec --args @args",
                ["values"] = new JsonObject
                {
                    ["args"] = new JsonObject { ["summary"] = "MCP lookalike" },
                },
            }
        );
        Append(
            owner,
            User("Start"),
            Model(
                Thinking("**Planning the batch**"),
                Exec("b1", "First in batch"),
                Exec("b2", null),
                routed,
                Exec("b4", "Fourth in batch"),
                mcp
            )
        );
        Assert.Equal(("Planning the batch", "Fourth in batch", "tool"), Value(owner));
        var events = new List<SessionRuntimeEvent>();
        owner.Changed += item =>
        {
            if (item.Kind == SessionEventKind.StateChanged)
                events.Add(item);
        };
        foreach (
            var (id, expected) in new[]
            {
                ("b1", "First in batch"),
                ("b2", "First in batch"),
                ("b3", "Third via ctl"),
                ("b4", "Fourth in batch"),
                ("b5", "Fourth in batch"),
            }
        )
        {
            var lease = owner.BeginTool(new JsonObject { ["id"] = id, ["name"] = "exec" });
            var runtime = owner.RuntimeSnapshot();
            Assert.Equal("running-tool", runtime["state"]!.GetValue<string>());
            Assert.Equal(expected, SessionWait.Text(runtime["activity"]!["tool"]));
            Assert.Equal("Planning the batch", SessionWait.Text(runtime["activity"]!["reasoning"]));
            owner.EndTool(lease);
        }
        // Between calls and after the batch, the whole committed segment counts again.
        Assert.Equal("Fourth in batch", Value(owner).Tool);
        // A running call outside the committed segment does not hide anything.
        var other = owner.BeginTool(new JsonObject { ["id"] = "elsewhere", ["name"] = "read" });
        Assert.Equal("Fourth in batch", Value(owner).Tool);
        owner.EndTool(other);
    }

    [Fact]
    public void Streaming_publishes_completed_headings_and_summaries_immediately_but_never_per_delta()
    {
        var owner = Busy(Owner());
        Append(owner, User("Start"), Model(Exec("a", "Committed earlier")));
        var events = new List<SessionRuntimeEvent>();
        owner.Changed += events.Add;
        var request = owner.BeginDraft();
        Assert.Equal("Committed earlier", Value(owner).Tool);
        var changes = StateChanges(events);
        ResponsesStreamProgress Progress(string reasoning, string? arguments)
        {
            var parts = new List<ResponsesStreamPart>
            {
                new(0, "reasoning", SummaryIndex: 0, Text: reasoning),
            };
            var calls = new List<ResponsesToolCallProgress>();
            if (arguments is not null)
            {
                parts.Add(new(1, "tool-call"));
                calls.Add(new(1, "call", "run_script", arguments));
            }
            return new(reasoning, "", calls, parts);
        }
        owner.PublishDraftProgress(Progress("**Inspecting", null));
        owner.PublishDraftProgress(Progress("**Inspecting the source", null));
        Assert.Equal(changes, StateChanges(events));
        owner.PublishDraftProgress(Progress("**Inspecting the source**\nBody", null));
        Assert.Equal(("Inspecting the source", "Committed earlier", "reasoning"), Value(owner));
        Assert.Equal(changes + 1, StateChanges(events));
        owner.PublishDraftProgress(Progress("**Inspecting the source**\nBody continues.", null));
        Assert.Equal(changes + 1, StateChanges(events));

        var reasoning = "**Inspecting the source**\nBody continues.";
        var prefix = "{\"summary\":\"Validate stream";
        owner.PublishDraftProgress(Progress(reasoning, prefix));
        owner.PublishDraftProgress(Progress(reasoning, prefix + "ing updates"));
        Assert.Equal(changes + 1, StateChanges(events));
        // The summary is published as soon as its string closes, not at the client argument throttle.
        owner.PublishDraftProgress(Progress(reasoning, prefix + "ing updates\",\"code\":\"unfinished"));
        Assert.Equal(("Inspecting the source", "Validate streaming updates", "tool"), Value(owner));
        Assert.Equal(changes + 2, StateChanges(events));
        for (var index = 0; index < 20; index++)
            owner.PublishDraftProgress(
                Progress(reasoning, prefix + "ing updates\",\"code\":\"" + new string('x', index))
            );
        Assert.Equal(changes + 2, StateChanges(events));

        // The committed row carries the same items: no extra publication.
        var committed = Model(
            Thinking(reasoning),
            Call(
                "call",
                "run_script",
                new JsonObject { ["summary"] = "Validate streaming updates", ["code"] = "1" }
            )
        );
        committed["__meta"] = new JsonObject { ["llmRequestId"] = request };
        Append(owner, committed);
        Assert.Equal(("Inspecting the source", "Validate streaming updates", "tool"), Value(owner));
        Assert.Equal(changes + 2, StateChanges(events));

        // A replaced attempt loses its uncommitted items.
        owner.BeginDraft();
        owner.PublishDraftProgress(Progress("**Retry heading**", null));
        Assert.Equal(("Retry heading", "Validate streaming updates", "reasoning"), Value(owner));
        owner.BeginDraft();
        Assert.Equal(("Inspecting the source", "Validate streaming updates", "tool"), Value(owner));
        owner.PublishDraftProgress(Progress("**Discarded**", null));
        owner.ClearDraft();
        Assert.Equal(("Inspecting the source", "Validate streaming updates", "tool"), Value(owner));
    }

    [Fact]
    public void Turn_end_clears_the_activity_and_recovery_derives_it_from_history()
    {
        var owner = Busy(Owner());
        Append(owner, User("Start"), Model(Exec("a", "Doing A")), Result("a"));
        Assert.Equal("Doing A", Value(owner).Tool);

        // A restarted owner of the same active Session recomputes it after the latest input.
        var recovered = Owner(owner.Entry.Snapshot());
        Assert.True(recovered.Entry.Snapshot().Busy);
        Assert.Equal("Doing A", Value(recovered).Tool);

        // The processor's end retires the activity, so a Continue without new input starts empty.
        owner.Entry.WithState(state => state.Busy = false);
        owner.StartProcessing().GetAwaiter().GetResult();
        Busy(owner);
        Assert.Null(Activity(owner));
        Append(owner, Model(Exec("c", "After Continue")));
        Assert.Equal("After Continue", Value(owner).Tool);
    }

    [Fact]
    public void Status_text_quotes_the_activity_and_names_the_latest_seq_beside_active_history()
    {
        var state = new JsonObject
        {
            ["state"] = "running-tool",
            ["queueLength"] = 2,
            ["activity"] = new JsonObject
            {
                ["reasoning"] = "Planning",
                ["tool"] = "Say \"hi\" \\ there",
                ["latest"] = "tool",
            },
        };
        Assert.Equal(
            "Session execution state: running-tool; activity: \"Say \\\"hi\\\" \\\\ there\"; queue: 2.",
            SessionStatus.Runtime(state)
        );
        state["activity"]!["latest"] = "reasoning";
        Assert.Equal(
            "Session execution state: running-tool; activity: \"Planning\"; queue: 2.",
            SessionStatus.Runtime(state)
        );
        state.Remove("activity");
        Assert.Equal("Session execution state: running-tool; queue: 2.", SessionStatus.Runtime(state));
        Assert.Equal("msg#71551 latest · 230 active", SessionStatus.Messages(71551, 230));
        Assert.Equal("0 active", SessionStatus.Messages(0, 0));

        var owner = Busy(Owner());
        Append(owner, User("Start"), Model(Exec("a", "Line one\nline two")));
        var dto = owner.BuildDto();
        Assert.Equal(2, dto["latestMessageSeq"]!.GetValue<long>());
        var row = SessionStatus.Row(dto);
        Assert.Equal(2, row["latestMessageSeq"]!.GetValue<long>());
        Assert.Equal(2, row["activeMessages"]!.GetValue<long>());
        Assert.Equal("Line one line two", row["activity"]!.GetValue<string>());
    }
}
