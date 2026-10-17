using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class DeferredInputTests
{
    private static QueueItem Wrapped(string id) =>
        new(
            QueueItemType.User,
            [
                new JsonObject
                {
                    ["system"] =
                        "<foxwarm-message type=\"user\" hint=\"original &amp; unchanged\" time=\"source-time\">\nbody "
                        + id,
                },
                new JsonObject
                {
                    ["attachment"] = new JsonObject
                    {
                        ["name"] = "fixture.txt",
                        ["path"] = "fixture.txt",
                    },
                },
                new JsonObject { ["system"] = "</foxwarm-message>" },
            ],
            ClientMessageId: id,
            OpenFields: new JsonObject { ["fixture"] = "preserved" }
        );

    [Fact]
    public void Channel_source_boundary_wraps_once_and_preserves_structured_input_parts()
    {
        var attachment = new JsonObject
        {
            ["attachment"] = new JsonObject { ["name"] = "fixture.txt", ["path"] = "fixture.txt" },
            ["other"] = "retained",
        };
        JsonObject[] original = [new JsonObject { ["text"] = "body" }, attachment];
        var prepared = SessionBoundary.ChannelInput(original, "webui");
        Assert.Equal(4, prepared.Count);
        Assert.Contains(
            "type=\"channel\" channelType=\"webui\"",
            prepared[0]["system"]!.GetValue<string>()
        );
        Assert.Contains(
            "hint=\"direct user message via channel\"",
            prepared[0]["system"]!.GetValue<string>()
        );
        Assert.True(JsonNode.DeepEquals(original[0], prepared[1]));
        Assert.True(JsonNode.DeepEquals(attachment, prepared[2]));
        Assert.Equal("</foxwarm-message>", prepared[3]["system"]!.GetValue<string>());
        Assert.DoesNotContain(
            "queueInputHint",
            string.Join("", prepared.Select(part => part.ToJsonString()))
        );
        prepared[2]["other"] = "changed projection";
        Assert.Equal("retained", attachment["other"]!.GetValue<string>());
        Assert.Single(
            SessionBoundary.ChannelInput([new JsonObject { ["text"] = "plain input" }], "webui")
        );
    }

    [Fact]
    public void Channel_source_boundary_preserves_plain_text_whitespace_and_chunk_separators()
    {
        const string first = "    indented body\n  trailing spaces  \n";
        const string second = "\tsecond chunk \n";
        var prepared = SessionBoundary.ChannelInput(
            [new JsonObject { ["text"] = first }, new JsonObject { ["text"] = second }],
            "webui"
        );
        var wrapper = Assert.Single(prepared)["system"]!.GetValue<string>();
        Assert.Equal(
            first + "\n" + second,
            wrapper[(wrapper.IndexOf('>') + 2)..^"\n</foxwarm-message>".Length]
        );
    }

    [Fact]
    public async Task Provider_time_ordinary_and_actual_background_exec_events_commit_hints_once_without_rewriting_initial_or_old_history()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new FakeChatService();
        var registry = new SessionRegistry(store, chat);
        var entry = registry.Add("s");
        registry.TriggerOverride = _ => Task.CompletedTask;
        var initial = Wrapped("initial");
        var initialParts = new JsonArray(
            initial.Parts!.Select(p => (JsonNode)p.DeepClone()).ToArray()
        ).ToJsonString();
        chat.EnqueuePlan(async _ =>
        {
            await registry.Ingress.EnqueueAsync("s", Wrapped("delayed"));
            Assert.True(
                await entry.SaveLane.CommitBackgroundExecCompletionAsync(
                    "owned-exec",
                    "<foxwarm-system kind=\"event\" type=\"exec\" hint=\"original event\">exec done</foxwarm-system>"
                )
            );
            return "first response";
        });
        chat.EnqueueResult("final");
        await registry.Ingress.EnqueueAsync("s", initial);
        await registry.Runner.ProcessQueueAsync("s");
        Assert.Equal(2, chat.Calls.Count);
        var rows = entry.Snapshot().History.Materialize().ToList();
        var initialRow = rows.Single(row =>
            SessionWait.Text(row["__meta"]?["clientMessageId"]) == "initial"
        );
        Assert.DoesNotContain("queueInputHint", initialRow.ToJsonString());
        var delayed = rows.Single(row =>
            SessionWait.Text(row["__meta"]?["clientMessageId"]) == "delayed"
        );
        Assert.Equal(3, delayed["parts"]!.AsArray().Count);
        var wrapper = delayed["parts"]![0]!["system"]!.GetValue<string>();
        Assert.Contains("hint=\"original &amp; unchanged\"", wrapper);
        Assert.Contains("time=\"source-time\"", wrapper);
        Assert.Contains("queueInputHint=\"Queued input:", wrapper);
        Assert.EndsWith("\nbody delayed", wrapper);
        Assert.True(JsonNode.DeepEquals(Wrapped("delayed").Parts![1], delayed["parts"]![1]));
        Assert.True(JsonNode.DeepEquals(Wrapped("delayed").Parts![2], delayed["parts"]![2]));
        var eventRow = rows.Single(row => row.ToJsonString().Contains("exec done"));
        Assert.Contains("queueInputHint", eventRow.ToJsonString());
        Assert.Equal(1, rows.IndexOf(eventRow) - rows.IndexOf(delayed));
        Assert.Contains(
            "queueInputHint",
            chat.Calls[1]
                .History.Single(row =>
                    SessionWait.Text(row["__meta"]?["clientMessageId"]) == "delayed"
                )
                .ToJsonString()
        );
        Assert.Equal(
            initialParts,
            new JsonArray(
                initial.Parts!.Select(p => (JsonNode)p.DeepClone()).ToArray()
            ).ToJsonString()
        );
        Assert.False(
            await entry.SaveLane.CommitBackgroundExecCompletionAsync("owned-exec", "duplicate")
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stop_and_RunQueued_preserve_deferred_observation_and_original_source_wrapper(
        bool runQueued
    )
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new FakeChatService();
        var registry = new SessionRegistry(store, chat);
        var entry = registry.Add("s");
        registry.TriggerOverride = _ => Task.CompletedTask;
        chat.EnqueuePlan(async token =>
        {
            await Task.Delay(Timeout.Infinite, token);
            return "unreachable";
        });
        chat.EnqueueResult("queued answer");
        await registry.Ingress.EnqueueAsync("s", Wrapped("initial"));
        var running = registry.Runner.ProcessQueueAsync("s");
        await chat.FirstCallStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await registry.Ingress.EnqueueAsync("s", Wrapped("delayed"));
        if (runQueued)
            await registry.Control.DequeueAsync("s");
        else
            await registry.Control.StopAsync("s");
        await running.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(runQueued ? 2 : 1, chat.Calls.Count);
        var row = entry
            .Snapshot()
            .History.Materialize()
            .Single(row => SessionWait.Text(row["__meta"]?["clientMessageId"]) == "delayed");
        Assert.Contains("queueInputHint", row.ToJsonString());
        Assert.Empty(entry.Snapshot().Queue);
        Assert.False(entry.Snapshot().Busy);
    }

    [Fact]
    public void Observation_survives_persisted_queue_cloning_and_only_decorates_the_existing_outer_wrapper()
    {
        var item = Wrapped("later");
        DeferredQueueInput.Mark([item]);
        var stored = PersistentSessionAuthorityStore.ToQueueJson(item);
        Assert.True(stored["queuedInput"]!.GetValue<bool>());
        Assert.Equal("preserved", stored["fixture"]!.GetValue<string>());
        var reopened = PersistentSessionAuthorityStore.FromQueueJson(stored).CloneItem();
        Assert.True(reopened.QueuedInput);
        var parts = new JsonArray(
            new JsonObject
            {
                ["system"] = "<foxwarm-system kind=\"session\" currentSessionId=\"s\" />",
            },
            new JsonObject { ["system"] = "<foxwarm-system kind=\"time\" />" }
        );
        foreach (var part in item.Parts!)
            parts.Add(part.DeepClone());
        var message = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = parts,
            ["extra"] = "retained",
        };
        DeferredQueueInput.Message(reopened, message);
        var once = message.ToJsonString();
        DeferredQueueInput.Message(reopened, message);
        Assert.Equal(once, message.ToJsonString());
        Assert.DoesNotContain("queueInputHint", parts[0]!.ToJsonString());
        Assert.Contains("queueInputHint", parts[2]!.ToJsonString());
        foreach (var role in new[] { "model", "tool" })
        {
            var excluded = new QueueItem(
                QueueItemType.Background,
                Message: new JsonObject { ["role"] = role, ["parts"] = parts.DeepClone() }
            );
            DeferredQueueInput.Mark([excluded]);
            Assert.False(excluded.QueuedInput);
        }
        var hidden = new QueueItem(
            QueueItemType.Background,
            Message: new JsonObject { ["role"] = "user", ["modelVisible"] = false }
        );
        var compact = new QueueItem(QueueItemType.CompactCommit);
        DeferredQueueInput.Mark([hidden, compact]);
        Assert.False(hidden.QueuedInput);
        Assert.False(compact.QueuedInput);
        foreach (
            var raw in new[]
            {
                "plain body <foxwarm-message>",
                "<foxwarm-system kind=\"time\">body <foxwarm-message></foxwarm-message></foxwarm-system>",
            }
        )
        {
            var unchanged = new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["system"] = raw }),
            };
            DeferredQueueInput.Message(reopened, unchanged);
            Assert.Equal(raw, unchanged["parts"]![0]!["system"]!.GetValue<string>());
        }
    }
}
