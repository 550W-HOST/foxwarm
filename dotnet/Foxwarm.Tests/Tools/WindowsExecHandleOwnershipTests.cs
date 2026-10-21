using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Tools;
using Microsoft.Win32.SafeHandles;

namespace Foxwarm.Tests;

public sealed class WindowsExecHandleOwnershipTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Unrelated_live_execs_do_not_retain_an_exited_owners_capture(bool cli)
    {
        if (!OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var agent = Path.Combine(temp.Path, "agent space 雪");
        Directory.CreateDirectory(agent);
        var previous = Environment.GetEnvironmentVariable("FOXWARM_AGENT_DIR");
        Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", agent);
        var records = new List<JsonObject>();
        var releases = Enumerable
            .Range(0, 5)
            .Select(index => Path.Combine(agent, "release-" + index))
            .ToArray();
        try
        {
            await using (
                var main = new LocalExecManager(
                    Path.Combine(temp.Path, "data"),
                    _ => agent,
                    (_, _, _) => Task.CompletedTask
                )
            )
            await using (
                var node = new NodeExecManager(
                    new NodePaths(agent),
                    Path.Combine(agent, ".temp", "exec", "running-exec.json"),
                    (_, _, _) => Task.CompletedTask
                )
            )
            {
                async Task<JsonObject> Start(int index)
                {
                    var command =
                        "Write-Output 'ready'; while (-not (Test-Path -LiteralPath '"
                        + releases[index].Replace("'", "''", StringComparison.Ordinal)
                        + "')) { Start-Sleep -Milliseconds 25 }; Write-Output 'finished'";
                    if (cli)
                        return await node.Start(
                            new JsonObject
                            {
                                ["sessionId"] = "main/capture-" + index,
                                ["args"] = new JsonObject { ["command"] = command },
                            },
                            "main",
                            "owned",
                            default,
                            () => { }
                        );
                    var session = "capture-" + index;
                    var result = await main.ExecuteAsync(
                        session,
                        new JsonObject { ["command"] = command, ["timeout"] = 1 },
                        default,
                        MainNativePaths.Default(agent)
                    );
                    Assert.Contains("Switched to background", result["output"]!.ToString());
                    return Assert.Single(
                        main.Tracked,
                        record => record["sessionId"]!.ToString() == session
                    );
                }

                var owner = await Start(0);
                records.Add(owner);
                // Hold an inheritable writable copy of the actual owner's capture during
                // sibling launches. This makes broad inheritance observable deterministically,
                // without a production hook to pause between CreateFile and CreateProcess.
                // It is an API exclusion probe, not a deterministic reproduction of that race.
                using (var probe = OpenInheritableCapture(owner["logPath"]!.ToString()))
                {
                    var launches = Enumerable
                        .Range(1, releases.Length - 1)
                        .Select(index => Task.Run(() => Start(index)))
                        .ToArray();
                    // Retain successful starts even if another launch fails, for owned cleanup.
                    try
                    {
                        await Task.WhenAll(launches);
                    }
                    finally
                    {
                        records.AddRange(
                            launches
                                .Where(task => task.IsCompletedSuccessfully)
                                .Select(task => task.Result)
                        );
                    }
                }
            }
            // Managers stop observing; commands remain independent. No observer's transient
            // log read can be mistaken for a sibling's retained writable capture handle.
            var children = records
                .Select(record =>
                    Process.GetProcessById(
                        int.Parse(record["pid"]!.ToString(), CultureInfo.InvariantCulture)
                    )
                )
                .ToArray();
            try
            {
                for (var index = 0; index < children.Length; index++)
                {
                    Assert.False(children[index].HasExited);
                    // Each child retains its own capture until it actually exits.
                    Assert.Throws<IOException>(() =>
                        File.Delete(records[index]["logPath"]!.ToString())
                    );
                    await File.WriteAllTextAsync(releases[index], "finish");
                    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                    await children[index].WaitForExitAsync(deadline.Token);
                    var log = records[index]["logPath"]!.ToString();
                    Assert.Contains("finished", await File.ReadAllTextAsync(log));
                    Assert.Equal(
                        0,
                        JsonNode.Parse(
                            await File.ReadAllTextAsync(records[index]["statusPath"]!.ToString())
                        )!["exitCode"]!.GetValue<int>()
                    );
                    foreach (var sibling in children.Skip(index + 1))
                        Assert.False(sibling.HasExited);
                    File.Delete(log);
                    Assert.False(File.Exists(log));
                }
            }
            finally
            {
                foreach (var child in children)
                    child.Dispose();
            }
        }
        finally
        {
            try
            {
                // No command is left waiting on a failed assertion or partial launch.
                foreach (var release in releases)
                    await File.WriteAllTextAsync(release, "finish");
                foreach (var record in records)
                {
                    try
                    {
                        using var child = Process.GetProcessById(
                            int.Parse(record["pid"]!.ToString(), CultureInfo.InvariantCulture)
                        );
                        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                        await child.WaitForExitAsync(deadline.Token);
                    }
                    catch (ArgumentException) { }
                }
            }
            finally
            {
                Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", previous);
            }
        }
    }

    private static SafeFileHandle OpenInheritableCapture(string path)
    {
        var security = new SecurityAttributes
        {
            Size = Marshal.SizeOf<SecurityAttributes>(),
            Inherit = 1,
        };
        var handle = CreateFile(path, 0x40000000, 3, ref security, 3, 0x80, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        return handle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Size;
        internal IntPtr Descriptor;
        internal int Inherit;
    }

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateFileW",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
    private static extern SafeFileHandle CreateFile(
        string path,
        uint access,
        uint share,
        ref SecurityAttributes security,
        uint disposition,
        uint flags,
        IntPtr template
    );
}
