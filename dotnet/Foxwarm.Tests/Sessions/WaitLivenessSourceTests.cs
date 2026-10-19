using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WaitLivenessSourceTests
{
    private static string Repository =>
        Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
        ?? throw new InvalidOperationException("Owned source fixture root is required.");

    private static async Task<JsonObject> Source(string root, string graph, string mode = "seed")
    {
        using var process = Process.Start(
            new ProcessStartInfo("node")
            {
                WorkingDirectory = Repository,
                ArgumentList =
                {
                    Path.Combine(Repository, "dotnet", "wait-liveness-fixture-ts.mjs"),
                    mode,
                    root,
                    graph,
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
        const string prefix = "WAIT_LIVENESS_FIXTURE:";
        return JsonNode
            .Parse(
                text.Split('\n').Single(line => line.StartsWith(prefix, StringComparison.Ordinal))[
                    prefix.Length..
                ]
            )!
            .AsObject();
    }

    private static string Authority(string root, string id) =>
        Path.Combine(root, "state", "sessions", id + ".json");

    private static JsonArray History(SessionOwner owner) =>
        new(owner.History().Select(row => (JsonNode)row.DeepClone()).ToArray());

    private static void Same(JsonNode? expected, JsonNode? actual) =>
        Assert.True(JsonNode.DeepEquals(expected, actual), $"Expected {expected}; actual {actual}");

    private static JsonObject Arguments(JsonObject fixture) =>
        new() { ["waitAnySessions"] = fixture["targets"]!.DeepClone() };

    private static async Task Settle(SessionManager manager)
    {
        // More than two normal diagnostic grace windows, then drain actual foreground saves.
        await Task.Delay(800);
        foreach (var owner in manager.Owners())
            await owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(10));
    }

    private sealed class Peer : IAsyncDisposable
    {
        private readonly HttpListener listener = new();
        private readonly CancellationTokenSource stop = new();
        private readonly Task loop;
        internal readonly ConcurrentQueue<JsonObject> Requests = new();
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
                        JsonNode
                            .Parse(
                                await new StreamReader(context.Request.InputStream).ReadToEndAsync()
                            )!
                            .AsObject()
                    );
                    var payload = new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject
                        {
                            ["id"] = "synthetic-liveness",
                            ["output"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "message",
                                    ["role"] = "assistant",
                                    ["content"] = new JsonArray(
                                        new JsonObject
                                        {
                                            ["type"] = "output_text",
                                            ["text"] = "Synthetic diagnostic received.",
                                        }
                                    ),
                                }
                            ),
                            ["usage"] = new JsonObject
                            {
                                ["input_tokens"] = 10,
                                ["output_tokens"] = 3,
                            },
                        },
                    };
                    context.Response.ContentType = "text/event-stream";
                    await context.Response.OutputStream.WriteAsync(
                        Encoding.UTF8.GetBytes("data: " + payload.ToJsonString() + "\n\n")
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

    [Theory]
    [InlineData("idle")]
    [InlineData("cycle")]
    [InlineData("missing")]
    public async Task Actual_Source_observation_survives_normal_startup_strict_save_reopen_and_transition(
        string graph
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var fixture = await Source(data, graph);
        var id = fixture["id"]!.GetValue<string>();
        await using var peer = new Peer();
        for (var opening = 0; opening < 2; opening++)
        {
            await using var manager = new SessionManager(
                data,
                work,
                peer.Options,
                HostModels.ForTest(peer.Options)
            );
            Assert.Contains(id, manager.Catalog.RestartIds());
            await manager.LoadMainHostAsync();
            var owner = manager.Find(id)!;
            await Settle(manager);
            Assert.Empty(peer.Requests);
            Same(fixture["wait"], owner.Entry.Snapshot().Meta["wait"]);
            Same(fixture["fingerprints"], owner.Entry.Snapshot().Meta["waitLivenessFingerprints"]);
            Same(fixture["history"], History(owner));
            Assert.Empty(owner.Entry.Snapshot().Queue);
            await owner.Entry.SaveLane.SaveStrictAsync();
            var stored = JsonNode.Parse(await File.ReadAllTextAsync(Authority(data, id)))!;
            Same(fixture["wait"], stored["meta"]!["wait"]);
            Same(fixture["history"], stored["history"]);
            // A fresh declaration is another normal transition, not a new graph observation.
            if (graph == "missing")
                await owner.Entry.SaveLane.StartWaitAsync((JsonObject)fixture["wait"]!.DeepClone());
            else
                await manager.DeclareWaitAsync(owner, Arguments(fixture));
            await Settle(manager);
            Assert.Empty(peer.Requests);
            Same(fixture["fingerprints"], owner.Entry.Snapshot().Meta["waitLivenessFingerprints"]);
            fixture["wait"] = owner.Entry.Snapshot().Meta["wait"]!.DeepClone();
        }
    }

    [Fact]
    public async Task Unseen_changed_graph_delivers_one_Source_identical_diagnostic_and_deduplicates_after_reopen()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var original = await Source(data, "idle");
        var changed = await Source(Path.Combine(temp.Path, "oracle"), "changed");
        await using var peer = new Peer();
        JsonNode? prints;
        JsonArray history;
        await using (
            var manager = new SessionManager(
                data,
                work,
                peer.Options,
                HostModels.ForTest(peer.Options)
            )
        )
        {
            await manager.LoadMainHostAsync();
            var owner = manager.Find("waiter")!;
            await Settle(manager);
            Assert.Empty(peer.Requests);
            await manager.CreateNamedAsync("main", "different-dependency", null, null);
            await manager.DeclareWaitAsync(owner, Arguments(changed));
            await Settle(manager);
            Assert.Single(peer.Requests);
            Assert.Null(owner.WaitSnapshot());
            prints = owner.Entry.Snapshot().Meta["waitLivenessFingerprints"]!.DeepClone();
            Assert.Equal(
                new[]
                {
                    original["fingerprints"]![0]!.GetValue<string>(),
                    changed["fingerprints"]![0]!.GetValue<string>(),
                },
                SessionWait.Strings(prints)
            );
            history = History(owner);
            Assert.Equal(original["history"]!.AsArray().Count + 2, history.Count);
            Assert.Contains(
                changed["fingerprints"]![0]!.GetValue<string>(),
                history[^2]!.ToJsonString()
            );
            Assert.Contains("wait-sources-quiescent", peer.Requests.Single().ToJsonString());
            await manager.DeclareWaitAsync(owner, Arguments(changed));
            await Settle(manager);
            Assert.Single(peer.Requests);
        }
        await using (
            var manager = new SessionManager(
                data,
                work,
                peer.Options,
                HostModels.ForTest(peer.Options)
            )
        )
        {
            await manager.LoadMainHostAsync();
            await Settle(manager);
            Assert.Single(peer.Requests);
            var owner = manager.Find("waiter")!;
            Same(prints, owner.Entry.Snapshot().Meta["waitLivenessFingerprints"]);
            Same(history, History(owner));
            Assert.NotNull(owner.WaitSnapshot());
        }
    }

    [Fact]
    public async Task Legitimate_busy_recovery_still_runs_independently_of_recorded_wait_diagnostics()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var fixture = await Source(data, "idle");
        var file = Authority(data, "dependency");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        raw["busy"] = true;
        raw["busyStartedAt"] = 1;
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            var row = catalog.Get("dependency")!;
            row["busy"] = true;
            row["busyStartedAt"] = 1;
            catalog.Upsert([row]);
        }
        await using var peer = new Peer();
        await using var manager = new SessionManager(
            data,
            work,
            peer.Options,
            HostModels.ForTest(peer.Options)
        );
        await manager.LoadMainHostAsync();
        await Settle(manager);
        Assert.Single(peer.Requests);
        var owner = manager.Find("waiter")!;
        Same(fixture["wait"], owner.Entry.Snapshot().Meta["wait"]);
        Same(fixture["fingerprints"], owner.Entry.Snapshot().Meta["waitLivenessFingerprints"]);
        Same(fixture["history"], History(owner));
        var recovered = manager.Find("dependency")!;
        Assert.False(recovered.Metadata().Busy);
        Assert.Equal(2, recovered.History().Count);
        Assert.Contains("session-resumed", recovered.History()[0].ToJsonString());
    }

    [Theory]
    [InlineData("idle")]
    [InlineData("cycle")]
    public async Task Original_CSharp_writer_receipt_is_read_without_replaying_or_rewriting_it(
        string graph
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var source = await Source(data, graph, "unseen");
        var records = JsonNode
            .Parse(
                await File.ReadAllTextAsync(
                    Path.Combine(
                        Repository,
                        "dotnet",
                        "Foxwarm.Tests",
                        "Sessions",
                        "Fixtures",
                        "wait-liveness-csharp-v1.json"
                    )
                )
            )!
            .AsArray();
        var recorded = records.Single(row => SessionWait.Text(row!["graph"]) == graph)!;
        var id = recorded["id"]!.GetValue<string>();
        var file = Authority(data, id);
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        // These are the actual strict-saved fields from the original C# writer, not computed hashes.
        foreach (var field in recorded["meta"]!.AsObject())
            raw["meta"]![field.Key] = field.Value!.DeepClone();
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        await using var peer = new Peer();
        for (var opening = 0; opening < 2; opening++)
        {
            await using var manager = new SessionManager(
                data,
                work,
                peer.Options,
                HostModels.ForTest(peer.Options)
            );
            await manager.LoadMainHostAsync();
            await Settle(manager);
            var owner = manager.Find(id)!;
            Assert.Empty(peer.Requests);
            Same(raw["meta"]!["wait"], owner.Entry.Snapshot().Meta["wait"]);
            Same(
                recorded["meta"]!["waitLivenessFingerprints"],
                owner.Entry.Snapshot().Meta["waitLivenessFingerprints"]
            );
            Same(source["history"], History(owner));
            await owner.Entry.SaveLane.SaveStrictAsync();
            Same(
                recorded["meta"]!["waitLivenessFingerprints"],
                JsonNode.Parse(await File.ReadAllTextAsync(file))!["meta"]![
                    "waitLivenessFingerprints"
                ]
            );
        }
        // Read-old interpretation applies only to the same observation. New work is still delivered once.
        await using (
            var manager = new SessionManager(
                data,
                work,
                peer.Options,
                HostModels.ForTest(peer.Options)
            )
        )
        {
            await manager.LoadMainHostAsync();
            var owner = manager.Find(id)!;
            await manager.CreateNamedAsync("main", "different-dependency", null, null);
            await manager.DeclareWaitAsync(
                owner,
                new JsonObject { ["waitAnySessions"] = new JsonArray("different-dependency") }
            );
            await Settle(manager);
            Assert.Single(peer.Requests);
            var prints = SessionWait.Strings(
                owner.Entry.Snapshot().Meta["waitLivenessFingerprints"]
            );
            Assert.Equal(2, prints.Length);
            Assert.Equal(
                recorded["meta"]!["waitLivenessFingerprints"]![0]!.GetValue<string>(),
                prints[0]
            );
            await manager.DeclareWaitAsync(
                owner,
                new JsonObject { ["waitAnySessions"] = new JsonArray("different-dependency") }
            );
            await Settle(manager);
            Assert.Single(peer.Requests);
            Assert.Equal(
                prints,
                SessionWait.Strings(owner.Entry.Snapshot().Meta["waitLivenessFingerprints"])
            );
        }
    }

    [Fact]
    public async Task Input_backed_progress_blocks_diagnostic_until_the_dependency_becomes_idle()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var source = await Source(data, "idle", "unseen");
        var oracle = await Source(Path.Combine(temp.Path, "oracle"), "idle");
        await using var peer = new Peer();
        await using var manager = new SessionManager(
            data,
            work,
            peer.Options,
            HostModels.ForTest(peer.Options)
        );
        // Prepare a genuine declared input wait before normal startup enables diagnostics.
        var dependency = await manager.RequiredAsync("dependency");
        await manager.DeclareWaitAsync(dependency, new JsonObject { ["waitForInput"] = true });
        await manager.LoadMainHostAsync();
        await Settle(manager);
        var owner = manager.Find("waiter")!;
        Assert.Empty(peer.Requests);
        Same(source["wait"], owner.Entry.Snapshot().Meta["wait"]);
        Assert.Null(owner.Entry.Snapshot().Meta["waitLivenessFingerprints"]);
        await dependency.Entry.SaveLane.ClearWaitAsync();
        await Settle(manager);
        Assert.Single(peer.Requests);
        Same(oracle["fingerprints"], owner.Entry.Snapshot().Meta["waitLivenessFingerprints"]);
        Assert.Null(owner.WaitSnapshot());
    }
}
