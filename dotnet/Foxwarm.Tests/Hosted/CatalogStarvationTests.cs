using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Postgres.Authority;
using Foxwarm.Storage;
using Foxwarm.Tools;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Xunit;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// Runs alone: it caps the process's worker threads.
/// </summary>
[CollectionDefinition("Capped thread pool", DisableParallelization = true)]
public sealed class CappedThreadPoolCollection;

// Npgsql's synchronous reads on Linux wait for a socket completion that a pool thread delivers.
// A burst of catalog writers blocking pool threads on a gate whose holder reads synchronously
// starved that delivery until the server ended the holder's transaction (25P03). A small,
// fixed worker pool reproduces that schedule without depending on pool growth heuristics.
[Trait("Backend", "postgres")]
[Collection("Capped thread pool")]
public sealed class CatalogStarvationTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static async Task WithCappedPoolAsync(Func<Task> body)
    {
        ThreadPool.GetMaxThreads(out var workers, out var ports);
        ThreadPool.GetMinThreads(out var minimumWorkers, out var minimumPorts);
        var cap = Math.Clamp(Environment.ProcessorCount, 4, 8);
        try
        {
            Assert.True(ThreadPool.SetMinThreads(Math.Min(minimumWorkers, cap), minimumPorts));
            Assert.True(ThreadPool.SetMaxThreads(cap, ports));
            await body().WaitAsync(TimeSpan.FromSeconds(60));
        }
        finally
        {
            ThreadPool.SetMaxThreads(workers, ports);
            ThreadPool.SetMinThreads(minimumWorkers, minimumPorts);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SetupAndPolicyYieldWhileAnIndependentTenantRemainsResponsive(bool policy)
    {
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        await using var slow = await harness.StartAsync("alpha", maxInFlight: 1);
        await using var fast = await harness.StartAsync("beta", maxInFlight: 1);
        var manager = slow.Main.Sessions;
        var db = ((PostgresSessionAuthorityBackend)manager.Storage.Authority).Database;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var holding = db.ReadAsync(async (_, _) => { entered.SetResult(); await release.Task; return 1; });
        await entered.Task;
        manager.Authorization.Invalidate();
        Task Submit()
        {
            if (policy) return manager.Authorization.LoadAsync();
            var app = slow.Main.App;
            var endpoint = app.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
                .Single(item => item.RoutePattern.RawText == "/api/setup/status");
            var context = new DefaultHttpContext { RequestServices = app.Services };
            context.SetEndpoint(endpoint);
            context.Request.Method = "GET";
            return endpoint.RequestDelegate!(context);
        }
        var submitted = Task.Factory.StartNew(Submit, CancellationToken.None, TaskCreationOptions.None, TaskScheduler.Default);
        try
        {
            var blocked = await submitted.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.False(blocked.IsCompleted);
            using var response = await fast.Client.GetAsync("/api/setup/status").WaitAsync(TimeSpan.FromSeconds(4));
            response.EnsureSuccessStatusCode();
            await fast.Main.Sessions.Authorization.LoadAsync().WaitAsync(TimeSpan.FromSeconds(4));
        }
        finally { release.TrySetResult(); await holding; await submitted.Unwrap(); }
    }

    [Fact]
    public async Task ABurstOfPresentationChangesCompletesOnACappedPool()
    {
        using var temp = new TempDirectory();
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            Options,
            HostModels.ForTest(Options),
            storage: HostedTestBackend.Create(Path.Combine(temp.Path, "data"), maxInFlight: 1)
        );
        await manager.LoadAsync();
        var parent = await manager.CreateNamedAsync("main", "parent", null, null);
        var child = await manager.CreateNamedAsync("main", "child", null, null);
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        using var socket = new WebUiRealtimeRevisionTests.ProbeSocket();
        var subscriber = new WebUiRealtime(new SessionRuntime(manager)).RunAsync(socket, stop.Token);
        try
        {
            socket.SetSubscriptions(1, null, [child.Id]);
            while (!socket.Frames.Any(frame => frame["type"]?.ToString() == "subscriptions-applied"))
                await Task.Delay(5, stop.Token);
            await WithCappedPoolAsync(() =>
                SessionIdentityInterleavingTests.ExerciseConcurrentParentChangesAsync(manager, parent, child));
            while (socket.Frames.Count(frame => frame["type"]?.ToString() == "session-list-delta") < 2)
                await Task.Delay(5, stop.Token);
        }
        finally
        {
            stop.Cancel();
            try { await subscriber; } catch (OperationCanceledException) { }
        }

        // The WebUI list projection reads catalog rows and archive counts in the same request.
        var list = new SessionListQueries(new SessionRuntime(manager));
        var page = await list.ExactAsync([parent.Id, child.Id], true);
        Assert.Equal(2, page["results"]!.AsArray().Count);
    }

    [Fact]
    public async Task ARenderedBatchReadsItsInstalledModelsOnceThroughAsyncAdmission()
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "data");
        var storage = HostedTestBackend.Create(root, maxInFlight: 1);
        var documents = new ModelReads(new PgConfigDocuments(HostedTestBackend.TenantDatabase(root)));
        await documents.ReplaceAsync(ConfigDocumentName.Models,
            "default: local/wire\nproviders:\n  local: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}\n"u8.ToArray(), default);
        var configuration = PostgresConfigDocumentsContractTests.Hosted(documents, root);
        await using var manager = new SessionManager(root, Path.Combine(temp.Path, "work"), Options, configuration.Models, storage: storage);
        await manager.LoadAsync();
        await manager.CreateNamedAsync("main", "first", null, null);
        await manager.CreateNamedAsync("main", "second", null, null);
        var before = (documents.SyncReads, documents.AsyncReads);
        var rows = await new SessionRuntime(manager).ProjectionsAsync(["first", "second"]);
        Assert.Equal(2, rows.Length);
        Assert.All(rows, row => Assert.Equal("local/wire", row["defaultModelKey"]!.ToString()));
        Assert.Equal((before.SyncReads, before.AsyncReads + 1), (documents.SyncReads, documents.AsyncReads));
    }

    private sealed class ModelReads(IConfigDocumentStore inner) : IConfigDocumentStore
    {
        internal int SyncReads, AsyncReads;
        public bool DirectEdits => inner.DirectEdits;
        public string Locator(ConfigDocumentName name) => inner.Locator(name);
        public string? PhysicalPath(ConfigDocumentName name) => inner.PhysicalPath(name);
        public bool Exists(ConfigDocumentName name) => inner.Exists(name);
        public byte[]? Read(ConfigDocumentName name)
        {
            if (name == ConfigDocumentName.Models) Interlocked.Increment(ref SyncReads);
            return inner.Read(name);
        }
        public Task<byte[]?> ReadAsync(ConfigDocumentName name, CancellationToken token)
        {
            if (name == ConfigDocumentName.Models) Interlocked.Increment(ref AsyncReads);
            return inner.ReadAsync(name, token);
        }
        public byte[]? ReadBounded(ConfigDocumentName name, int limit) => inner.ReadBounded(name, limit);
        public Task ReplaceAsync(ConfigDocumentName name, byte[] bytes, CancellationToken token, Action<AtomicJsonWriteStage>? stage = null) =>
            inner.ReplaceAsync(name, bytes, token, stage);
        public Task<bool> TryCreateAsync(ConfigDocumentName name, byte[] bytes, CancellationToken token) => inner.TryCreateAsync(name, bytes, token);
    }

    [Theory]
    [InlineData("route")]
    [InlineData("scoped-binding")]
    [InlineData("task")]
    [InlineData("task-facts")]
    [InlineData("notification")]
    public async Task ARequestOrNotificationReturnsToItsProducerWhileTheSingleSlotIsOccupied(string path)
    {
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        await using var host = await harness.StartAsync(PostgresServer.Tenant, maxInFlight: 1);
        await harness.InstallModelsAsync(host);
        var manager = host.Main.Sessions;
        var owner = await manager.CreateNamedAsync("main", "selected", null, null);
        var catalogRow = manager.Catalog.Get(owner.Id)!;
        var tenant = ((PostgresSessionAuthorityBackend)manager.Storage.Authority).Database;
        using var stopped = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        using var socket = new WebUiRealtimeRevisionTests.ProbeSocket();
        var subscriber = new WebUiRealtime(new SessionRuntime(manager)).RunAsync(socket, stopped.Token);
        socket.SetSubscriptions(1, null, [owner.Id]);
        while (!socket.Frames.Any(frame => frame["type"]?.ToString() == "subscriptions-applied"))
            await Task.Delay(5, stopped.Token);

        var config = new AccessConfiguration(ConfigurationYaml.Parse(
            "access: {identities: {viewer: {token: synthetic-viewer, surfaces: {webui: {sessions: [selected]}}}}}", "test config"));
        using var access = new WebUiAccess(new SessionRuntime(manager), config);
        access.Start();
        var trackedContext = new DefaultHttpContext();
        trackedContext.Request.Headers.Authorization = "Bearer synthetic-viewer";
        var scoped = access.Authenticate(trackedContext)!;
        scoped.Bind(owner.Id);
        using var tracking = access.Track(trackedContext, scoped);

        var app = host.Main.App;
        var endpoint = app.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Single(item => item.RoutePattern.RawText == "/api/sessions/{id}/pin");
        var context = new DefaultHttpContext { RequestServices = app.Services };
        context.SetEndpoint(endpoint);
        context.Request.RouteValues["id"] = owner.Id;
        context.Request.Method = "POST";
        context.Features.Get<IHttpRequestFeature>()!.RawTarget = $"/api/sessions/{owner.Id}/pin";
        context.Request.Body = new MemoryStream("{\"pinned\":true}"u8.ToArray());
        var task = (await manager.Tasks.ExecuteAsync(new JsonObject { ["action"] = "create", ["title"] = "owned", ["ownerSessionId"] = owner.Id }, owner.Id, anchor: 0)).Payload["task"]!;
        var args = new JsonObject { ["action"] = "get", ["taskId"] = task["id"]!.DeepClone() };
        var request = new ToolAuthorizationRequest("builtin", "task", null, args, [], owner.Agent, owner.Id, "master", host.Scratch, null, null);
        async Task CheckTaskFacts()
        {
            var operations = await manager.AuthorizationOperationsAsync(owner, new ResolvedTool("task", "builtin", "task", args), request);
            var op = Assert.Single(operations);
            Assert.True(op.TaskOwned);
            Assert.True(op.TaskCreated);
        }
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var holding = tenant.ReadAsync(async (_, _) => { entered.SetResult(); await release.Task; return true; });
        await entered.Task;
        Task Submit()
        {
            if (path == "scoped-binding")
            {
                manager.Catalog.NotifyIdentityChanged();
                return Task.CompletedTask;
            }
            if (path == "route")
                return endpoint.RequestDelegate!(context);
            if (path == "task-facts")
                return CheckTaskFacts();
            if (path == "task")
                return manager.Tasks.ExecuteForToolAsync(owner, new JsonObject { ["action"] = "list" });
            owner.PublishStateChanged(catalogRow);
            return Task.CompletedTask;
        }
        var priorFrames = socket.Frames.Count;
        var submitted = Task.Factory.StartNew(Submit, CancellationToken.None, TaskCreationOptions.None, TaskScheduler.Default);
        try
        {
            await submitted.WaitAsync(TimeSpan.FromSeconds(2));
            if (path is not ("notification" or "scoped-binding"))
                Assert.False(submitted.Result.IsCompleted);
        }
        finally
        {
            release.SetResult();
            await holding;
            try
            {
                await submitted.Unwrap().WaitAsync(stopped.Token);
                if (path == "notification")
                {
                    while (socket.Frames.Count < priorFrames + 2)
                        await Task.Delay(5, stopped.Token);
                    var frames = socket.Frames.Skip(priorFrames).Take(2).ToArray();
                    Assert.Equal("session-list-delta", frames[0]["type"]!.ToString());
                    Assert.Equal(owner.Id, frames[0]["sessions"]![0]!["id"]!.ToString());
                    Assert.Equal("session-list-invalidated", frames[1]["type"]!.ToString());
                }
            }
            finally
            {
                stopped.Cancel();
                try { await subscriber; } catch (OperationCanceledException) { }
            }
        }
        if (path == "route")
            Assert.True(manager.Catalog.Get(owner.Id)!["pinned"]!.GetValue<bool>());
    }

    [Fact]
    public async Task AFailedLiveListReadEndsTheSubscriberAndLeavesThePublisherUsable()
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "data");
        await using var manager = new SessionManager(root, Path.Combine(temp.Path, "work"), Options,
            HostModels.ForTest(Options), storage: HostedTestBackend.Create(root, maxInFlight: 1));
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "observed", null, null);
        var catalog = (PgSessionCatalog)manager.Catalog;
        var row = catalog.Get(owner.Id)!;
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        using var socket = new WebUiRealtimeRevisionTests.ProbeSocket();
        var subscriber = new WebUiRealtime(new SessionRuntime(manager)).RunAsync(socket, stop.Token);
        try
        {
            socket.SetSubscriptions(1, null, [owner.Id]);
            while (!socket.Frames.Any(frame => frame["type"]?.ToString() == "subscriptions-applied"))
                await Task.Delay(5, stop.Token);
            catalog.StatementObserved = (_, _) => throw new IOException("list row unavailable");
            owner.PublishStateChanged(row);
            await subscriber.WaitAsync(TimeSpan.FromSeconds(3));
        }
        finally
        {
            catalog.StatementObserved = null;
            stop.Cancel();
        }
        Assert.NotNull(catalog.Get(owner.Id));
    }

    [Fact]
    public async Task AChangedColdCanonicalIdDoesNotResolveAnAliasAfterItsWrite()
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "data");
        await using var manager = new SessionManager(root, Path.Combine(temp.Path, "work"), Options,
            HostModels.ForTest(Options), storage: HostedTestBackend.Create(root, maxInFlight: 1));
        await manager.LoadAsync();
        var catalog = (PgSessionCatalog)manager.Catalog;
        catalog.Upsert([SessionCatalogTests.Row("cold", 0)]);
        var afterCommit = new List<string>();
        try
        {
            await manager.ChangePresentationAsync(async store =>
            {
                var changed = await store.PinAsync("cold", true);
                catalog.StatementObserved = (sql, _) => afterCommit.Add(sql);
                return changed;
            });
        }
        finally
        {
            catalog.StatementObserved = null;
        }
        Assert.Empty(afterCommit);
        Assert.True(catalog.Get("cold")!["pinned"]!.GetValue<bool>());
    }

    [Fact]
    public async Task AnActorTaskReadDoesNotFetchAnAuthorityAnchor()
    {
        using var temp = new TempDirectory();
        using var service = new TaskService(null!, new TaskStore(new SqliteTaskRowStore(temp.Path), id => id, _ => []),
            id => Task.FromResult<string?>(id), _ => throw new InvalidOperationException("unexpected anchor read"),
            _ => Task.FromResult<string?>("main"));
        var result = await service.ExecuteAsync(new JsonObject { ["action"] = "list" }, "actor");
        Assert.Empty(result.Payload["tasks"]!.AsArray());
    }

    [Fact]
    public async Task QueuedCatalogAndTaskRequestsYieldWhileTheTenantStatementSlotIsBusy()
    {
        using var fixture = PostgresCatalogFixture.Open();
        var tenant = new TenantDb(fixture.Database.OpenApp(), fixture.Tenant.TenantId, fixture.Tenant.Epoch, maxInFlight: 1);
        var catalog = new PgSessionCatalog(tenant);
        using var tasks = new TaskStore(new PgTaskRowStore(tenant), id => id, _ => []);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var holder = tenant.ReadAsync(async (_, _) =>
        {
            entered.SetResult();
            await release.Task;
            return true;
        });
        await entered.Task;
        // The calls must return their pending tasks to this caller before the holder is released.
        // A synchronous wait (for either the statement slot or a preceding request's store gate)
        // would prevent it from scheduling the rest or signalling the holder.
        var submitted = Task.Run(() => Enumerable.Range(0, 10).SelectMany(index => new Task[]
        {
            catalog.QueryAsync(() => catalog.Count()),
            tasks.ExecuteAsync(new JsonObject { ["action"] = "list" }, null),
        }).ToArray());
        Task[] requests;
        try
        {
            requests = await submitted.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.All(requests, task => Assert.False(task.IsCompleted));
            Assert.Equal(1, tenant.InFlight);
        }
        finally
        {
            release.SetResult();
            await holder;
        }
        await Task.WhenAll(requests).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(0, tenant.InFlight);
    }
}
