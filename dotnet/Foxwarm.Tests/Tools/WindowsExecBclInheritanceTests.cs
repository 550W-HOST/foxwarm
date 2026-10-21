using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class WindowsExecBclInheritanceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Concurrent_BCL_children_do_not_retain_exited_exec_capture_handles(bool cli)
    {
        if (!OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var agent = Path.Combine(temp.Path, "agent space 雪");
        Directory.CreateDirectory(agent);
        var release = Path.Combine(agent, "release");
        var previous = Environment.GetEnvironmentVariable("FOXWARM_AGENT_DIR");
        Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", agent);
        var records = new List<JsonObject>();
        var peers = new List<Process>();
        var owners = new List<Process>();
        try
        {
            await using (var main = new LocalExecManager(
                Path.Combine(temp.Path, "data"),
                _ => agent,
                (_, _, _) => Task.CompletedTask
            ))
            await using (var node = new NodeExecManager(
                new NodePaths(agent),
                Path.Combine(agent, ".temp", "exec", "running-exec.json"),
                (_, _, _) => Task.CompletedTask
            ))
            {
                async Task<JsonObject> StartOwner(int index)
                {
                    var command = "while (-not (Test-Path -LiteralPath '"
                        + release.Replace("'", "''", StringComparison.Ordinal)
                        + "')) { Start-Sleep -Milliseconds 25 }; Write-Output 'finished'";
                    var session = "owner-" + index;
                    if (cli)
                        return await node.Start(new JsonObject
                        {
                            ["sessionId"] = "main/" + session,
                            ["args"] = new JsonObject { ["command"] = command },
                        }, "main", "owned", default, () => { });
                    var result = await main.ExecuteAsync(session,
                        new JsonObject { ["command"] = command, ["timeout"] = 1 },
                        default, MainNativePaths.Default(agent));
                    Assert.Contains("Switched to background", result["output"]!.ToString());
                    return Assert.Single(main.Tracked, record => record["sessionId"]!.ToString() == session);
                }
                using var start = new ManualResetEventSlim();
                var launches = Enumerable.Range(0, 4).Select(index => Task.Run(async () =>
                {
                    start.Wait();
                    return await StartOwner(index);
                })).ToArray();
                // This is the same ordinary Process.Start inheritance path used by Git,
                // not another ExecNative child. Stdin keeps each owned peer alive.
                var bcl = Enumerable.Range(0, 12).Select(_ => Task.Run(() =>
                {
                    start.Wait();
                    var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe")
                    {
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardInput = true,
                    };
                    foreach (var argument in new[] { "/d", "/q", "/c", "set /p finish= >nul" })
                        info.ArgumentList.Add(argument);
                    return Process.Start(info) ?? throw new IOException("Failed to start owned BCL peer.");
                })).ToArray();
                start.Set();
                try
                {
                    await Task.WhenAll(launches.Cast<Task>().Concat(bcl));
                }
                finally
                {
                    records.AddRange(launches.Where(task => task.IsCompletedSuccessfully).Select(task => task.Result));
                    peers.AddRange(bcl.Where(task => task.IsCompletedSuccessfully).Select(task => task.Result));
                    foreach (var record in records)
                    {
                        try
                        {
                            owners.Add(Process.GetProcessById(int.Parse(record["pid"]!.ToString(), CultureInfo.InvariantCulture)));
                        }
                        catch (ArgumentException) { }
                    }
                }
                Assert.Equal(records.Count, owners.Count);
            }
            foreach (var peer in peers)
                Assert.False(peer.HasExited);
            await File.WriteAllTextAsync(release, "finish");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            foreach (var owner in owners)
                await owner.WaitForExitAsync(deadline.Token);
            foreach (var record in records)
            {
                var log = record["logPath"]!.ToString();
                // Share-delete permits rename/delete even with leaked handles. An exclusive
                // read open, after the real owner exits, detects retained read/write handles.
                using var exclusive = File.Open(log, FileMode.Open, FileAccess.Read, FileShare.None);
                using var reader = new StreamReader(exclusive);
                Assert.Contains("finished", await reader.ReadToEndAsync());
            }
            foreach (var peer in peers)
                Assert.False(peer.HasExited);
        }
        finally
        {
            try
            {
                await File.WriteAllTextAsync(release, "finish");
                foreach (var peer in peers)
                    peer.StandardInput.Close();
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                foreach (var child in owners.Concat(peers))
                {
                    try
                    {
                        await child.WaitForExitAsync(deadline.Token);
                    }
                    finally
                    {
                        child.Dispose();
                    }
                }
            }
            finally
            {
                Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", previous);
            }
        }
    }
}
