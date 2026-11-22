using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

// A forked child with a message starts with a report-required boundary, so these tests
// drive the real child turn loop and observe the reminders and the parent's notices.
public sealed class ChildReminderCapTests
{
    private const string ChildMarker = "Fork complete: you are the child session";
    private const string Notice = "type=\"child-report-missing\"";

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

    private static string Text(IEnumerable<JsonObject> parts) =>
        string.Join(
            "\n",
            parts.Select(part =>
                SessionWait.Text(part["system"]) ?? SessionWait.Text(part["text"])
            )
        );

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

    // The parent may or may not have consumed its notices yet; count both places.
    private static string[] Notices(SessionOwner parent)
    {
        var snapshot = parent.Entry.Snapshot();
        var history = parent
            .History()
            .Select(row => Text((row["parts"] as JsonArray ?? []).OfType<JsonObject>()));
        var queued = snapshot.Queue.Select(item => Text(item.Parts ?? []));
        return history.Concat(queued).Where(text => text.Contains(Notice)).ToArray();
    }

    private static int Reminders(SessionOwner child) =>
        child
            .History()
            .Count(row =>
                Text((row["parts"] as JsonArray ?? []).OfType<JsonObject>())
                    .Contains("event=\"missing-handoff\"", StringComparison.Ordinal)
            );

    private sealed class Scenario(Func<int, JsonObject[]> child) : IAsyncDisposable
    {
        private int childRequests;
        public ScriptFixture F = null!;
        public ScriptedResponsesSequenceServer Peer = null!;
        public int ChildRequests => Volatile.Read(ref childRequests);
        public string ChildId => F.Owner.Id + "_worker";
        public SessionOwner Child => F.Manager.Find(ChildId)!;

        public async Task StartAsync()
        {
            Peer = new ScriptedResponsesSequenceServer(
                24,
                async (_, stream, request) =>
                {
                    var body = request.Body;
                    if (body.Contains(ChildMarker, StringComparison.Ordinal))
                    {
                        var index = Interlocked.Increment(ref childRequests) - 1;
                        await Respond(stream, child(index));
                    }
                    else if (
                        !body.Contains("function_call_output", StringComparison.Ordinal)
                        && !body.Contains("child-report-missing", StringComparison.Ordinal)
                    )
                        await Respond(
                            stream,
                            Call(
                                "fork-call",
                                "create_child_session",
                                new()
                                {
                                    ["suffix"] = "worker",
                                    ["fork"] = true,
                                    ["message"] = "do the assigned part",
                                }
                            )
                        );
                    else
                        await Respond(stream, Final("parent noted"));
                }
            );
            F = await ScriptFixture.Create(
                suppliedOptions: new ResponsesClientOptions(Peer.BaseUri, "wire", "a", "", "", 713)
            );
            await F.Owner.Entry.SaveLane.AdmitAsync(
                QueueItem.UserText("split the work"),
                SaveKind.Strict
            );
            await F
                .Owner.Registry.Runner.ProcessQueueAsync(F.Owner.Id)
                .WaitAsync(TimeSpan.FromSeconds(20));
        }

        public Task SettledAsync(int expectedChildRequests, string description) =>
            UntilAsync(
                () =>
                    ChildRequests >= expectedChildRequests
                    && F.Manager.Find(ChildId) is { } created
                    && !created.Entry.Snapshot().Busy
                    && !created.Processing
                    && created.Entry.Snapshot().Queue.Count == 0
                    && !F.Owner.Entry.Snapshot().Busy
                    && !F.Owner.Processing,
                description
            );

        public async ValueTask DisposeAsync()
        {
            if (F is not null)
                await F.DisposeAsync();
            if (Peer is not null)
                await Peer.DisposeAsync();
        }
    }

    [Fact]
    public async Task Prefixed_no_action_reply_to_a_reminder_ends_the_boundary_without_another_reminder()
    {
        await using var s = new Scenario(index =>
            [
                Final(
                    index == 0 ? "child part done" : "[NO_ACTION]\n\nStill blocked; nothing to add."
                ),
            ]
        );
        await s.StartAsync();
        await s.SettledAsync(2, "child turn and its single reminder turn");

        Assert.Equal(2, s.ChildRequests);
        Assert.Equal(1, Reminders(s.Child));
        var state = s.Child.Entry.Snapshot().AuthorityEnvelope["childHandoffState"]!;
        Assert.True(state["resolved"]!.GetValue<bool>());
        Assert.Null(state["consecutiveReminders"]);
        Assert.Empty(Notices(s.F.Owner));
    }

    [Fact]
    public async Task Two_text_only_reminder_replies_stop_the_reminders_and_notify_the_parent_once()
    {
        await using var s = new Scenario(index => [Final($"still working, reply {index}")]);
        await s.StartAsync();
        await s.SettledAsync(3, "child turn and two reminder turns");

        Assert.Equal(3, s.ChildRequests);
        Assert.Equal(2, Reminders(s.Child));
        var envelope = s.Child.Entry.Snapshot().AuthorityEnvelope;
        Assert.True(SessionBoundary.NeedsChildHandoff(envelope));
        Assert.Equal(2, SessionBoundary.ConsecutiveChildReminders(envelope));
        Assert.True(SessionBoundary.ChildReminderCapNotified(envelope));

        var notice = Assert.Single(Notices(s.F.Owner));
        Assert.Contains($"childSessionId=\"{s.ChildId}\"", notice);
        Assert.Contains("still working, reply 2", notice);
        Assert.DoesNotContain("still working, reply 1", notice);

        // The persisted count survives a reload of the child's authority.
        var reloaded = await s.F.Manager.Find(s.ChildId)!.AuthorityStore.LoadAsync(s.ChildId);
        Assert.Equal(2, SessionBoundary.ConsecutiveChildReminders(reloaded!.AuthorityEnvelope));
    }

    [Fact]
    public async Task A_tool_call_in_a_reminder_reply_restarts_the_count()
    {
        // Any tool call counts, including one whose result is an error.
        await using var s = new Scenario(index =>
            index == 1
                ? [Call("child-read", "read", new() { ["filePath"] = "missing-file.txt" })]
                : [Final($"text reply {index}")]
        );
        await s.StartAsync();
        // Requests: first reply, reminder 1 answered by a tool call, its text after the
        // tool, then reminders 2 and 3 answered with text only.
        await s.SettledAsync(5, "tool reply resets the run before the cap");

        Assert.Equal(5, s.ChildRequests);
        Assert.Equal(3, Reminders(s.Child));
        var notice = Assert.Single(Notices(s.F.Owner));
        Assert.Contains("text reply 4", notice);
    }

    [Fact]
    public async Task New_input_restarts_the_count_and_a_later_cap_notifies_again()
    {
        await using var s = new Scenario(index => [Final($"text reply {index}")]);
        await s.StartAsync();
        await s.SettledAsync(3, "first reminder run");
        Assert.Single(Notices(s.F.Owner));

        var child = s.Child;
        await child.Entry.SaveLane.AdmitAsync(
            new QueueItem(
                QueueItemType.Background,
                [
                    new JsonObject
                    {
                        ["system"] =
                            "<foxwarm-system kind=\"event\" type=\"background-process-finished\">\nok\n</foxwarm-system>",
                    },
                ]
            ),
            SaveKind.Strict
        );
        Assert.Equal(
            2,
            SessionBoundary.ConsecutiveChildReminders(child.Entry.Snapshot().AuthorityEnvelope)
        );
        child.Registry.Trigger(child.Id);
        await s.SettledAsync(6, "second reminder run after new input");

        Assert.Equal(6, s.ChildRequests);
        Assert.Equal(4, Reminders(child));
        var notices = Notices(s.F.Owner);
        Assert.Equal(2, notices.Length);
        Assert.Contains("text reply 5", notices[1]);
        Assert.Equal(
            2,
            Occurrences(string.Join("\n", notices), "type=\"child-report-missing\"")
        );
    }
}
