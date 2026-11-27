using Foxwarm.Hosted;
using System.Text.Json.Nodes;
using Xunit.Abstractions;

namespace Foxwarm.Tests.Hosted;

// Several hosted tenant runtimes in one process (P2 runtimes host, batch 1): one Console capture
// for all of them, and a disposed runtime gives its memory back. These replace the process
// console and measure process memory, so they run alone.
[Trait("Backend", "postgres")]
[Collection("Process console")]
public sealed class HostedRuntimesInProcessTests(ITestOutputHelper output)
{
    [Fact]
    public async Task ManyRuntimesShareOneConsoleCaptureAndTagTheirLines()
    {
        const int Runtimes = 12;
        var originalOut = Console.Out;
        var originalError = Console.Error;
        using var stdout = new StringWriter();
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        var runtimes = new List<HostedRuntimeHarness.Runtime>();
        try
        {
            Console.SetOut(stdout);
            var before = Console.Out;
            TextWriter? captured = null;
            for (var index = 0; index < Runtimes; index++)
            {
                runtimes.Add(await harness.StartAsync(index == 0 ? PostgresServer.Tenant : "t" + index));
                // Every later runtime joins the first one's capture instead of wrapping it.
                captured ??= Console.Out;
                Assert.Same(captured, Console.Out);
            }
            Assert.NotSame(before, Console.Out);
            // The replica's log records every tenant it serves; no tenant host serves it.
            var logs = await runtimes[1].Client.GetAsync("api/webui/logs?direction=latest");
            Assert.Equal(System.Net.HttpStatusCode.NotFound, logs.StatusCode);
            // Disposing one runtime leaves the shared capture to the others.
            await runtimes[0].DisposeAsync();
            runtimes.RemoveAt(0);
            Assert.Same(captured, Console.Out);
            foreach (var runtime in runtimes)
                await runtime.DisposeAsync();
            runtimes.Clear();
            Assert.Same(before, Console.Out);
            Assert.Same(originalError, Console.Error);
        }
        finally
        {
            foreach (var runtime in runtimes)
                await runtime.DisposeAsync();
            Console.SetOut(originalOut);
            Console.SetError(originalError);
        }
        var lines = stdout.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonNode.Parse(line)!.AsObject())
            .ToArray();
        output.WriteLine($"{lines.Length} stdout lines, {stdout.ToString().Length} characters");
        // Each line is recorded once: no line's message is itself a recorded JSON line.
        Assert.All(
            lines,
            line => Assert.False(line["msg"]!.ToString().StartsWith("{\"level\":", StringComparison.Ordinal))
        );
        // Each runtime's startup line names its own tenant.
        var listening = lines
            .Where(line => line["msg"]!.ToString().StartsWith("Main HTTP listening", StringComparison.Ordinal))
            .Select(line => line["tenant"]?.ToString())
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(
            Enumerable.Range(0, Runtimes).Select(i => i == 0 ? PostgresServer.Tenant : "t" + i).Order(StringComparer.Ordinal),
            listening
        );
    }

    [Fact]
    public async Task ARuntimeBuiltLoadedAndDisposedRepeatedlyReturnsItsMemory()
    {
        const int Cycles = 20;
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        var samples = new List<long>();
        for (var cycle = 0; cycle < Cycles; cycle++)
        {
            await CycleAsync(harness, cycle);
            samples.Add(HostedRuntimeHarness.LiveBytes());
        }
        output.WriteLine(
            "managed live MiB after each cycle: "
                + string.Join(", ", samples.Select(bytes => (bytes / 1048576.0).ToString("F1")))
        );
        // Within a few MiB of where the first cycle left it.
        Assert.InRange(samples[^1] - samples[0], long.MinValue, 4L * 1024 * 1024);
    }

    [Fact]
    public async Task ARetiredRuntimeIsUnreachableAndReturnsItsThreadsAndDescriptors()
    {
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        // A survivor tenant keeps serving throughout; its own warm-up isn't counted.
        await using var survivor = await harness.StartAsync("survivor");
        await harness.InstallModelsAsync(survivor);
        await HostedRuntimeHarness.TurnsAsync(survivor.Client, "s0", 1);
        // Warm the process with one full cycle of the retiring tenant before the baseline.
        _ = await RetireAsync(harness, "warm-up");
        var (threads, descriptors) = await SettledResourcesAsync(harness);
        // Several retirements: what a runtime leaks grows with each one, while what the process
        // holds anyway (the shared pool, cached handles) doesn't.
        for (var cycle = 0; cycle < 3; cycle++)
        {
            var retired = await RetireAsync(harness, cycle == 0 ? PostgresServer.Tenant : "retired-" + cycle);
            var alive = await StillReachableAsync(retired);
            Assert.True(alive.Length == 0, "still reachable after disposal: " + string.Join(", ", alive));
            var (threadsAfter, descriptorsAfter) = await SettledResourcesAsync(harness);
            output.WriteLine($"cycle {cycle}: threads {threads} → {threadsAfter}; descriptors {descriptors} → {descriptorsAfter}");
            Assert.InRange(threadsAfter, 0, threads + 2);
            Assert.InRange(descriptorsAfter, 0, descriptors + 2);
        }
        await HostedRuntimeHarness.TurnsAsync(survivor.Client, "s1", 1);
    }

    [Fact]
    public async Task ABuildThatFailsReleasesWhatItStarted()
    {
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        await using (var first = await harness.StartAsync("first")) { }
        var (threads, descriptors) = await SettledResourcesAsync(harness);
        // The key ring refuses (no KEK), after the context started its journal writer.
        var (context, writer) = await FailedBuildAsync(harness);
        // The journal writer the context started is stopped, not left waiting for commands.
        await Assert.ThrowsAsync<System.Threading.Channels.ChannelClosedException>(() => writer.BarrierAsync());
        Assert.Empty(await StillReachableAsync([("context", context)]));
        var (threadsAfter, descriptorsAfter) = await SettledResourcesAsync(harness);
        Assert.InRange(threadsAfter, 0, threads + 2);
        Assert.InRange(descriptorsAfter, 0, descriptors + 2);
    }

    private static async Task<(WeakReference, Foxwarm.Hosted.Postgres.PgJournalWriter)> FailedBuildAsync(
        HostedRuntimeHarness harness
    )
    {
        var (context, build) = await harness.StartWithoutKeyAsync("first");
        await Assert.ThrowsAsync<HostedStartupException>(() => build);
        return (new WeakReference(context), ((Foxwarm.Hosted.Postgres.PgLlmJournalStore)context.Journal).Writer);
    }

    // Starts, loads (one large owner) and disposes a tenant's runtime; returns weak references
    // to what the runtime owned.
    private static async Task<(string Name, WeakReference Reference)[]> RetireAsync(HostedRuntimeHarness harness, string tenant)
    {
        var runtime = await harness.StartAsync(tenant);
        await harness.InstallModelsAsync(runtime);
        await HostedRuntimeHarness.TurnsAsync(runtime.Client, "large", 10, padding: 8192);
        var owner = await runtime.Main.Sessions.GetExistingAsync("large");
        Assert.NotNull(owner);
        var references = new (string, WeakReference)[]
        {
            ("MainHost", new WeakReference(runtime.Main)),
            ("SessionManager", new WeakReference(runtime.Main.Sessions)),
            ("large owner", new WeakReference(owner)),
        };
        owner = null;
        await runtime.DisposeAsync();
        return references;
    }

    // What is still reachable once disposal has settled: continuations and cancelled timers of
    // the disposal may hold the graph for a moment (about 150 ms measured), not longer.
    private async Task<string[]> StillReachableAsync((string Name, WeakReference Reference)[] references)
    {
        var settling = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            HostedRuntimeHarness.LiveBytes();
            var alive = references.Where(entry => entry.Reference.IsAlive).Select(entry => entry.Name).ToArray();
            if (alive.Length == 0 || settling.Elapsed > TimeSpan.FromSeconds(3))
            {
                output.WriteLine($"unreachable check after {settling.ElapsedMilliseconds} ms: {alive.Length} alive");
                return alive;
            }
            await Task.Delay(50);
        }
    }

    private static async Task<(int Threads, int Descriptors)> SettledResourcesAsync(HostedRuntimeHarness harness)
    {
        // Thread-pool threads retire after an idle period; sample until two readings agree.
        // The shared pool's idle connections are closed first, so its size doesn't count.
        var previous = (-1, -1);
        for (var attempt = 0; attempt < 40; attempt++)
        {
            harness.ClearSharedPool();
            HostedRuntimeHarness.LiveBytes();
            var current = (Threads(), Directory.GetFiles("/proc/self/fd").Length);
            if (current == previous)
                return current;
            previous = current;
            await Task.Delay(250);
        }
        return previous;
    }

    private static int Threads() =>
        int.Parse(
            File.ReadLines("/proc/self/status").First(line => line.StartsWith("Threads:", StringComparison.Ordinal))[8..].Trim()
        );

    // A separate method so that nothing of the runtime stays reachable from the test's frame.
    private static async Task CycleAsync(HostedRuntimeHarness harness, int cycle)
    {
        await using var runtime = await harness.StartAsync(PostgresServer.Tenant);
        if (cycle == 0)
            await harness.InstallModelsAsync(runtime);
        for (var session = 0; session < 3; session++)
            await HostedRuntimeHarness.TurnsAsync(runtime.Client, $"c{cycle}s{session}", 2, padding: 4096);
    }
}
