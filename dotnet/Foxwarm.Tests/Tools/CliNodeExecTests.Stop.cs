using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// The CLI Node's side of stopping a Session command on Main's request.
public sealed partial class CliNodeExecTests
{
    [Fact]
    public async Task Node_stops_only_the_exact_owned_background_command_and_completes_it_once()
    {
        if (!OperatingSystem.IsLinux())
            return; // Uses the util-linux setsid command.
        using var owned = new OwnedPaths();
        var delivered = new List<string>();
        await using var manager = new NodeExecManager(
            owned.Paths,
            owned.Registry,
            (_, _, message) =>
            {
                lock (delivered)
                    delivered.Add(message);
                return Task.CompletedTask;
            }
        )
        {
            // The test host is not a CLI executable, so the detached wrapper is started with
            // setsid directly instead of the same-executable helper.
            Launch = start =>
            {
                var shell = new System.Diagnostics.ProcessStartInfo(
                    "setsid",
                    ["/bin/bash", start.ArgumentList[^1]]
                )
                {
                    WorkingDirectory = start.WorkingDirectory,
                    UseShellExecute = false,
                };
                foreach (var pair in start.Environment)
                    shell.Environment[pair.Key] = pair.Value;
                using var process = System.Diagnostics.Process.Start(shell)!;
                return process.Id;
            },
        };
        var frame = Frame("brisk-heron");
        frame["args"]!["command"] = "sleep 30";
        var entry = await manager.Start(frame, "main", "cli-node", CancellationToken.None, () => { });
        // Still a foreground call: Main has not handed it to the background yet.
        Assert.Equal("not-found", await manager.Stop("main/owned", "brisk-heron", "synthetic-test-grant"));
        await manager.Background(entry);
        Assert.Equal("not-found", await manager.Stop("main/owned", "brisk-heron", "other-grant"));
        Assert.Equal("not-found", await manager.Stop("main/other", "brisk-heron", "synthetic-test-grant"));
        Assert.True(ExecStop.Running(entry["pid"]!.GetValue<int>(), null));

        Assert.Equal("stopped", await manager.Stop("main/owned", "brisk-heron", "synthetic-test-grant"));
        Assert.Equal(
            "already-requested",
            await manager.Stop("main/owned", "brisk-heron", "synthetic-test-grant")
        );
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (manager.Tracked.Length > 0)
        {
            await manager.Reconcile();
            await Task.Delay(50, deadline.Token);
        }
        var message = Assert.Single(delivered);
        Assert.Equal("brisk-heron", ExecReceipt.Id(message));
        Assert.Contains("143", ExecReceipt.Header(message));
        Assert.Equal("not-found", await manager.Stop("main/owned", "brisk-heron", "synthetic-test-grant"));
        await manager.Reconcile();
        Assert.Single(delivered);
    }

    [Fact]
    public void Exec_control_is_advertised_only_with_native_exec()
    {
        var features = NodeClient.Capabilities()["features"]!.AsObject();
        Assert.Equal(ExecNative.Supported, features.ContainsKey("execControl"));
    }
}
