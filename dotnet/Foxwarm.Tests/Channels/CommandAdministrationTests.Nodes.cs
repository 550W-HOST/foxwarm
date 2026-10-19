using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed partial class CommandAdministrationTests
{
    [Fact]
    public async Task Actual_Node_commands_reserve_pair_approve_select_move_and_revoke_with_official_client_effects()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.UseWebSockets();
        app.Map("/node_ws", f.Manager.Nodes.HandleAsync);
        await app.StartAsync();
        f.Manager.Bootstrap = new(
            f.Manager.Nodes,
            new PublicWebAddress(
                app.Urls.Single() + "/nested/app",
                "/nested/app",
                "/nested/app/",
                true
            )
        );
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        await f.Router.HandleExternalMessageAsync(source, Message("/node pair-help"));
        Assert.Contains("/nested/app/node/", replies.Single());
        Assert.Contains("docker-compose.yaml", replies.Single());
        Assert.Contains("--install", replies.Single());
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(source, Message("/node create command-node"));
        var token = Regex.Match(replies.Single(), @"--auth-token=([a-f0-9]+)").Groups[1].Value;
        Assert.NotEmpty(token);
        Assert.True(f.Manager.Nodes.Registry.Authenticate("command-node", token));
        var nodeRoot = Path.Combine(f.Temp.Path, "official-node");
        Directory.CreateDirectory(nodeRoot);
        Process Start(string id, string? auth = null, bool pairing = false)
        {
            var start = new ProcessStartInfo("node")
            {
                WorkingDirectory = nodeRoot,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (
                var arg in new[]
                {
                    Path.Combine(
                        AppContext.BaseDirectory,
                        "packages",
                        "cli-node",
                        "dist",
                        "client.js"
                    ),
                    "--host",
                    app.Urls.Single(),
                    "--id",
                    id,
                    "--credentials-file",
                    Path.Combine(nodeRoot, id + ".json"),
                    "--no-local-trigger",
                }
            )
                start.ArgumentList.Add(arg);
            start.ArgumentList.Add(pairing ? "--token" : "--auth-token");
            start.ArgumentList.Add(pairing ? f.Manager.Nodes.Registry.PairingToken : auth!);
            start.Environment["HOME"] = nodeRoot;
            start.Environment.Remove("FOXWARM_AGENT_DIR");
            start.Environment.Remove("FOXWARM_AGENTS_DIR");
            return Process.Start(start)!;
        }
        async Task Stop(Process process, Task<string> stdout, Task<string> stderr)
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            await stdout;
            await stderr;
            process.Dispose();
        }
        var client = Start("command-node", token);
        var output = client.StandardOutput.ReadToEndAsync();
        var errors = client.StandardError.ReadToEndAsync();
        try
        {
            await TelegramChannelTests.Until(() => f.Manager.Nodes.Online("command-node"));
            replies.Clear();
            await f.Router.HandleExternalMessageAsync(source, Message("/node command-node"));
            Assert.Equal("command-node", f.Manager.CurrentNode(f.Owner));
            Assert.Contains("Switched", replies.Single());
            var remotePath = Path.Combine(nodeRoot, "command-effect.txt");
            var written = await f.ToolAsync(
                "write",
                new JsonObject
                {
                    ["filePath"] = remotePath,
                    ["content"] = "Selected official client effect.",
                }
            );
            Assert.Null(written?["error"]);
            Assert.Equal(
                "Selected official client effect.",
                await File.ReadAllTextAsync(remotePath)
            );
            await f.Manager.CreateAgentAsync(
                "isolated",
                createMainSession: false,
                isolatedNode: "command-node"
            );
            var isolated = await f.Manager.CreateNamedAsync("isolated", "chat", null, null);
            await f.Manager.SelectNodeAsync(isolated, "command-node"); // Valid lower-level selection remains valid.
            replies.Clear();
            await f.Router.HandleExternalCommandAsync(source, "/node", "command-node", isolated);
            Assert.Contains("isolated agent", replies.Single());
            replies.Clear();
            await f.Router.HandleExternalMessageAsync(
                source,
                Message("/agent inherit main isolated")
            );
            Assert.Null(f.Manager.AgentInherit("main"));
            Assert.Contains("isolated", replies.Single());
            replies.Clear();
            await f.Router.HandleExternalMessageAsync(
                source,
                Message("/timer after 3600 --new-session --agent main -- forbidden")
            );
            // The ordinary owner is not isolated; use the actual selected isolated owner for the boundary.
            var before = f.Manager.Timers.List(isolated.Id).Count;
            await f.Router.HandleExternalCommandAsync(
                source,
                "/timer",
                "after 3600 --new-session --agent main -- forbidden",
                isolated
            );
            Assert.Equal(before, f.Manager.Timers.List(isolated.Id).Count);
            await f.Router.HandleExternalMessageAsync(
                source,
                Message("/node move command-node renamed-node")
            );
            Assert.False(f.Manager.Nodes.Registry.Authenticate("command-node", token));
            Assert.True(f.Manager.Nodes.Registry.Authenticate("renamed-node", token));
            Assert.False(f.Manager.Nodes.Online("command-node"));
        }
        finally
        {
            await Stop(client, output, errors);
        }
        client = Start("renamed-node", token);
        output = client.StandardOutput.ReadToEndAsync();
        errors = client.StandardError.ReadToEndAsync();
        try
        {
            await TelegramChannelTests.Until(() => f.Manager.Nodes.Online("renamed-node"));
            await f.Router.HandleExternalMessageAsync(source, Message("/node renamed-node"));
            Assert.Equal("renamed-node", f.Manager.CurrentNode(f.Owner));
            await f.Router.HandleExternalMessageAsync(source, Message("/node remove renamed-node"));
            Assert.False(f.Manager.Nodes.Registry.Authenticate("renamed-node", token));
            Assert.False(f.Manager.Nodes.Online("renamed-node"));
        }
        finally
        {
            await Stop(client, output, errors);
        }
        // An unreserved official client performs the real pending/live approval handoff.
        client = Start("pair-candidate", pairing: true);
        output = client.StandardOutput.ReadToEndAsync();
        errors = client.StandardError.ReadToEndAsync();
        try
        {
            await TelegramChannelTests.Until(() => f.Manager.Nodes.ListPending().Count > 0);
            var pending = f
                .Manager.Nodes.ListPending()
                .OfType<JsonObject>()
                .Single(row => row["approvedNodeId"] is null);
            replies.Clear();
            await f.Router.HandleExternalMessageAsync(source, Message("/node list"));
            Assert.Contains(SessionWait.Text(pending["id"])!, replies.Single());
            Assert.Contains("protocol=v", replies.Single());
            replies.Clear();
            await f.Router.HandleExternalMessageAsync(
                source,
                Message("/node approve " + pending["id"] + " paired-command")
            );
            Assert.Contains("Approved pending pairing", replies.Single());
            await TelegramChannelTests.Until(() => f.Manager.Nodes.Online("paired-command"));
            await f.Router.HandleExternalMessageAsync(source, Message("/node paired-command"));
            Assert.Equal("paired-command", f.Manager.CurrentNode(f.Owner));
            var path = Path.Combine(nodeRoot, "paired-effect.txt");
            var written = await f.ToolAsync(
                "write",
                new JsonObject { ["filePath"] = path, ["content"] = "Paired client effect." }
            );
            Assert.Null(written?["error"]);
            Assert.Equal("Paired client effect.", await File.ReadAllTextAsync(path));
        }
        finally
        {
            await Stop(client, output, errors);
        }
        var request = f.Manager.Nodes.Registry.Request(
            new JsonObject
            {
                ["requestedName"] = "reject",
                ["nodeType"] = "cli-node",
                ["capabilities"] = new JsonObject(),
            },
            NodeConnectionHub.Protocol(new())
        );
        await f.Router.HandleExternalMessageAsync(source, Message("/node reject " + request["id"]));
        Assert.DoesNotContain(
            f.Manager.Nodes.ListPending(),
            row => SessionWait.Text(row?["id"]) == SessionWait.Text(request["id"])
        );
    }
}
