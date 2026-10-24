using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Xunit.Abstractions;

namespace Foxwarm.Tests;

public sealed class SessionStartupMemoryTests(ITestOutputHelper output)
{
    private static async Task<JsonObject> Source(string mode, string root)
    {
        var repository =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("Owned Source fixture root is required.");
        using var process = Process.Start(
            new ProcessStartInfo("node")
            {
                WorkingDirectory = repository,
                ArgumentList =
                {
                    Path.Combine(repository, "dotnet", "Foxwarm.Tests", "Fixtures", "session-startup-memory-fixture-ts.mjs"),
                    mode,
                    root,
                },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }
        )!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var text = await stdout;
        Assert.True(process.ExitCode == 0, text + await stderr);
        const string prefix = "SESSION_STARTUP_FIXTURE:";
        return JsonNode
            .Parse(
                text.Split('\n').Single(line => line.StartsWith(prefix, StringComparison.Ordinal))[
                    prefix.Length..
                ]
            )!
            .AsObject();
    }

    [Fact]
    public async Task Source_and_managed_startup_keep_438_wait_only_sessions_cold_across_queries_and_restart()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var oracle = Path.Combine(temp.Path, "oracle");
        await Source("seed", data);
        foreach (var file in Directory.EnumerateFiles(data, "*", SearchOption.AllDirectories))
        {
            var copy = Path.Combine(oracle, Path.GetRelativePath(data, file));
            Directory.CreateDirectory(Path.GetDirectoryName(copy)!);
            File.Copy(file, copy);
        }
        var source = await Source("inspect", oracle);
        Assert.Equal(new[] { "busy", "queued" }, SessionWait.Strings(source["hydrated"]));
        await using var peer = new Peer();
        for (var opening = 0; opening < 2; opening++)
        {
            await using var manager = new SessionManager(
                data,
                Path.Combine(temp.Path, "work"),
                peer.Options,
                HostModels.ForTest(peer.Options)
            );
            var reads = new ConcurrentBag<string>();
            manager.AdmissionReadObserved = reads.Add;
            await manager.LoadMainHostAsync();
            await Settle(manager);
            var view = new SessionListQueries(new SessionRuntime(manager));
            Assert.Equal(440, view.GlobalSummary()["total"]!.GetValue<long>());
            Assert.NotNull(view.Projection("legacy-0"));
            Assert.Equal(440, manager.Catalog.List().Length);
            Assert.Equal(440, manager.Catalog.Count());
            output.WriteLine(
                $"Opening {opening}: catalog=440, wait-only=438, authority reads={reads.Count}, owners={manager.Owners().Count()}, provider requests={peer.Requests.Count}."
            );
            foreach (var id in SessionWait.Strings(source["coldIds"]))
            {
                Assert.NotNull(manager.CatalogMetadata(id)!.Wait);
                Assert.Null(manager.Find(id));
            }
            Assert.Equal(
                opening == 0 ? new[] { "busy", "queued" } : [],
                reads.Order(StringComparer.Ordinal)
            );
            Assert.Equal(opening == 0 ? 2 : 0, manager.Owners().Count());
            Assert.Equal(2, peer.Requests.Count);
            if (opening == 0)
            {
                Assert.Contains(
                    "session-resumed",
                    manager.Find("busy")!.History()[1].ToJsonString()
                );
                Assert.Contains(
                    "Synthetic pending work.",
                    manager.Find("queued")!.History()[1].ToJsonString()
                );
            }
        }
    }

    [Fact]
    public void Recovery_query_keeps_managed_pending_candidates_without_selecting_wait_presence()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        var managed = SessionCatalogTests.Row("managed", 0);
        managed["managedPendingCount"] = 1;
        var waiting = SessionCatalogTests.Row("waiting", 0);
        waiting["meta"]!["wait"] = new JsonObject { ["id"] = "legacy", ["startedAt"] = 1 };
        catalog.Upsert([managed, waiting]);
        Assert.Equal(new[] { "managed" }, catalog.RestartIds());
    }

    [Fact]
    public async Task Cold_wait_deadline_ordinary_timer_and_direct_event_admit_only_their_target()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        await using var peer = new Peer();
        await using (
            var seed = new SessionManager(
                data,
                work,
                peer.Options,
                HostModels.ForTest(peer.Options)
            )
        )
        {
            await seed.LoadAsync();
            foreach (var id in new[] { "timed", "ordinary", "event" })
            {
                var owner = await seed.CreateNamedAsync("main", id, null, null);
                await seed.DeclareWaitAsync(
                    owner,
                    id == "timed"
                        ? new JsonObject { ["wakeIfNoActivityAfterSeconds"] = 3 }
                        : new JsonObject { ["waitForInput"] = true }
                );
            }
        }
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "timers.json"),
            new JsonObject
            {
                ["timers"] = new JsonArray(
                    new JsonObject
                    {
                        ["id"] = "owned-once",
                        ["sessionId"] = "ordinary",
                        ["message"] = "Synthetic ordinary timer",
                        ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 3000,
                    }
                ),
            }.ToJsonString()
        );
        await using var manager = new SessionManager(
            data,
            work,
            peer.Options,
            HostModels.ForTest(peer.Options)
        );
        await manager.LoadMainHostAsync();
        Assert.Empty(manager.Owners());
        await manager.AdmitWaitEventAsync(
            "event",
            SessionWait.Event("synthetic-event", "Synthetic direct event")
        );
        Assert.Null(manager.Find("timed"));
        Assert.Null(manager.Find("ordinary"));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (peer.Requests.Count != 3)
            await Task.Delay(20, deadline.Token);
        await Settle(manager);
        Assert.Equal(
            new[] { "event", "ordinary", "timed" },
            manager.Owners().Select(owner => owner.Id).Order(StringComparer.Ordinal)
        );
        Assert.Contains("wait-timeout", manager.Find("timed")!.History()[0].ToJsonString());
        Assert.Contains(
            "Synthetic ordinary timer",
            manager.Find("ordinary")!.History()[0].ToJsonString()
        );
        Assert.All(manager.Owners(), owner => Assert.Null(owner.WaitSnapshot()));
    }

    [Fact]
    public async Task Independent_native_exec_registry_owner_is_loaded_without_busy_queue_or_wait()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        var release = Path.Combine(temp.Path, "release");
        await using var peer = new Peer();
        try
        {
            await using (
                var seed = new SessionManager(
                    data,
                    work,
                    peer.Options,
                    HostModels.ForTest(peer.Options)
                )
            )
            {
                await seed.LoadAsync();
                var owner = await seed.CreateNamedAsync("main", "exec-owner", null, null);
                var result = await owner.Executor.ExecuteAsync(
                    owner.Id,
                    new JsonObject
                    {
                        ["command"] =
                            $"while [ ! -f '{release}' ]; do sleep .05; done; printf completed",
                        ["timeout"] = 1,
                    },
                    default
                );
                Assert.Contains("Switched to background", result["output"]!.GetValue<string>());
            }
            await using var manager = new SessionManager(
                data,
                work,
                peer.Options,
                HostModels.ForTest(peer.Options)
            );
            Assert.Empty(manager.Catalog.RestartIds());
            await manager.LoadMainHostAsync();
            var recovered = Assert.Single(manager.Owners());
            Assert.Equal("exec-owner", recovered.Id);
            Assert.Null(recovered.WaitSnapshot());
            await File.WriteAllTextAsync(release, "finish");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            while (peer.Requests.IsEmpty)
            {
                await recovered.Executor.ReconcileNowAsync();
                await Task.Delay(20, deadline.Token);
            }
            await Settle(manager);
            Assert.Contains("background-process-finished", recovered.History()[0].ToJsonString());
        }
        finally
        {
            await File.WriteAllTextAsync(release, "finish");
        }
    }

    private static async Task Settle(SessionManager manager)
    {
        await Task.Delay(750);
        foreach (var owner in manager.Owners())
            await owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(10));
    }

    private sealed class Peer : IAsyncDisposable
    {
        private readonly HttpListener listener = new();
        private readonly Task loop;
        private readonly CancellationTokenSource stop = new();
        internal readonly ConcurrentQueue<string> Requests = new();
        internal ResponsesClientOptions Options { get; }

        internal Peer()
        {
            var reserve = new TcpListener(IPAddress.Loopback, 0);
            reserve.Start();
            var port = ((IPEndPoint)reserve.LocalEndpoint).Port;
            reserve.Stop();
            var uri = new Uri("http://127.0.0.1:" + port);
            Options = new(uri, "wire", "a/wire", "", "", 713);
            listener.Prefixes.Add(uri + "/");
            listener.Start();
            loop = Serve();
        }

        private async Task Serve()
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    var context = await listener.GetContextAsync().WaitAsync(stop.Token);
                    Requests.Enqueue(
                        await new StreamReader(context.Request.InputStream).ReadToEndAsync()
                    );
                    var payload =
                        """{"type":"response.completed","response":{"id":"synthetic-startup","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Synthetic work received."}]}],"usage":{"input_tokens":10,"output_tokens":3}}}""";
                    context.Response.ContentType = "text/event-stream";
                    await context.Response.OutputStream.WriteAsync(
                        Encoding.UTF8.GetBytes("data: " + payload + "\n\n")
                    );
                    context.Response.Close();
                }
            }
            catch (Exception error)
                when (stop.IsCancellationRequested
                    && error
                        is OperationCanceledException
                            or HttpListenerException
                            or ObjectDisposedException
                ) { }
        }

        public async ValueTask DisposeAsync()
        {
            stop.Cancel();
            listener.Stop();
            await loop;
            listener.Close();
            stop.Dispose();
        }
    }
}
