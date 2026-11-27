using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
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

    [Fact]
    public async Task ABurstOfPresentationChangesCompletesOnACappedPool()
    {
        using var temp = new TempDirectory();
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            Options,
            HostModels.ForTest(Options),
            storage: HostedTestBackend.Create(Path.Combine(temp.Path, "data"))
        );
        await manager.LoadAsync();
        var parent = await manager.CreateNamedAsync("main", "parent", null, null);
        var child = await manager.CreateNamedAsync("main", "child", null, null);
        await WithCappedPoolAsync(() =>
            SessionIdentityInterleavingTests.ExerciseConcurrentParentChangesAsync(manager, parent, child));

        // The WebUI list projection reads catalog rows and archive counts in the same request.
        var list = new SessionListQueries(new SessionRuntime(manager));
        var page = await list.ExactAsync([parent.Id, child.Id], true);
        Assert.Equal(2, page["results"]!.AsArray().Count);
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
