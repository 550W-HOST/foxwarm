using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
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
        return (response.Headers.GetValues("X-Foxwarm-Connection").Single(), response.Headers.GetValues("X-Foxwarm-Predecessor").Single());
    }

    private static Task<HttpResponseMessage> ConditionalShell(Fixture fixture, string connection, string predecessor) =>
        fixture.Request("register", Encoding.UTF8.GetBytes("/startup"),
            new() { ["X-Foxwarm-Predecessor"] = predecessor }, connection: connection);

    [Fact]
    public async Task Conditional_registration_retries_preserve_queued_and_delivered_tasks_and_fence_successors()
    {
        await using var fixture = new Fixture();
        await fixture.Start(register: false);
        var prepared = await PrepareShell(fixture);
        Assert.Equal("none", prepared.Predecessor);
        using var registered = await ConditionalShell(fixture, prepared.Connection, prepared.Predecessor);
        Assert.Equal(HttpStatusCode.NoContent, registered.StatusCode);
        fixture.Connection = prepared.Connection;
        var execution = fixture.Exec();
        // The original success response can be lost: the repeated POST acknowledges the same queue.
        using var retry = await ConditionalShell(fixture, prepared.Connection, prepared.Predecessor);
        Assert.Equal(HttpStatusCode.NoContent, retry.StatusCode);
        var task = await fixture.Poll();
        using var running = await fixture.Report(task.Task);
        Assert.Equal(HttpStatusCode.NoContent, running.StatusCode);
        await execution;
        await fixture.Register(); // Deliberate legacy/new client takeover remains supported.
        using var old = await fixture.Request("poll", connection: prepared.Connection);
        Assert.Equal("connection-replaced", old.Headers.GetValues("X-Foxwarm-Shell-Reason").Single());
        using var stale = await ConditionalShell(fixture, prepared.Connection, prepared.Connection);
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        using var staleInitialRetry = await ConditionalShell(fixture, prepared.Connection, prepared.Predecessor);
        Assert.Equal(HttpStatusCode.Conflict, staleInitialRetry.StatusCode);
        using var finished = await fixture.Report(task.Task, true, Encoding.UTF8.GetBytes("once"), connection: prepared.Connection);
        Assert.Equal(HttpStatusCode.NoContent, finished.StatusCode);
        Assert.Single(fixture.Owner.Entry.Snapshot().Queue);
        // Removal of a successor runtime must not erase its publication fence.
        fixture.Manager.Nodes.Disconnect("shell", "qualification end");
        using var staleAfterDisconnect = await ConditionalShell(fixture, prepared.Connection, prepared.Connection);
        Assert.Equal(HttpStatusCode.Conflict, staleAfterDisconnect.StatusCode);
        Assert.DoesNotContain("connectionGeneration", fixture.Manager.Nodes.List().ToJsonString());
        Assert.Equal(fixture.Connection, new ApprovedNodeRegistry(fixture.Data).Publication("shell", fixture.Auth));
    }

    [Fact]
    public async Task Prepare_is_read_only_and_a_successor_between_prepare_and_publish_wins()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var prepared = await PrepareShell(fixture);
        Assert.Equal(fixture.Connection, prepared.Predecessor);
        Assert.Equal(fixture.Connection, fixture.Manager.Nodes.Registry.Publication("shell", fixture.Auth));
        await fixture.Register();
        using var lostRace = await ConditionalShell(fixture, prepared.Connection, prepared.Predecessor);
        Assert.Equal(HttpStatusCode.Conflict, lostRace.StatusCode);
        Assert.Equal(fixture.Connection, fixture.Manager.Nodes.Registry.Publication("shell", fixture.Auth));
        fixture.Manager.Nodes.Remove("shell");
        using var revoked = await ConditionalShell(fixture, fixture.Connection, fixture.Connection);
        Assert.Equal(HttpStatusCode.Unauthorized, revoked.StatusCode);
        Assert.Equal("credentials-rejected", revoked.Headers.GetValues("X-Foxwarm-Shell-Reason").Single());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Conditional_registration_retries_both_precommit_and_committed_persistence_failures(bool committed)
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var prepared = await PrepareShell(fixture);
        ObserveRegistryWrite(fixture.Manager.Nodes, stage =>
        {
            if (stage == (committed ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync : AtomicJsonWriteStage.BeforeRename))
                throw new IOException("Injected registration persistence failure.");
        });
        try
        {
            using var failed = await ConditionalShell(fixture, prepared.Connection, prepared.Predecessor);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, failed.StatusCode);
        }
        finally { ObserveRegistryWrite(fixture.Manager.Nodes, null); }
        using var retry = await ConditionalShell(fixture, prepared.Connection, prepared.Predecessor);
        Assert.Equal(HttpStatusCode.NoContent, retry.StatusCode);
        Assert.Equal(prepared.Connection, fixture.Manager.Nodes.Registry.Publication("shell", fixture.Auth));
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
        Assert.Equal("poll-pending", duplicate.Headers.GetValues("X-Foxwarm-Shell-Reason").Single());
        var execution = fixture.Exec();
        using var delivered = await first;
        Assert.Equal(HttpStatusCode.OK, delivered.StatusCode);
        using var finished = await fixture.Report(delivered.Headers.GetValues("X-Foxwarm-Task").Single(), true);
        await execution;
    }
}
