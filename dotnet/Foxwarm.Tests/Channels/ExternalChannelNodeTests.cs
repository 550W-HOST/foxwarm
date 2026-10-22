using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed class ExternalChannelNodeTests
{
    [Fact]
    public async Task Real_repository_CLI_Node_receives_isolated_inbound_bytes_while_nonisolated_selected_Node_and_named_helper_keep_Source_placement()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var qq = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            dependencies: peer.Dependencies with
            {
                CreateQQBotHttp = qq.Dependencies.CreateQQBotHttp,
            }
        );
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.UseWebSockets();
        app.Map("/node_ws", f.Manager.Nodes.HandleAsync);
        await app.StartAsync();
        var nodeRoot = Path.Combine(f.Temp.Path, "node");
        Directory.CreateDirectory(nodeRoot);
        var credentials = f.Manager.Nodes.Registry.Create("owned-channel-node");
        var start = new ProcessStartInfo("node")
        {
            WorkingDirectory = nodeRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (
            var value in new[]
            {
                Path.Combine(AppContext.BaseDirectory, "packages", "cli-node", "dist", "client.js"),
                "--host",
                app.Urls.Single(),
                "--id",
                "owned-channel-node",
                "--auth-token",
                SessionWait.Text(credentials["authToken"])!,
                "--credentials-file",
                Path.Combine(nodeRoot, "state", "credentials.json"),
                "--no-local-trigger",
            }
        )
            start.ArgumentList.Add(value);
        start.Environment.Remove("FOXWARM_AGENT_DIR");
        start.Environment.Remove("FOXWARM_AGENTS_DIR");
        start.Environment["HOME"] = nodeRoot;
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        try
        {
            await TelegramChannelTests.Until(() => f.Manager.Nodes.Online("owned-channel-node"));
            await f.Manager.SelectNodeAsync(f.Owner, "owned-channel-node", default);
            f.Manager.AttachChannel("telegram:42", f.Owner);
            var bytes = new byte[] { 1, 2, 3, 4 };
            var local = await f.Manager.SaveInboundChannelFileAsync(
                "telegram",
                "42",
                bytes,
                "selected.bin",
                "application/octet-stream",
                "",
                default
            );
            Assert.Contains("node=\"master\"", SessionWait.Text(local.Single()["text"])!);
            Assert.False(
                Directory.Exists(Path.Combine(nodeRoot, "agents", "main", ".temp", "channel-files"))
            );
            await f.Manager.SetAgentIsolationAsync(
                "main",
                "owned-channel-node",
                true,
                new JsonArray()
            );
            var remote = await f.Manager.SaveInboundChannelFileAsync(
                "telegram",
                "42",
                bytes,
                "remote.bin",
                "application/octet-stream",
                "caption",
                default
            );
            var descriptor = SessionWait.Text(remote.Single()["text"])!;
            Assert.Contains("node=\"owned-channel-node\"", descriptor);
            var path = Regex.Match(descriptor, " path=\"([^\"]+)\"").Groups[1].Value;
            Assert.StartsWith(
                Path.Combine(nodeRoot, "agents", "main"),
                path,
                StringComparison.Ordinal
            );
            Assert.Equal(bytes, await File.ReadAllBytesAsync(path));
            // The configured WeWork callback actually materializes through that same isolated Node owner.
            var callbackPort = WeWorkPeer.Port();
            await f.Configuration.SaveAppAsync(
                new JsonObject
                {
                    ["channels"] = new JsonObject { ["work"] = peer.Config(callbackPort) },
                }.ToJsonString()
            );
            f.Manager.AttachChannel("wework:node-media", f.Owner);
            f.Manager.AttachChannel("work:node-media", f.Owner);
            peer.Media["/node-file"] = Convert.FromBase64String(
                WeWorkCallbackTests.Encrypt("WeWork Node bytes", framed: false)
            );
            using var callback = new HttpClient
            {
                BaseAddress = new Uri($"http://127.0.0.1:{callbackPort}/"),
            };
            var inbound = WeWorkPeer.Text("node-file", chat: "node-media");
            inbound["msgtype"] = "file";
            inbound["file"] = new JsonObject
            {
                ["url"] = new Uri(peer.Address, "node-file").ToString(),
                ["filename"] = "node-report.bin",
            };
            await WeWorkCallbackTests.Post(callback, inbound);
            var remoteFiles = Directory.GetFiles(
                Path.Combine(nodeRoot, "agents", "main", ".temp/channel-files/wework")
            );
            Assert.Single(remoteFiles);
            Assert.Equal("WeWork Node bytes", await File.ReadAllTextAsync(remoteFiles.Single()));
            await TelegramChannelTests.Until(() =>
                f.Owner.Entry.WithState(state => state.Queue.Count) == 1
            );
            Assert.Contains(
                "node=\"owned-channel-node\"",
                string.Join(
                    "",
                    f.Owner.Entry.WithState(state => state.Queue.Single().Parts!)
                        .Select(part => SessionWait.Text(part["text"] ?? part["system"]))
                )
            );
            // QQ resolves the actual authorized Session before its bounded Node materializer runs.
            qq.Assets["/small"] = "QQ Node bytes"u8.ToArray();
            await f.Configuration.SaveAppAsync(
                new JsonObject
                {
                    ["channels"] = new JsonObject { ["qq"] = qq.Config() },
                }.ToJsonString()
            );
            f.Manager.AttachChannel("qq:group:room", f.Owner);
            qq.Push(
                "GROUP_AT_MESSAGE_CREATE",
                QQBotPeer.Message(
                    "qq-node",
                    "QQ media",
                    attachments: QQBotPeer.Attachment("/small")
                )
            );
            await TelegramChannelTests.Until(() => f.Owner.Entry.Snapshot().Queue.Count == 2);
            var qqFiles = Directory.GetFiles(
                Path.Combine(nodeRoot, "agents", "main", ".temp/channel-files/qqbot")
            );
            Assert.Single(qqFiles);
            Assert.Equal("QQ Node bytes", await File.ReadAllTextAsync(qqFiles.Single()));
            qq.Push(
                "GROUP_AT_MESSAGE_CREATE",
                QQBotPeer.Message(
                    "qq-node-over-cap",
                    "QQ cap",
                    attachments: QQBotPeer.Attachment(
                        "/must-not-fetch",
                        size: 10L * 1024 * 1024 + 1
                    )
                )
            );
            await TelegramChannelTests.Until(() => f.Owner.Entry.Snapshot().Queue.Count == 3);
            Assert.DoesNotContain(qq.Calls, call => call.Path == "/must-not-fetch");
            Assert.Single(
                Directory.GetFiles(
                    Path.Combine(nodeRoot, "agents", "main", ".temp/channel-files/qqbot")
                )
            );
            // The eagerly called helper receives the adapter TYPE, not this named instance's binding.
            var created = await f.Manager.CreateAgentAsync("named-destination");
            var named = await f.Manager.RequiredAsync(created.MainSessionId!);
            f.Manager.AttachChannel("named-telegram:99", named);
            var namedSave = await f.Manager.SaveInboundChannelFileAsync(
                "telegram",
                "99",
                bytes,
                "named.bin",
                "application/octet-stream",
                "",
                default
            );
            Assert.Contains("node=\"master\"", SessionWait.Text(namedSave.Single()["text"])!);
            Assert.Contains(
                f.Manager.AgentDirectory("main"),
                SessionWait.Text(namedSave.Single()["text"])!
            );
            Assert.False(
                Directory.Exists(
                    Path.Combine(f.Manager.AgentDirectory(named.Agent), ".temp", "channel-files")
                )
            );
        }
        finally
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            Console.WriteLine(await stdout);
            Console.WriteLine(await stderr);
            await app.StopAsync();
        }
    }
}
