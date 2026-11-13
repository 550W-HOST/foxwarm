using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CommandAdministrationTests
{
    [Theory]
    [InlineData("/")]
    [InlineData("/home/example/project/file.cs\nPlease inspect this file.  ")]
    [InlineData("/unknown explain this")]
    [InlineData("/session/archive")]
    [InlineData("/stop.txt")]
    [InlineData("/stop-extra")]
    [InlineData("/STOP")]
    [InlineData("/Stop")]
    [InlineData("/stpo")]
    [InlineData("\u0085/stop")]
    [InlineData("/stop\u0085compact")]
    [InlineData("/session\u0085move renamed")]
    public async Task Non_command_slash_input_is_admitted_verbatim_with_parts_and_client_identity(
        string text
    )
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        Assert.False(MessageRouter.IsKnownCommand(text));
        var attachment = new JsonObject
        {
            ["inlineDataRef"] = await f.Manager.Images.PutAsync(
                ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png),
                "image/png",
                "slash-image"
            ),
        };
        var parts = new[]
        {
            new JsonObject { ["text"] = text },
            attachment,
        };
        var response = await f.Router.HandleMessageAsync(
            new ChannelContext(f.Owner.Id, "webui"),
            new ChannelMessage(text, "slash-parts", parts, ControlRequestId: "not-a-control")
        );
        Assert.Equal(202, response.Status);
        var item = Assert.Single(f.Owner.Entry.Snapshot().Queue);
        Assert.Equal("slash-parts", item.ClientMessageId);
        Assert.Equal(text, SessionWait.Text(item.Parts![1]["text"]));
        Assert.True(JsonNode.DeepEquals(attachment, item.Parts[2]));
        Assert.Equal("source", f.Owner.Id);
        Assert.Empty(f.Owner.History());
    }

    [Fact]
    public void Catalog_heads_use_Source_token_boundaries_and_preserve_multiline_arguments()
    {
        foreach (var entry in ExternalCommands.WebUiCommands())
        {
            var name = entry!["name"]!.GetValue<string>();
            foreach (var prefix in new[] { "", " \t", "\uFEFF", "\u2007" })
            {
                Assert.True(MessageRouter.IsKnownCommand(prefix + name));
                Assert.True(MessageRouter.IsKnownCommand(prefix + name + "\nmalformed args"));
                Assert.True(
                    MessageRouter.IsKnownCommand(
                        prefix + "@helper-name.\uFEFF" + name,
                        allowMention: true
                    )
                );
                Assert.False(MessageRouter.IsKnownCommand(prefix + name + "/file"));
                Assert.False(MessageRouter.IsKnownCommand(prefix + name + "-unknown"));
            }
        }
        Assert.True(
            MessageRouter.TryReadCommand(
                "\uFEFF/fork child first\nsecond  ",
                out var command,
                out var args
            )
        );
        Assert.Equal("/fork", command);
        Assert.Equal("child first\nsecond  ", args);
        Assert.False(MessageRouter.IsKnownCommand("@helper /stop"));
        Assert.False(MessageRouter.IsKnownCommand("@helper /unknown", allowMention: true));
    }

    [Fact]
    public async Task Known_malformed_commands_keep_validation_and_do_not_become_user_input()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        var replies = new List<string>();
        f.Owner.Changed += e =>
        {
            if (e.Kind == SessionEventKind.CommandReply)
                replies.Add(SessionWait.Text(e.Data?["parts"]?[0]?["text"])!);
        };
        foreach (var text in new[] { "/stop invalid", " \t/stop invalid", "\uFEFF/stop invalid" })
        {
            var response = await f.Router.HandleMessageAsync(
                new ChannelContext(f.Owner.Id, "webui"),
                new ChannelMessage(text, null)
            );
            Assert.Equal(200, response.Status);
            Assert.Contains("Usage:", replies.Last());
            Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        }
        var rejected = await f.Router.HandleMessageAsync(
            new ChannelContext(f.Owner.Id, "webui"),
            new ChannelMessage("/stop invalid", null, ControlRequestId: "bad-stop")
        );
        Assert.Equal(422, rejected.Status);
        rejected = await f.Router.HandleMessageAsync(
            new ChannelContext(f.Owner.Id, "test"),
            new ChannelMessage("/stop invalid", null)
        );
        Assert.Equal(422, rejected.Status);
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task External_unknown_slash_falls_back_without_weakening_authorization_or_materialization()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        var texts = new[]
        {
            "/unknown original\ntext  ",
            "/home/example/file",
            "/session/archive",
            "@helper /unknown",
        };
        foreach (var text in texts)
        {
            await f.Router.HandleExternalMessageAsync(source, Message(text));
            Assert.Contains(
                text,
                SessionWait.Text(f.Owner.Entry.Snapshot().Queue.Last().Parts![0]["system"])
            );
        }
        Assert.Empty(replies);
        var materialized = false;
        var image = await f.Manager.Images.PutAsync(
            ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png),
            "image/png",
            "external-slash-image"
        );
        await f.Router.HandleExternalMessageAsync(
            source,
            new ExternalChannelMessage(
                [new JsonObject { ["text"] = "/unknown with attachment" }],
                MaterializeParts: _ =>
                {
                    materialized = true;
                    return Task.FromResult<IReadOnlyList<JsonObject>>([
                        new JsonObject { ["text"] = "/unknown with attachment" },
                        new JsonObject { ["inlineDataRef"] = image.DeepClone() },
                    ]);
                }
            )
        );
        Assert.True(materialized);
        Assert.True(
            JsonNode.DeepEquals(
                image,
                f.Owner.Entry.Snapshot().Queue.Last().Parts![2]["inlineDataRef"]
            )
        );
        var queued = f.Owner.Entry.Snapshot().Queue.Count;
        await f.Router.HandleExternalMessageAsync(source, Message("/stop invalid"));
        Assert.Contains("Usage:", replies.Single());
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(
            source with
            {
                Sender = "999",
            },
            Message("/unknown")
        );
        Assert.Contains("Unauthorized", replies.Single());
        Assert.Equal(queued, f.Owner.Entry.Snapshot().Queue.Count);
    }

    [Theory]
    [InlineData("telegram")]
    [InlineData("matrix")]
    [InlineData("weixin")]
    [InlineData("wework")]
    [InlineData("qq")]
    public async Task Unknown_slash_guest_admission_uses_the_ordinary_channel_policy(string type)
    {
        var channel = ExternalChannelFixture.Channel();
        channel["type"] = type;
        channel["guestAgent"] = new JsonObject { ["agentId"] = "guest", ["isolated"] = false };
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = channel }
        );
        await f.Manager.CreateAgentAsync("guest", createMainSession: false);
        var replies = new List<string>();
        var source = Source(replies) with { Type = type, Sender = "999" };
        // Even direct command callers (Telegram) must decline unknown catalog heads
        // before command authorization, leaving ordinary guest admission to the Router.
        foreach (var text in new[] { "/stpo", "/Stop", "/unknown" })
            Assert.False(await f.Router.HandleExternalCommandAsync(source, text, null));
        Assert.Empty(replies);
        Assert.Null(f.Manager.ChannelBinding(source.Target));
        Assert.True(await f.Router.HandleExternalCommandAsync(source, "/stop", null));
        Assert.Contains("Unauthorized", Assert.Single(replies));
        Assert.Null(f.Manager.ChannelBinding(source.Target));
        replies.Clear();
        var materialized = false;
        await f.Router.HandleExternalMessageAsync(
            source,
            new ExternalChannelMessage(
                [new JsonObject { ["text"] = "/stpo" }],
                MaterializeParts: _ =>
                {
                    materialized = true;
                    return Task.FromResult<IReadOnlyList<JsonObject>>([]);
                }
            )
        );
        var id = f.Manager.ChannelBinding(source.Target)!["sessionId"]!.GetValue<string>();
        var guest = await f.Manager.RequiredAsync(id);
        Assert.Equal("guest", guest.Agent);
        Assert.Contains(
            "/stpo",
            SessionWait.Text(Assert.Single(guest.Entry.Snapshot().Queue).Parts![0]["system"])
        );
        Assert.False(materialized);
        Assert.Empty(replies);
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
    }
}
