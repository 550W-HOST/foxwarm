using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class MatrixChannelTests
{
    [Fact]
    public async Task Pinned_bootstrap_sync_membership_filters_instances_sender_identity_and_eager_media_use_real_router_and_storage()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject
            {
                ["alpha"] = peer.Matrix(),
                ["beta"] = peer.Matrix("matrix-b", "@bot-b:fixture"),
            },
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("alpha:!room:fixture", f.Owner);
        var other = await f.Manager.CreateNamedAsync("main", "other", null, null);
        f.Manager.AttachChannel("beta:!room:fixture", other);
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() =>
            peer.Calls.Count(call => call.Path.EndsWith("/sync", StringComparison.Ordinal)) >= 4
        );
        foreach (var key in new[] { "matrix-a", "matrix-b" })
        {
            var calls = peer.Calls.Where(call => call.Key == key).ToArray();
            Assert.EndsWith("/versions", calls[0].Path);
            Assert.Equal(
                new JsonObject().ToJsonString(),
                calls
                    .Single(call => call.Path.EndsWith("/filter", StringComparison.Ordinal))
                    .Body.ToJsonString()
            );
            var sync = calls
                .Where(call => call.Path.EndsWith("/sync", StringComparison.Ordinal))
                .ToArray();
            Assert.Equal(
                10,
                JsonNode.Parse(sync[0].Query["filter"])!["room"]!["timeline"]![
                    "limit"
                ]!.GetValue<int>()
            );
            Assert.Equal("0", sync[0].Query["timeout"]);
            Assert.Equal("fixture-filter", sync[1].Query["filter"]);
            Assert.Equal("initial", sync[1].Query["since"]);
            Assert.Equal("30000", sync[1].Query["timeout"]);
            Assert.Equal("true", sync[0].Query["org.matrix.msc4222.use_state_after"]);
        }
        peer.Push(
            "matrix-a",
            new JsonObject
            {
                ["next_batch"] = "invite",
                ["rooms"] = new JsonObject
                {
                    ["invite"] = new JsonObject
                    {
                        ["!invite:fixture"] = new JsonObject
                        {
                            ["invite_state"] = new JsonObject
                            {
                                ["events"] = new JsonArray(
                                    new JsonObject
                                    {
                                        ["type"] = "m.room.member",
                                        ["state_key"] = "@bot:fixture",
                                        ["content"] = new JsonObject { ["membership"] = "invite" },
                                    }
                                ),
                            },
                        },
                    },
                },
            }
        );
        await TelegramChannelTests.Until(() =>
            peer.Calls.Any(call =>
                call.Path.Contains("/join/!invite:fixture", StringComparison.Ordinal)
            )
        );
        var old = ExternalProtocolPeer.MatrixText("old", "old");
        old["origin_server_ts"] = 1;
        var own = ExternalProtocolPeer.MatrixText("own", "own", "@bot:fixture");
        var noSender = ExternalProtocolPeer.MatrixText("no-sender", "missing");
        noSender.Remove("sender");
        var wrong = ExternalProtocolPeer.MatrixText("wrong-type", "wrong");
        wrong["type"] = "m.room.encrypted";
        var raw = "  hello **room**\n\tkept  ";
        var accepted = ExternalProtocolPeer.MatrixText("live", raw);
        peer.MatrixEvents(
            "matrix-a",
            "!room:fixture",
            old,
            own,
            noSender,
            wrong,
            accepted,
            accepted
        );
        peer.MatrixEvents(
            "matrix-b",
            "!room:fixture",
            ExternalProtocolPeer.MatrixText("live", "second instance", "@other:fixture")
        );
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.Snapshot().Queue.Count == 1 && other.Entry.Snapshot().Queue.Count == 1
        );
        var item = f.Owner.Entry.Snapshot().Queue.Single();
        Assert.Equal("alpha", item.Source!.ChannelId);
        Assert.Equal("@sender:fixture", item.Source.SenderId);
        Assert.Equal("!room:fixture", item.Source.ConversationId);
        Assert.Contains(raw, item.Parts!.Single()["system"]!.GetValue<string>());
        Assert.Equal("@other:fixture", other.Entry.Snapshot().Queue.Single().Source!.SenderId);
        peer.MatrixEvents(
            "matrix-a",
            "!discover:fixture",
            ExternalProtocolPeer.MatrixText("discover", "/whoami other", "@stranger:fixture")
        );
        await TelegramChannelTests.Until(() =>
            peer.Sent("matrix-a")
                .Any(call =>
                    SessionWait
                        .Text(call.Body["body"])
                        ?.Contains("User ID: @stranger:fixture", StringComparison.Ordinal) == true
                )
        );
        Assert.Null(f.Manager.ChannelBinding("alpha:!discover:fixture"));

        peer.Media["photo"] = TelegramChannelTests.Jpeg();
        peer.Media["file"] = Encoding.UTF8.GetBytes("file bytes");
        JsonObject Media(
            string id,
            string type,
            string name,
            string mime,
            string sender = "@sender:fixture"
        )
        {
            var value = ExternalProtocolPeer.MatrixText(id, name, sender);
            value["content"] = new JsonObject
            {
                ["msgtype"] = type,
                ["body"] = name,
                ["url"] = "mxc://media.fixture/" + id,
                ["filename"] = "chosen <name>.txt",
                ["info"] = new JsonObject { ["mimetype"] = mime },
            };
            return value;
        }
        peer.MatrixEvents(
            "matrix-a",
            "!room:fixture",
            Media("photo", "m.image", "photo <x>.jpg", "image/jpeg"),
            Media("file", "m.file", "body differs", "text/plain")
        );
        await TelegramChannelTests.Until(() => f.Owner.Entry.Snapshot().Queue.Count == 3);
        var media = f
            .Owner.Entry.Snapshot()
            .Queue.Single(row => row.Parts!.Any(part => part["inlineDataRef"] is not null));
        Assert.Equal(
            peer.Media["photo"],
            await f.Manager.Images.ReadAsync(
                media.Parts!.Single(part => part["inlineDataRef"] is not null)[
                    "inlineDataRef"
                ]!.AsObject()
            )
        );
        Assert.Contains(
            "chosen &lt;name&gt;.txt",
            string.Join(
                "",
                f.Owner.Entry.Snapshot()
                    .Queue.SelectMany(row => row.Parts!)
                    .Select(part =>
                        SessionWait.Text(part["text"]) ?? SessionWait.Text(part["system"])
                    )
            )
        );
        var directory = Path.Combine(
            f.Manager.AgentDirectory("main"),
            ".temp",
            "channel-files",
            "matrix"
        );
        Assert.Equal(2, Directory.GetFiles(directory).Length);
        peer.Media["unauthorized"] = [1, 2, 3];
        peer.MatrixEvents(
            "matrix-a",
            "!unauthorized:fixture",
            Media(
                "unauthorized",
                "m.file",
                "not authorized",
                "application/octet-stream",
                "@stranger:fixture"
            )
        );
        await TelegramChannelTests.Until(() => Directory.GetFiles(directory).Length == 3);
        Assert.Null(f.Manager.ChannelBinding("alpha:!unauthorized:fixture"));
        Assert.All(
            peer.Calls.Where(call => call.Path.Contains("/download/", StringComparison.Ordinal)),
            call => Assert.Equal("", call.Key)
        );
        Assert.Equal(3, f.Owner.Entry.Snapshot().Queue.Count);
    }

    [Fact]
    public async Task Actual_direct_unified_native_and_file_paths_preserve_plain_or_Markdown_typing_upload_order_and_errors()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = peer.Matrix() },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        JsonObject Args(string text) =>
            new() { ["channelTargetId"] = "alpha:!room:fixture", ["message"] = text };
        Assert.Null((await f.ToolAsync("send_to_channel", Args("direct **plain**")))!["error"]);
        Assert.Null(
            (
                await f.ToolAsync(
                    "call_tool",
                    new JsonObject
                    {
                        ["toolId"] = "builtin:send_to_channel",
                        ["args"] = Args("unified"),
                    }
                )
            )!["error"]
        );
        Assert.Equal(
            "completed",
            SessionWait.Text(
                (
                    await f.ToolAsync(
                        "run_script",
                        new JsonObject
                        {
                            ["code"] =
                                "return call_tool('builtin:send_to_channel', {'channelTargetId':'alpha:!room:fixture','message':'native'})",
                        }
                    )
                )!["status"]
            )
        );
        Assert.Null(peer.Sent("matrix-a").First().Body["format"]);
        var transport = f.Manager.ChannelRegistry.Get("alpha")!;
        await transport.Send(
            "!room:fixture",
            "**bold** *italic* `code`\n<literal>",
            new(ParseMode: "Markdown"),
            default
        );
        Assert.Equal(
            "<strong>bold</strong> <em>italic</em> <code>code</code><br/><literal>",
            SessionWait.Text(peer.Sent("matrix-a").Last().Body["formatted_body"])
        );
        await transport.Typing!("!room:fixture", default);
        var typing = peer.Calls.Single(call =>
            call.Path.Contains("/typing/", StringComparison.Ordinal)
        );
        Assert.True(typing.Body["typing"]!.GetValue<bool>());
        Assert.Equal(3000, typing.Body["timeout"]!.GetValue<int>());
        var path = Path.Combine(f.Work, "unicode 文.txt");
        await File.WriteAllTextAsync(path, "file bytes");
        Assert.Null(
            (
                await f.ToolAsync(
                    "send_file",
                    new JsonObject
                    {
                        ["channelTargetId"] = "alpha:!room:fixture",
                        ["filePath"] = path,
                        ["caption"] = "caption **plain**",
                    }
                )
            )!["error"]
        );
        var upload = peer.Calls.Single(call =>
            call.Path.EndsWith("/upload", StringComparison.Ordinal)
        );
        Assert.Equal("unicode 文.txt", upload.Query["filename"]);
        Assert.Equal("file bytes", Encoding.UTF8.GetString(upload.Bytes));
        Assert.Equal("text/plain", upload.Headers["Content-Type"]);
        var all = peer.Calls.ToArray();
        var index = Array.IndexOf(all, upload);
        Assert.Equal("caption **plain**", SessionWait.Text(all[index - 1].Body["body"]));
        Assert.Null(all[index - 1].Body["format"]);
        var sent = peer.Sent("matrix-a").Last();
        Assert.Equal("m.file", SessionWait.Text(sent.Body["msgtype"]));
        Assert.Equal("mxc://fixture/uploaded", SessionWait.Text(sent.Body["url"]));
        Assert.Equal(10, SessionWait.Number(sent.Body["info"]!["size"]));
        Assert.Equal("unicode 文.txt", SessionWait.Text(sent.Body["filename"]));
        var image = Path.Combine(f.Work, "out.jpg");
        await File.WriteAllBytesAsync(image, TelegramChannelTests.Jpeg());
        Assert.Null(
            (
                await f.ToolAsync(
                    "send_file",
                    new JsonObject
                    {
                        ["channelTargetId"] = "alpha:!room:fixture",
                        ["filePath"] = image,
                    }
                )
            )!["error"]
        );
        Assert.Equal("m.image", SessionWait.Text(peer.Sent("matrix-a").Last().Body["msgtype"]));
        Assert.Empty(f.Owner.History());
        Assert.Null(f.Manager.ChannelBinding("alpha:!room:fixture"));
        var attempts = 0;
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Path.Contains("/send/", StringComparison.Ordinal)
                && SessionWait.Text(call.Body["body"]) == "retry"
                && Interlocked.Increment(ref attempts) <= 2
                    ? Results.Json(
                        new { errcode = "M_LIMIT_EXCEEDED", retry_after_ms = 7 },
                        statusCode: 429
                    )
                    : null
            );
        Assert.Null((await f.ToolAsync("send_to_channel", Args("retry")))!["error"]);
        var retries = peer.Sent("matrix-a")
            .Where(call => SessionWait.Text(call.Body["body"]) == "retry")
            .ToArray();
        Assert.Equal(3, retries.Length);
        Assert.Single(retries.Select(call => call.Path).Distinct());
        Assert.Equal(2, peer.Delays.Count);
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Path.Contains("/send/", StringComparison.Ordinal)
                    ? Results.Json(new { errcode = "M_FORBIDDEN" }, statusCode: 403)
                    : null
            );
        Assert.NotNull((await f.ToolAsync("send_to_channel", Args("denied")))!["error"]);
        Assert.Single(
            peer.Sent("matrix-a"),
            call => SessionWait.Text(call.Body["body"]) == "denied"
        );
    }

    [Fact]
    public async Task Timeline_backfill_and_capped_global_dedup_match_the_adapter_gate_and_invalid_media_does_not_forward_credentials()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = peer.Matrix() }
        );
        f.Manager.AttachChannel("alpha:!room:fixture", f.Owner);
        await using var adapter = new MatrixChannel(
            "alpha",
            peer.Matrix(),
            f.Manager,
            f.Router,
            null,
            _ => { }
        );
        var live = ExternalProtocolPeer.MatrixText("repeated", "live");
        await adapter.ProcessTimelineAsync("!room:fixture", live, true);
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        await adapter.ProcessTimelineAsync("!room:fixture", live);
        await adapter.ProcessTimelineAsync("!room:fixture", live);
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
        for (var i = 0; i < 1000; i++)
        {
            var unsupported = ExternalProtocolPeer.MatrixText("filler-" + i, "ignored");
            unsupported["content"]!["msgtype"] = "m.notice";
            await adapter.ProcessTimelineAsync("!room:fixture", unsupported);
        }
        await adapter.ProcessTimelineAsync("!room:fixture", live);
        Assert.Equal(2, f.Owner.Entry.Snapshot().Queue.Count);
        Assert.Null(adapter.MediaUri("https://untrusted.invalid/media"));
        Assert.Null(adapter.MediaUri("mxc://fixture/a/b"));
        Assert.Null(adapter.MediaUri("mxc://fixture/../id"));
        Assert.Equal(
            new Uri(peer.Address, "_matrix/media/v3/download/media.fixture/id_1"),
            adapter.MediaUri("mxc://media.fixture/id_1")
        );
    }
}
