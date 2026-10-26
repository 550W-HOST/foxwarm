using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ShellHttpTests
{
    private static async Task<(string Connection, string Predecessor)> PrepareShell(Fixture fixture)
    {
        using var request = new HttpRequestMessage(HttpMethod.Head, "/node/shell/register");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", fixture.Auth);
        request.Headers.Add("X-Foxwarm-Node", "shell");
        using var response = await fixture.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        return (
            response.Headers.GetValues("X-Foxwarm-Connection").Single(),
            response.Headers.GetValues("X-Foxwarm-Predecessor").Single()
        );
    }

    private static Task<HttpResponseMessage> ConditionalShell(
        Fixture fixture,
        string connection,
        string predecessor
    ) =>
        fixture.Request(
            "register",
            Encoding.UTF8.GetBytes("/startup"),
            new() { ["X-Foxwarm-Predecessor"] = predecessor },
            connection: connection
        );

    [Fact]
    public async Task Conditional_registration_retries_preserve_queued_and_delivered_tasks_and_fence_successors()
    {
        await using var fixture = new Fixture();
        await fixture.Start(register: false);
        var prepared = await PrepareShell(fixture);
        Assert.Equal("none", prepared.Predecessor);
        using var registered = await ConditionalShell(
            fixture,
            prepared.Connection,
            prepared.Predecessor
        );
        Assert.Equal(HttpStatusCode.NoContent, registered.StatusCode);
        fixture.Connection = prepared.Connection;
        var execution = fixture.Exec();
        // The original success response can be lost: the repeated POST acknowledges the same queue.
        using var retry = await ConditionalShell(
            fixture,
            prepared.Connection,
            prepared.Predecessor
        );
        Assert.Equal(HttpStatusCode.NoContent, retry.StatusCode);
        using var reconnectRetry = await ConditionalShell(
            fixture,
            prepared.Connection,
            prepared.Connection
        );
        Assert.Equal(HttpStatusCode.NoContent, reconnectRetry.StatusCode);
        var task = await fixture.Poll();
        using var running = await fixture.Report(task.Task);
        Assert.Equal(HttpStatusCode.NoContent, running.StatusCode);
        await execution;
        await fixture.Register(); // Deliberate legacy/new client takeover remains supported.
        using var old = await fixture.Request("poll", connection: prepared.Connection);
        Assert.Equal(
            "connection-replaced",
            old.Headers.GetValues("X-Foxwarm-Shell-Reason").Single()
        );
        using var stale = await ConditionalShell(fixture, prepared.Connection, prepared.Connection);
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        using var staleInitialRetry = await ConditionalShell(
            fixture,
            prepared.Connection,
            prepared.Predecessor
        );
        Assert.Equal(HttpStatusCode.Conflict, staleInitialRetry.StatusCode);
        using var finished = await fixture.Report(
            task.Task,
            true,
            Encoding.UTF8.GetBytes("once"),
            connection: prepared.Connection
        );
        Assert.Equal(HttpStatusCode.NoContent, finished.StatusCode);
        Assert.Single(fixture.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Prepare_is_read_only_and_a_successor_between_prepare_and_publish_wins()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var registryPath = Path.Combine(fixture.Data, "state", "nodes.json");
        var registry = await File.ReadAllTextAsync(registryPath);
        var prepared = await PrepareShell(fixture);
        Assert.NotEqual("none", prepared.Predecessor);
        Assert.Equal(registry, await File.ReadAllTextAsync(registryPath));
        var original = fixture.Connection;
        await fixture.Restart();
        using var recovered = await ConditionalShell(fixture, original, original);
        Assert.Equal(HttpStatusCode.NoContent, recovered.StatusCode);
        using var lostRace = await ConditionalShell(
            fixture,
            prepared.Connection,
            prepared.Predecessor
        );
        Assert.Equal(HttpStatusCode.Conflict, lostRace.StatusCode);
        Assert.NotEqual(prepared.Predecessor, (await PrepareShell(fixture)).Predecessor);
        fixture.Manager.Nodes.Remove("shell");
        using var revoked = await ConditionalShell(fixture, fixture.Connection, fixture.Connection);
        Assert.Equal(HttpStatusCode.Unauthorized, revoked.StatusCode);
        Assert.Equal(
            "credentials-rejected",
            revoked.Headers.GetValues("X-Foxwarm-Shell-Reason").Single()
        );
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task An_abandoned_failed_registration_leaves_the_original_client_recoverable(
        bool legacy,
        bool committed
    )
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var original = fixture.Connection;
        var prepared = await PrepareShell(fixture);
        ObserveRegistryWrite(
            fixture.Manager.Nodes,
            stage =>
            {
                if (
                    stage
                    == (
                        committed
                            ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                            : AtomicJsonWriteStage.BeforeRename
                    )
                )
                    throw new IOException("Injected registration persistence failure.");
            }
        );
        try
        {
            using var failed = legacy
                ? await fixture.Request("register", Encoding.UTF8.GetBytes("/abandoned"))
                : await ConditionalShell(fixture, prepared.Connection, prepared.Predecessor);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, failed.StatusCode);
        }
        finally
        {
            ObserveRegistryWrite(fixture.Manager.Nodes, null);
        }
        // B is abandoned without retry. A still receives and reports a real dispatch.
        Assert.Equal(prepared.Predecessor, (await PrepareShell(fixture)).Predecessor);
        var execution = fixture.Exec();
        var task = await fixture.Poll();
        using var finished = await fixture.Report(task.Task, true);
        Assert.Equal(HttpStatusCode.NoContent, finished.StatusCode);
        await execution;
        await fixture.Restart();
        using var missing = await fixture.Request("poll", connection: original);
        Assert.Equal(HttpStatusCode.Conflict, missing.StatusCode);
        Assert.Equal(
            "connection-unavailable",
            missing.Headers.GetValues("X-Foxwarm-Shell-Reason").Single()
        );
        using var recovery = await ConditionalShell(fixture, original, original);
        Assert.Equal(HttpStatusCode.NoContent, recovery.StatusCode);
        Assert.NotEqual("none", (await PrepareShell(fixture)).Predecessor);
        Assert.True(fixture.Manager.Nodes.Online("shell"));
    }

    [Fact]
    public async Task An_outstanding_poll_conflict_is_distinct_from_replacement_and_does_not_replace_it()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var first = fixture.Request("poll");
        // An actual pending HTTP request, completed by a dispatch below, rather than a fabricated queue.
        await Task.Delay(100);
        using var duplicate = await fixture.Request("poll");
        Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
        Assert.Equal(
            "poll-pending",
            duplicate.Headers.GetValues("X-Foxwarm-Shell-Reason").Single()
        );
        var execution = fixture.Exec();
        using var delivered = await first;
        Assert.Equal(HttpStatusCode.OK, delivered.StatusCode);
        using var finished = await fixture.Report(
            delivered.Headers.GetValues("X-Foxwarm-Task").Single(),
            true
        );
        await execution;
    }
}
