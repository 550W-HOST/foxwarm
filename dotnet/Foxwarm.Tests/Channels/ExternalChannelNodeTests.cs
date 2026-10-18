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
        await using var f = await ExternalChannelFixture.CreateAsync();
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
