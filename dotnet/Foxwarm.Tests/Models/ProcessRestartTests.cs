using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Xunit.Abstractions;

namespace Foxwarm.Tests;

public sealed class ProcessRestartTests
{
    private readonly ITestOutputHelper output;

    public ProcessRestartTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public async Task CleanIdleRestartContinuesInDistinctProcessAndFailsClosedWithoutJsonAuthority()
    {
        var ownedRoot = Path.Combine(
            Path.GetTempPath(),
            $"foxwarm-dotnet-restart-{Guid.NewGuid():N}"
        );
        var stateRoot = Path.Combine(ownedRoot, "state-root");
        var effectRoot = Path.Combine(ownedRoot, "effects");
        var resultsRoot = Path.Combine(ownedRoot, "results");
        var logsRoot = Path.Combine(ownedRoot, "logs");
        Directory.CreateDirectory(stateRoot);
        Directory.CreateDirectory(effectRoot);
        Directory.CreateDirectory(resultsRoot);
        Directory.CreateDirectory(logsRoot);
        try
        {
            var responses = new[]
            {
                CompletedSse(
                    new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "function_call",
                            ["call_id"] = "call_restart",
                            ["name"] = "write_fixture",
                            ["arguments"] =
                                "{\"fileName\":\"restart.txt\",\"content\":\"héllo restart\"}",
                        }
                    )
                ),
                CompletedSse(
                    new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["phase"] = "final_answer",
                            ["content"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "output_text",
                                    ["text"] = "process A complete",
                                }
                            ),
                        }
                    )
                ),
                CompletedSse(
                    new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["phase"] = "final_answer",
                            ["content"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "output_text",
                                    ["text"] = "process B complete",
                                }
                            ),
                        }
                    )
                ),
            };
            await using var server = new ScriptedResponsesSequenceServer(
                3,
                (index, stream, _) =>
                    LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        Encoding.UTF8.GetBytes(responses[index]),
                        1,
                        3,
                        7,
                        13
                    )
            );

            var aPath = Path.Combine(resultsRoot, "a.json");
            var processA = await RunHarnessAsync(
                "a",
                stateRoot,
                aPath,
                logsRoot,
                server.BaseUri,
                effectRoot
            );
            Assert.Equal(0, processA.ExitCode);
            Assert.True(processA.ExitedAt <= DateTimeOffset.UtcNow);
            var a = JsonNode.Parse(await File.ReadAllTextAsync(aPath))!.AsObject();
            Assert.Equal(processA.Pid, a["pid"]!.GetValue<int>());
            Assert.Equal(4, a["historyCount"]!.GetValue<int>());
            Assert.Equal(5, a["nextMessageSeq"]!.GetValue<int>());
            Assert.Equal(0, a["queueCount"]!.GetValue<int>());
            Assert.False(a["busy"]!.GetValue<bool>());
            Assert.False(a["stopping"]!.GetValue<bool>());
            Assert.Equal(1, a["successfulEffects"]!.GetValue<int>());
            Assert.Equal(
                new[] { 1, 2, 3, 4 },
                a["seqs"]!.AsArray().Select(node => node!.GetValue<int>())
            );
            Assert.Equal(2, server.RequestCount);

            var fixturePath = Path.Combine(effectRoot, "restart.txt");
            Assert.Equal(
                Encoding.UTF8.GetBytes("héllo restart"),
                await File.ReadAllBytesAsync(fixturePath)
            );
            var fixtureWriteTime = File.GetLastWriteTimeUtc(fixturePath);
            var bStartedAt = DateTimeOffset.UtcNow;
            Assert.True(processA.ExitedAt <= bStartedAt);
            var bPath = Path.Combine(resultsRoot, "b.json");
            var processB = await RunHarnessAsync(
                "b",
                stateRoot,
                bPath,
                logsRoot,
                server.BaseUri,
                effectRoot
            );
            Assert.Equal(0, processB.ExitCode);
            Assert.NotEqual(processA.Pid, processB.Pid);
            Assert.True(processA.ExitedAt <= processB.StartedAt);
            var b = JsonNode.Parse(await File.ReadAllTextAsync(bPath))!.AsObject();
            Assert.Equal(processB.Pid, b["pid"]!.GetValue<int>());
            Assert.Equal(4, b["loadedHistoryCount"]!.GetValue<int>());
            Assert.Equal(5, b["loadedNextMessageSeq"]!.GetValue<int>());
            Assert.Equal(6, b["historyCount"]!.GetValue<int>());
            Assert.Equal(7, b["nextMessageSeq"]!.GetValue<int>());
            Assert.Equal(0, b["queueCount"]!.GetValue<int>());
            Assert.False(b["busy"]!.GetValue<bool>());
            Assert.False(b["stopping"]!.GetValue<bool>());
            Assert.Equal(0, b["successfulEffects"]!.GetValue<int>());
            Assert.Equal(
                new[] { 1, 2, 3, 4, 5, 6 },
                b["seqs"]!.AsArray().Select(node => node!.GetValue<int>())
            );
            Assert.Equal(3, server.RequestCount);
            Assert.Equal(fixtureWriteTime, File.GetLastWriteTimeUtc(fixturePath));
            Assert.Equal(
                Encoding.UTF8.GetBytes("héllo restart"),
                await File.ReadAllBytesAsync(fixturePath)
            );
            output.WriteLine(
                $"process A pid={processA.Pid} exit={processA.ExitCode} exitedAt={processA.ExitedAt:O}; process B pid={processB.Pid} exit={processB.ExitCode} startedAt={processB.StartedAt:O}"
            );

            var thirdRequest = JsonNode
                .Parse((await server.RequestAt(2).WaitAsync(TimeSpan.FromSeconds(5))).Body)!
                .AsObject();
            var thirdInput = thirdRequest["input"]!.AsArray();
            Assert.Equal(
                new[] { "message", "function_call", "function_call_output", "message", "message" },
                thirdInput.Select(item => item!["type"]!.GetValue<string>())
            );
            var thirdJson = thirdInput.ToJsonString();
            Assert.Contains("write fixture in process A", thirdJson, StringComparison.Ordinal);
            Assert.Contains("call_restart", thirdJson, StringComparison.Ordinal);
            Assert.Contains("created", thirdJson, StringComparison.Ordinal);
            Assert.Contains("process A complete", thirdJson, StringComparison.Ordinal);
            Assert.Contains("continue in process B", thirdJson, StringComparison.Ordinal);

            var persisted = new PersistentSessionAuthorityStore(stateRoot, "s");
            var final = await persisted.LoadAsync("s");
            Assert.Equal(6, final!.History.Count);
            Assert.Equal(7, final.NextMessageSeq);
            Assert.False(final.Busy);
            Assert.Empty(final.Queue);
            Assert.Equal(6, persisted.Archive.ReadMessages().Count);
            var replayResult = Path.Combine(resultsRoot, "actual-ts-final-replay.json");
            ResponsesClientTests.RunPersistenceOracle("replay-ts", stateRoot, replayResult, "s");
            Assert.Equal(
                0,
                JsonNode.Parse(await File.ReadAllTextAsync(replayResult))![
                    "insertedCount"
                ]!.GetValue<int>()
            );
            var readResult = Path.Combine(resultsRoot, "actual-ts-final-read.json");
            ResponsesClientTests.RunPersistenceOracle("read", stateRoot, readResult, "s");
            var tsRead = JsonNode.Parse(await File.ReadAllTextAsync(readResult))!.AsObject();
            var tsAuthority = tsRead["authority"]!.AsObject();
            Assert.Equal(6, tsAuthority["history"]!.AsArray().Count);
            Assert.Equal(7, tsAuthority["nextMessageSeq"]!.GetValue<int>());
            Assert.Equal(6, tsRead["rawRows"]!.AsArray().Count);

            foreach (var invalid in new[] { "missing", "corrupt" })
            {
                var caseRoot = Path.Combine(ownedRoot, $"case-{invalid}");
                CopyDirectory(stateRoot, caseRoot);
                var authorityPath = Path.Combine(caseRoot, "state", "sessions", "s.json");
                if (invalid == "missing")
                    File.Delete(authorityPath);
                else
                    await File.WriteAllTextAsync(authorityPath, "{invalid");
                var caseResult = Path.Combine(resultsRoot, $"load-{invalid}.json");
                var child = await RunHarnessAsync(
                    "load-check",
                    caseRoot,
                    caseResult,
                    logsRoot,
                    null,
                    null
                );
                Assert.Equal(0, child.ExitCode);
                output.WriteLine($"load-check {invalid} pid={child.Pid} exit={child.ExitCode}");
                Assert.Equal(
                    "InvalidDataException",
                    JsonNode.Parse(await File.ReadAllTextAsync(caseResult))![
                        "errorType"
                    ]!.GetValue<string>()
                );
                Assert.Equal(3, server.RequestCount);
                Assert.Equal(
                    6,
                    new PersistentSessionAuthorityStore(caseRoot, "s").Archive.ReadMessages().Count
                );
            }
        }
        finally
        {
            if (Directory.Exists(ownedRoot))
                Directory.Delete(ownedRoot, true);
        }
    }

    [Fact]
    public async Task Real_owned_busy_producer_recovers_after_abrupt_process_exit()
    {
        var ownedRoot = Path.Combine(
            Path.GetTempPath(),
            $"foxwarm-dotnet-busy-restart-{Guid.NewGuid():N}"
        );
        var resultA = Path.Combine(ownedRoot, "a.json");
        var resultB = Path.Combine(ownedRoot, "b.json");
        var resultC = Path.Combine(ownedRoot, "c.json");
        var effectRoot = Path.Combine(ownedRoot, "effects");
        Directory.CreateDirectory(effectRoot);
        await using var server = new LoopbackResponsesServer(
            async (stream, _) =>
            {
                var buffer = new byte[1];
                await stream.ReadAtLeastAsync(buffer, 1, throwOnEndOfStream: false);
            }
        );
        Process? processA = null;
        try
        {
            processA = StartRestartHarness(
                "busy-a",
                ownedRoot,
                resultA,
                server.BaseUri,
                effectRoot
            );
            var ready = await WaitForResultAsync(resultA, TimeSpan.FromSeconds(15));
            Assert.True(ready["busy"]!.GetValue<bool>());
            await server.Request.WaitAsync(TimeSpan.FromSeconds(5));
            processA.Kill();
            await processA.WaitForExitAsync();

            await using var responseServer = new ScriptedResponsesSequenceServer(
                1,
                async (_, stream, _) =>
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        Encoding.UTF8.GetBytes(
                            CompletedSse(
                                new JsonArray(
                                    new JsonObject
                                    {
                                        ["type"] = "message",
                                        ["role"] = "assistant",
                                        ["phase"] = "final_answer",
                                        ["content"] = new JsonArray(
                                            new JsonObject
                                            {
                                                ["type"] = "output_text",
                                                ["text"] = "recovered",
                                            }
                                        ),
                                    }
                                )
                            )
                        )
                    )
            );
            using var processB = StartRestartHarness(
                "busy-b",
                ownedRoot,
                resultB,
                responseServer.BaseUri,
                effectRoot
            );
            await processB.WaitForExitAsync();
            Assert.Equal(0, processB.ExitCode);
            var recovered = JsonNode.Parse(await File.ReadAllTextAsync(resultB))!.AsObject();
            Assert.False(recovered["busy"]!.GetValue<bool>());
            Assert.False(recovered["stopping"]!.GetValue<bool>());
            Assert.Equal(0, recovered["queueCount"]!.GetValue<int>());
            Assert.Equal(1, responseServer.RequestCount);
            var recoveredHistory = recovered["history"]!
                .AsArray()
                .Select(value => value!.GetValue<string>())
                .ToArray();
            Assert.Single(
                recoveredHistory,
                value => value.Contains("session-resumed", StringComparison.Ordinal)
            );
            Assert.Single(
                recoveredHistory,
                value => value.Contains("busy restart", StringComparison.Ordinal)
            );

            using var processC = StartRestartHarness("busy-c", ownedRoot, resultC, null, null);
            await processC.WaitForExitAsync();
            Assert.Equal(0, processC.ExitCode);
            var ordinary = JsonNode.Parse(await File.ReadAllTextAsync(resultC))!.AsObject();
            Assert.False(ordinary["busy"]!.GetValue<bool>());
            Assert.False(ordinary["stopping"]!.GetValue<bool>());
            Assert.Equal(0, ordinary["queueCount"]!.GetValue<int>());
            Assert.Equal(
                recoveredHistory,
                ordinary["history"]!.AsArray().Select(value => value!.GetValue<string>()).ToArray()
            );
        }
        finally
        {
            if (processA is { HasExited: false })
                processA.Kill(entireProcessTree: true);
            if (Directory.Exists(ownedRoot))
                Directory.Delete(ownedRoot, true);
            if (Directory.Exists(ownedRoot + "-workspace"))
                Directory.Delete(ownedRoot + "-workspace", true);
        }
    }

    [Theory]
    [InlineData("identity-copy-before", "rolling-back", "s")]
    [InlineData("identity-copy-after", "rolling-back", "s")]
    [InlineData("identity-finishing", "finishing", "copied/main")]
    public async Task Actual_identity_copy_or_alias_crash_recovers_only_recorded_direction_and_preserves_sources(
        string mode,
        string phase,
        string expectedId
    )
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "data");
        var ready = Path.Combine(temp.Path, "ready.json");
        using var child = StartRestartHarness(mode, root, ready, null, null);
        try
        {
            var checkpoint = await WaitForResultAsync(ready, TimeSpan.FromSeconds(15));
            Assert.Equal(phase, checkpoint["pending"]!["phase"]!.GetValue<string>());
            child.Kill();
            await child.WaitForExitAsync();
            foreach (var run in new[] { "first", "second" })
            {
                var result = Path.Combine(temp.Path, run + ".json");
                await RunHarnessAsync("identity-recover", root, result, temp.Path, null, null);
                var recovered = JsonNode.Parse(await File.ReadAllTextAsync(result))!;
                Assert.Equal(expectedId, recovered["id"]!.GetValue<string>());
                Assert.Equal(1, recovered["historyCount"]!.GetValue<int>());
                Assert.Equal(1, recovered["archiveCount"]!.GetValue<int>());
                Assert.Equal(
                    "Copied memory survives crash: 雪",
                    recovered["memory"]!.GetValue<string>()
                );
                Assert.False(recovered["pending"]!.GetValue<bool>());
                Assert.Equal(
                    expectedId == "copied/main",
                    recovered["copiedAgent"]!.GetValue<bool>()
                );
            }
        }
        finally
        {
            if (!child.HasExited)
            {
                child.Kill();
                await child.WaitForExitAsync();
            }
        }
    }

    private static string CompletedSse(JsonArray output) =>
        $"data: {{\"type\":\"response.completed\",\"response\":{{\"output\":{output.ToJsonString()}}}}}\n\n";

    private static Process StartRestartHarness(
        string mode,
        string root,
        string resultPath,
        Uri? baseUri,
        string? effectRoot
    )
    {
        var dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (string.IsNullOrWhiteSpace(dotnetRoot))
            throw new InvalidOperationException(
                "DOTNET_ROOT is required for restart harness tests."
            );
        var dotnet = Path.Combine(
            dotnetRoot,
            OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet"
        );
        var harness = Path.Combine(AppContext.BaseDirectory, "Foxwarm.DevTools.dll");
        var start = new ProcessStartInfo(dotnet)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(harness);
        start.ArgumentList.Add("session-restart");
        start.ArgumentList.Add(mode);
        start.ArgumentList.Add(root);
        start.ArgumentList.Add("s");
        start.ArgumentList.Add(resultPath);
        if (baseUri is not null && effectRoot is not null)
        {
            start.ArgumentList.Add(baseUri.AbsoluteUri);
            start.ArgumentList.Add(effectRoot);
        }
        return Process.Start(start)
            ?? throw new InvalidOperationException("Unable to start restart harness process.");
    }

    private static async Task<JsonObject> WaitForResultAsync(string path, TimeSpan timeout)
    {
        using var cancellation = new CancellationTokenSource(timeout);
        while (true)
        {
            cancellation.Token.ThrowIfCancellationRequested();
            if (File.Exists(path))
            {
                try
                {
                    return JsonNode
                        .Parse(await File.ReadAllTextAsync(path, cancellation.Token))!
                        .AsObject();
                }
                catch (JsonException) { }
            }
            await Task.Delay(20, cancellation.Token);
        }
    }

    private static async Task<ChildRun> RunHarnessAsync(
        string mode,
        string root,
        string resultPath,
        string logsRoot,
        Uri? baseUri,
        string? effectRoot
    )
    {
        var dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (string.IsNullOrWhiteSpace(dotnetRoot))
            throw new InvalidOperationException(
                "DOTNET_ROOT is required for restart harness tests."
            );
        var dotnet = Path.Combine(
            dotnetRoot,
            OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet"
        );
        var harness = Path.Combine(AppContext.BaseDirectory, "Foxwarm.DevTools.dll");
        if (!File.Exists(harness))
            harness = Path.GetFullPath(
                Path.Combine(
                    AppContext.BaseDirectory,
                    "..",
                    "..",
                    "..",
                    "..",
                    "Foxwarm.DevTools",
                    "bin",
                    "Debug",
                    "net10.0",
                    "Foxwarm.DevTools.dll"
                )
            );
        if (!File.Exists(harness))
            throw new FileNotFoundException("Restart harness assembly was not built.", harness);
        var start = new ProcessStartInfo(dotnet)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(harness);
        start.ArgumentList.Add("session-restart");
        start.ArgumentList.Add(mode);
        start.ArgumentList.Add(root);
        start.ArgumentList.Add("s");
        start.ArgumentList.Add(resultPath);
        if (baseUri is not null && effectRoot is not null)
        {
            start.ArgumentList.Add(baseUri.AbsoluteUri);
            start.ArgumentList.Add(effectRoot);
        }
        var startedAt = DateTimeOffset.UtcNow;
        using var process =
            Process.Start(start)
            ?? throw new InvalidOperationException("Unable to start restart harness process.");
        var pid = process.Id;
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            throw;
        }
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        await File.WriteAllTextAsync(Path.Combine(logsRoot, $"{mode}-{pid}.stdout.log"), stdout);
        await File.WriteAllTextAsync(Path.Combine(logsRoot, $"{mode}-{pid}.stderr.log"), stderr);
        if (process.ExitCode != 0)
            throw new InvalidOperationException(
                $"Restart harness mode {mode} exited {process.ExitCode}. stdout={stdout} stderr={stderr}"
            );
        return new ChildRun(pid, process.ExitCode, startedAt, DateTimeOffset.UtcNow);
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (
            var directory in Directory.EnumerateDirectories(
                source,
                "*",
                SearchOption.AllDirectories
            )
        )
            Directory.CreateDirectory(
                Path.Combine(destination, Path.GetRelativePath(source, directory))
            );
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(destination, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target);
        }
    }

    private sealed record ChildRun(
        int Pid,
        int ExitCode,
        DateTimeOffset StartedAt,
        DateTimeOffset ExitedAt
    );
}
