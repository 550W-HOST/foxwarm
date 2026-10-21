using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CommandAdministrationTests
{
    [Fact]
    public async Task Timer_list_real_WebUI_ingress_distinguishes_script_sources_and_retains_message_details_and_scope()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        f.Owner.Changed += e =>
        {
            if (e.Kind == SessionEventKind.CommandReply)
                replies.Add(e.Data!["parts"]![0]!["text"]!.GetValue<string>());
        };
        foreach (
            var script in new[]
            {
                new JsonObject { ["code"] = "return 7" },
                new JsonObject { ["filePath"] = "monitor.py", ["node"] = "master" },
                new JsonObject { ["filePath"] = "relative.py" },
            }
        )
            await f.Manager.ExecuteTimerToolAsync(
                f.Owner,
                "create_timer",
                new JsonObject
                {
                    ["action"] = "toolscript",
                    ["afterSeconds"] = 600,
                    ["script"] = script,
                },
                default
            );
        var other = await f.Manager.CreateNamedAsync("main", "other-timers", null, null);
        await f.Manager.ExecuteTimerToolAsync(
            other,
            "create_timer",
            new JsonObject { ["afterSeconds"] = 600, ["message"] = "foreign timer detail" },
            default
        );
        var context = new ChannelContext(f.Owner.Id, "webui");
        await f.Router.HandleMessageAsync(
            context,
            new ChannelMessage(
                "/timer after 600 --new-session --prefix watch -- message detail",
                null
            )
        );
        replies.Clear();
        var response = await f.Router.HandleMessageAsync(
            context,
            new ChannelMessage("/timer list", null)
        );
        Assert.Equal(200, response.Status);
        var listing = Assert.Single(replies);
        Assert.Contains("ToolScript (inline)", listing);
        Assert.Contains("master: monitor.py", listing);
        Assert.Contains("current: relative.py", listing);
        Assert.Contains("message detail", listing);
        Assert.Contains("watch", listing);
        Assert.DoesNotContain("foreign timer detail", listing);
        foreach (var timer in f.Manager.Timers.List(f.Owner.Id))
            Assert.Contains(SessionWait.Text(timer?["id"])!, listing);
        Assert.Empty(f.Owner.History());
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Timer_text_ingress_keeps_Source_single_token_presets_and_multi_field_limit_and_fires_real_owned_after_and_at_timers()
    {
        var expected = await SourceAsync(
            new JsonObject
            {
                ["command"] = "/timer",
                ["binding"] = "source",
                ["args"] = new JsonArray("cron", "@hourly", "--", "preset"),
            }
        );
        Assert.Equal("@hourly", SessionWait.Text(expected["effects"]![0]?["options"]?["cron"]));
        expected = await SourceAsync(
            new JsonObject
            {
                ["command"] = "/timer",
                ["binding"] = "source",
                ["args"] = new JsonArray("cron", "0", "*", "*", "*", "*", "--", "multi"),
            }
        );
        Assert.Equal("0", SessionWait.Text(expected["effects"]![0]?["options"]?["cron"]));
        Assert.Equal(
            "* * * * -- multi",
            SessionWait.Text(expected["effects"]![0]?["options"]?["message"])
        );
        expected = await SourceAsync(
            new JsonObject
            {
                ["command"] = "/timer",
                ["binding"] = "source",
                ["args"] = new JsonArray("cron", "\"0", "*", "*", "*", "*\"", "--", "quoted"),
            }
        );
        Assert.Empty(expected["effects"]!.AsArray());
        Assert.Contains(
            "failed",
            SessionWait.Text(expected["replies"]![0]),
            StringComparison.OrdinalIgnoreCase
        );
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        await f.Router.HandleExternalMessageAsync(source, Message("/timer cron @hourly -- preset"));
        Assert.Equal("@hourly", SessionWait.Text(f.Manager.Timers.List(f.Owner.Id)[0]?["cron"]));
        Assert.True(
            SessionWait.Number(f.Manager.Timers.List(f.Owner.Id)[0]?["nextRunAt"])
                > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        );
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/timer cron 0 * * * * -- multi")
        );
        Assert.Equal(2, f.Manager.Timers.List(f.Owner.Id).Count);
        Assert.Contains(
            f.Manager.Timers.List(f.Owner.Id),
            row =>
                SessionWait.Text(row?["cron"]) == "0"
                && SessionWait.Text(row?["message"]) == "* * * * -- multi"
        );
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/timer cron \"0 * * * *\" -- quoted")
        );
        Assert.Equal(2, f.Manager.Timers.List(f.Owner.Id).Count);
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/timer after 1 -- current after trigger")
        );
        await f.Router.HandleExternalMessageAsync(
            source,
            Message(
                "/timer at "
                    + DateTimeOffset.UtcNow.AddSeconds(1).ToString("O")
                    + " -- current at trigger"
            )
        );
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/timer after 1 --new-session --prefix command_timer -- fresh trigger")
        );
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.Snapshot().Queue.Count == 2
            && f.Manager.Catalog.List()
                .Any(row =>
                    SessionWait
                        .Text(row["id"])
                        ?.StartsWith("command_timer_", StringComparison.Ordinal) == true
                )
        );
        Assert.All(
            f.Owner.Entry.Snapshot().Queue,
            item => Assert.Equal(QueueItemType.Background, item.Type)
        );
        Assert.Contains(
            f.Owner.Entry.Snapshot().Queue,
            item =>
                string.Join("", item.Parts!.Select(part => part.ToJsonString()))
                    .Contains("current after trigger")
        );
        Assert.Contains(
            f.Owner.Entry.Snapshot().Queue,
            item =>
                string.Join("", item.Parts!.Select(part => part.ToJsonString()))
                    .Contains("current at trigger")
        );
        var fresh = f
            .Manager.Owners()
            .Single(owner => owner.Id.StartsWith("command_timer_", StringComparison.Ordinal));
        Assert.Empty(fresh.History());
        Assert.Equal("master", f.Manager.CurrentNode(fresh));
        Assert.Null(fresh.Metadata().ParentSessionId);
        Assert.Contains(
            fresh.Entry.Snapshot().Queue,
            item =>
                string.Join("", item.Parts!.Select(part => part.ToJsonString()))
                    .Contains("fresh trigger")
        );
    }

    [Theory]
    [InlineData("50", 10)]
    [InlineData("invalid", 6)]
    public async Task Manual_compact_text_passes_explicit_keep_or_configured_fallback_into_real_provider_preparation(
        string argument,
        int kept
    )
    {
        var captured = new TaskCompletionSource<string>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var provider = new ScriptedResponsesSequenceServer(
            1,
            async (_, stream, request) =>
            {
                captured.TrySetResult(request.Body);
                await release.Task;
                try
                {
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        Encoding.UTF8.GetBytes(
                            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n"
                        )
                    );
                }
                catch (IOException) { }
            }
        );
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() },
            provider.BaseUri
        );
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            Enumerable
                .Range(1, 20)
                .Select(index => new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(
                        new JsonObject { ["text"] = $"context {index} " + new string('x', 5000) }
                    ),
                })
                .ToArray()
        );
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        try
        {
            await f.Router.HandleExternalMessageAsync(source, Message("/compact " + argument));
            var body = JsonNode.Parse(await captured.Task.WaitAsync(TimeSpan.FromSeconds(10)))!;
            var text = string.Join(
                "\n",
                body["input"]!
                    .AsArray()
                    .OfType<JsonObject>()
                    .SelectMany(row => (row["content"] as JsonArray)?.OfType<JsonObject>() ?? [])
                    .Select(part => SessionWait.Text(part["text"]) ?? "")
            );
            Assert.Contains($"Recent messages ({kept} rendered item(s)", text);
            await f.Router.HandleExternalMessageAsync(source, Message("/stop compact"));
            Assert.Equal(20, f.Owner.History().Count);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task External_move_parser_preserves_target_first_grammar_and_actual_alias_attachment_and_parent_publication()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        await f.Manager.CreateAgentAsync("destination", createMainSession: false);
        var parent = await f.Manager.CreateNamedAsync("main", "parent", null, null);
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        var old = f.Owner.Id;
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session move --parent " + parent.Id + " destination/moved")
        );
        Assert.Equal(old, f.Owner.Id);
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session move destination/moved --parent " + parent.Id)
        );
        Assert.Equal("destination/moved", f.Owner.Id);
        Assert.Equal(
            "destination/moved",
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
        Assert.Equal(
            "destination/moved",
            SessionWait.Text(f.Manager.Catalog.Resolve(old)["sessionId"])
        );
        Assert.Equal(parent.Id, f.Owner.Metadata().ParentSessionId);
        Assert.Contains("Previous parent", replies.Single());
        Assert.Contains("Resulting parent", replies.Single());
        Assert.DoesNotContain("{", replies.Single());
    }

    [Fact]
    public async Task Command_replies_preserve_existing_timer_postcommit_truth_without_rolling_back_the_store()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        f.Manager.Timers.WriteStage = stage =>
        {
            if (stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)
                throw new IOException("synthetic postcommit failure");
        };
        try
        {
            await f.Router.HandleExternalMessageAsync(
                source,
                Message("/timer after 3600 -- committed timer")
            );
            var timer = f.Manager.Timers.List(f.Owner.Id).Single()!;
            var id = SessionWait.Text(timer["id"])!;
            Assert.Contains(id, replies.Single());
            Assert.Contains("committed", replies.Single(), StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("✅", replies.Single());
            replies.Clear();
            await f.Router.HandleExternalMessageAsync(source, Message("/timer delete " + id));
            Assert.Empty(f.Manager.Timers.List(f.Owner.Id));
            Assert.Contains(id, replies.Single());
            Assert.Contains("committed", replies.Single(), StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("✅", replies.Single());
        }
        finally
        {
            f.Manager.Timers.WriteStage = null;
        }
    }
}
