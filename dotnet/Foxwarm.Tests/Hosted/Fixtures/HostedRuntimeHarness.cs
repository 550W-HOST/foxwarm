using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Secrets;
using Foxwarm.Storage;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// Several hosted tenant runtimes in one process over one database: the production runtime
/// composition (<see cref="HostedEntry.BuildRuntimeAsync"/>), each on its own listener, with a
/// loopback model peer that keeps nothing.
/// </summary>
internal sealed class HostedRuntimeHarness : IAsyncDisposable
{
    private readonly HostedTestDatabase database;
    private readonly PgDatabase app;
    private readonly TempDirectory temp = new();
    private readonly string kek;
    private readonly ModelPeer model = new();

    private HostedRuntimeHarness(HostedTestDatabase database)
    {
        this.database = database;
        app = database.OpenApp();
        kek = Path.Combine(temp.Path, "kek", "current.key");
        InstanceKeys.OpenOrCreate(kek);
    }

    internal static async Task<HostedRuntimeHarness> CreateAsync() =>
        new(await (await PostgresServer.SharedAsync()).CreateDatabaseAsync());

    internal HostedTestDatabase Database => database;

    internal int ModelRequests => model.Requests;

    internal string Models =>
        $"default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: {model.BaseUri}\n    models: [wire]\n";

    internal sealed record Runtime(string Tenant, IHostedRuntime Host, HttpClient Client, string Scratch) : IAsyncDisposable
    {
        internal string Token => Client.DefaultRequestHeaders.Authorization!.Parameter!;

        internal MainHost Main => ((MainHostRuntime)Host).Host;

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await Host.DisposeAsync();
        }
    }

    /// <summary>Creates the tenant when it doesn't exist yet, takes its lease at a new epoch and starts its runtime.</summary>
    internal async Task<Runtime> StartAsync(string tenant, TenantFront? front = null)
    {
        var (_, build, client, scratch) = await BuildAsync(tenant, withKey: true, front);
        var runtime = await build;
        await runtime.StartAsync();
        return new Runtime(tenant, runtime, client, scratch);
    }

    /// <summary>A build of the tenant's runtime whose key ring refuses (no KEK file); returns its context.</summary>
    internal async Task<(PostgresStorageContext Context, Task<IHostedRuntime> Build)> StartWithoutKeyAsync(string tenant)
    {
        var (context, build, client, _) = await BuildAsync(tenant, withKey: false);
        client.Dispose();
        return (context, build);
    }

    private async Task<(PostgresStorageContext, Task<IHostedRuntime>, HttpClient, string)> BuildAsync(
        string tenant,
        bool withKey,
        TenantFront? front = null
    )
    {
        if (await database.ScalarAsync("SELECT count(*) FROM tenants WHERE name = $1", tenant) is 0L)
            await database.ExecuteOwnerAsync(
                $"INSERT INTO tenants (name) VALUES ('{tenant}');"
                    + $" INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = '{tenant}'"
            );
        var tenantId = await database.TenantIdAsync(tenant);
        var epoch = await database.TakeLeaseAsync(tenantId, "harness", TimeSpan.FromHours(1));
        var scratch = Path.Combine(temp.Path, tenant, "scratch");
        var bootstrap = new HostedBootstrap(
            null,
            null,
            tenant,
            PostgresServer.AppRole,
            ScratchRoot: scratch,
            KekFile: withKey ? kek : null
        );
        var port = FreePort();
        var deployment = DeploymentConfiguration.Parse(
            $"bot: {{httpHost: 127.0.0.1, httpPort: {port}}}\nhealth: {{port: 3081}}\nblobs: {{backend: postgres}}\n"
                // The scripted model listens on loopback: an egress exception.
                + "egress: {allow: {hosted: [127.0.0.1]}}\n"
        );
        var context = new PostgresStorageContext(new TenantDb(app, tenantId, epoch), scratch);
        var storage = HostedTestBackend.Compose(context, scratch);
        // Behind a front, the runtime has no listener and its requests carry the tenant's host.
        var server = front?.Server(Host(tenant));
        var build = HostedEntry.BuildRuntimeAsync(context, storage, bootstrap, deployment, server: server);
        var client = front?.Client(Host(tenant)) ?? new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{port}"),
            Timeout = TimeSpan.FromSeconds(30),
        };
        if (withKey)
        {
            await build;
            client.DefaultRequestHeaders.Authorization = new(
                "Bearer",
                storage.Credentials.Read(InstanceCredentialName.HttpToken)
            );
        }
        return (context, build, client, scratch);
    }

    internal static string Host(string tenant) => tenant + ".test";

    /// <summary>
    /// Closes the idle connections of the pool every runtime of the harness shares. Pooled
    /// connections belong to the pool, not to a runtime: how many stay idle after a cycle
    /// depends on that cycle's concurrency.
    /// </summary>
    internal void ClearSharedPool() => app.ClearPool();

    internal async Task InstallModelsAsync(Runtime runtime)
    {
        var saved = await runtime.Client.PostAsJsonAsync("api/setup/models", new { yaml = Models });
        Assert.True(saved.IsSuccessStatusCode, await saved.Content.ReadAsStringAsync());
    }

    /// <summary>Creates a Session and runs turns in it, each until its answer is in the history and the Session is idle.</summary>
    internal static async Task TurnsAsync(HttpClient client, string sessionId, int turns, int padding = 0)
    {
        var pad = padding > 0
            ? " " + string.Concat(Enumerable.Range(0, padding / 8).Select(i => $"w{i % 1000:000}xyz "))
            : "";
        var created = await client.PostAsJsonAsync("api/sessions", new { agentId = "main", sessionId });
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        for (var turn = 0; turn < turns; turn++)
        {
            var sent = await client.PostAsJsonAsync(
                $"api/sessions/{sessionId}/message",
                new { text = $"Turn {turn}: say done.{pad}" }
            );
            Assert.Equal(HttpStatusCode.Accepted, sent.StatusCode);
            var deadline = Stopwatch.StartNew();
            while (true)
            {
                var text = await client.GetStringAsync($"api/sessions/{sessionId}/history");
                var history = JsonNode.Parse(text)!;
                var done = history["messages"]!.AsArray().OfType<JsonObject>().Count(message =>
                    message.ToJsonString().Contains(ModelPeer.Answer, StringComparison.Ordinal)
                );
                if (done > turn && !text.Contains("\"busy\":true", StringComparison.Ordinal))
                    break;
                if (deadline.Elapsed > TimeSpan.FromSeconds(30))
                    throw new TimeoutException($"{sessionId} turn {turn} didn't complete.");
                await Task.Delay(50);
            }
        }
    }

    /// <summary>Managed memory still reachable after full compacting collections, in bytes.</summary>
    internal static long LiveBytes()
    {
        for (var i = 0; i < 3; i++)
        {
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
        }
        return GC.GetTotalMemory(false);
    }

    private static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    public async ValueTask DisposeAsync()
    {
        await model.DisposeAsync();
        await database.DisposeAsync();
        temp.Dispose();
    }

    /// <summary>
    /// A Responses peer that answers every request with one assistant message and keeps nothing
    /// (the scripted test servers keep each request body for their assertions).
    /// </summary>
    private sealed class ModelPeer : IAsyncDisposable
    {
        internal const string Answer = "done-reply";
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource stop = new();
        private readonly Task serving;
        private int requests;

        internal ModelPeer()
        {
            listener.Start();
            BaseUri = new Uri($"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/v1");
            serving = Task.Run(ServeAsync);
        }

        internal Uri BaseUri { get; }
        internal int Requests => Volatile.Read(ref requests);

        private async Task ServeAsync()
        {
            while (!stop.IsCancellationRequested)
            {
                TcpClient accepted;
                try
                {
                    accepted = await listener.AcceptTcpClientAsync(stop.Token);
                }
                catch (Exception) when (stop.IsCancellationRequested)
                {
                    return;
                }
                _ = Task.Run(async () =>
                {
                    using var client = accepted;
                    await using var stream = client.GetStream();
                    _ = await LoopbackResponsesServer.ReadRequestAsync(stream);
                    Interlocked.Increment(ref requests);
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        Encoding.UTF8.GetBytes("data: " + Completed + "\n\n")
                    );
                });
            }
        }

        private static readonly string Completed = new JsonObject
        {
            ["type"] = "response.completed",
            ["response"] = new JsonObject
            {
                ["output"] = new JsonArray(
                    new JsonObject
                    {
                        ["type"] = "message",
                        ["role"] = "assistant",
                        ["content"] = new JsonArray(new JsonObject { ["type"] = "output_text", ["text"] = Answer }),
                    }
                ),
            },
        }.ToJsonString();

        public async ValueTask DisposeAsync()
        {
            stop.Cancel();
            listener.Stop();
            await serving;
            stop.Dispose();
        }
    }
}
