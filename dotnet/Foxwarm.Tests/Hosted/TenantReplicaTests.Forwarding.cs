using System.Net;
using System.Net.WebSockets;
using Foxwarm.Hosted.Forwarding;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Runtimes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Foxwarm.Tests.Hosted;

public sealed partial class TenantReplicaTests
{
    private static void MapForwardingRoutes(WebApplication app, Fixture fixture)
    {
        app.Map("/wire", async (HttpContext c) =>
        {
            Interlocked.Increment(ref fixture.ApplicationCalls);
            var h = c.Request.Headers;
            if (h.ContainsKey("Forwarded") || h.ContainsKey("X-Forwarded-Host") || h.ContainsKey("Foxwarm-Mesh"))
                throw new InvalidOperationException("The edge leaked a control header.");
            await c.Response.WriteAsync(string.Join("|", c.Request.Host.Value, c.Features.Get<IHttpRequestFeature>()!.RawTarget,
                h.Authorization.ToString(), h.Cookie.ToString(), await new StreamReader(c.Request.Body).ReadToEndAsync()));
        });
        app.MapGet("/application-421", (HttpContext c) =>
        {
            Interlocked.Increment(ref fixture.ApplicationCalls);
            c.Response.Headers["Foxwarm-Mesh-Refusal"] = "application";
            return Results.StatusCode(421);
        });
        app.MapGet("/slow", async (HttpContext c) =>
        {
            fixture.Connections.Add(c.Connection.Id);
            fixture.Entered.TrySetResult();
            await fixture.Continue.Task.WaitAsync(c.RequestAborted);
            await c.Response.WriteAsync("finished");
        });
        app.MapGet("/truncate", async (HttpContext c) =>
        {
            fixture.Connections.Add(c.Connection.Id);
            Interlocked.Increment(ref fixture.ApplicationCalls);
            c.Response.ContentLength = 100;
            await c.Response.WriteAsync("partial");
            await c.Response.Body.FlushAsync();
            fixture.Truncating.TrySetResult();
            await fixture.Cut.Task.WaitAsync(c.RequestAborted);
            c.Features.Get<IHttpResetFeature>()!.Reset(8);
        });
        app.UseWebSockets();
        app.Map("/socket", async (HttpContext c) =>
        {
            using var socket = await c.WebSockets.AcceptWebSocketAsync("tenant");
            Interlocked.Increment(ref fixture.ApplicationCalls);
            if (c.Request.Query.ContainsKey("owner"))
            {
                await socket.SendAsync("owner final"u8.ToArray(), WebSocketMessageType.Text, true, c.RequestAborted);
                await socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, "pair again", c.RequestAborted);
            }
            else if (c.Request.Query.ContainsKey("loss"))
            {
                await socket.SendAsync("last"u8.ToArray(), WebSocketMessageType.Text, true, c.RequestAborted);
                await fixture.Cut.Task.WaitAsync(c.RequestAborted);
                c.Features.Get<IHttpResetFeature>()!.Reset(8);
            }
            else
            {
                var data = new byte[32];
                var final = await socket.ReceiveAsync(new ArraySegment<byte>(data), c.RequestAborted);
                fixture.Event(System.Text.Encoding.UTF8.GetString(data, 0, final.Count));
                var close = await socket.ReceiveAsync(new ArraySegment<byte>(data), c.RequestAborted);
                await socket.CloseOutputAsync(close.CloseStatus!.Value, close.CloseStatusDescription, c.RequestAborted);
            }
        });
    }

    [Fact]
    public async Task ARemoteOwnerGetsTheOriginalRequestExactlyOnceAndOnlyTheOwnerSeesItsCredentials()
    {
        await using var owner = await StartAsync("alpha");
        await owner.WhoAmIAsync("alpha");
        await using var edge = await StartReplicaAsync(owner.Database, "replica-b", owner.MeshKey);
        const string path = "/wire?q=a%2Fb&q=b%2Bc";
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{edge.Replica.FrontPort}{path}");
        request.Headers.Host = "Alpha.test:8443";
        request.Headers.TryAddWithoutValidation("Authorization", "Bearer alpha-key");
        request.Headers.TryAddWithoutValidation("Cookie", "session=alpha");
        request.Headers.TryAddWithoutValidation("Foxwarm-Mesh", "from-public-client");
        request.Headers.TryAddWithoutValidation("X-Forwarded-Host", "beta.test");
        request.Headers.TryAddWithoutValidation("Forwarded", "host=beta.test");
        request.Content = new StringContent("one body");
        using var response = await edge.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal($"Alpha.test:8443|{path}|Bearer alpha-key|session=alpha|one body", await response.Content.ReadAsStringAsync());
        using var final = await edge.GetAsync("alpha", "/application-421");
        Assert.Equal(HttpStatusCode.MisdirectedRequest, final.StatusCode);
        Assert.False(final.Headers.Contains("Foxwarm-Mesh-Refusal"));
        Assert.Equal(2, owner.ApplicationCalls);
        Assert.Equal(0, edge.Builds);
    }

    [Fact]
    public async Task DisconnectedFrontWaiterDoesNotCancelTheSharedColdStart()
    {
        await using var owner = await StartAsync("alpha");
        owner.StartGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        using var stop = new CancellationTokenSource();
        using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{owner.Replica.FrontPort}/whoami");
        request.Headers.Host = "alpha.test";
        var disconnected = owner.Client.SendAsync(request, stop.Token);
        await UntilAsync(() => owner.EventList().Contains("alpha:start-waits"), "cold start reached its barrier");
        var remaining = owner.WhoAmIAsync("alpha");
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => disconnected);
        owner.StartGate.SetResult();
        Assert.StartsWith("alpha:", await remaining);
        Assert.Equal(1, owner.Builds);
    }

    [Fact]
    public async Task AutonomousClaimRespectsRankGraceWithoutLooseningEligibility()
    {
        const string slug = "alpha";
        await using var cluster = await StartAsync(slug);
        var database = cluster.Database.OpenApp();
        var registry = new ReplicaRegistry(database);
        var second = Enumerable.Range(0, 100).Select(i => "other-" + i)
            .First(name => Placement.Score(slug, name) > Placement.Score(slug, "replica-a"));
        await registry.RegisterAsync(second + "/1", null, 1, 2, default);
        var local = cluster.Replica.Replica;
        var capacity = true;
        using var router = new TenantRouter(local, new MeshAuthentication(cluster.MeshKey, local), new RouteDirectory(database),
            registry, cluster.Replica.Activations!, new HostnameDirectory(database), Fast,
            (_, _) => throw new NotSupportedException(), () => capacity, _ => { });
        Assert.False(await router.MayStartAutonomousAsync(slug, false, default));
        Assert.True(await router.MayStartAutonomousAsync(slug, true, default));
        capacity = false;
        Assert.False(await router.MayStartAutonomousAsync(slug, true, default));
        capacity = true;
        await registry.RemoveAsync(second + "/1", default);
        Assert.True(await router.MayStartAutonomousAsync(slug, false, default));
        await cluster.Database.ExecuteOwnerAsync("UPDATE tenants SET pinned_role='master-host' WHERE name='alpha'");
        Assert.False(await router.MayStartAutonomousAsync(slug, true, default));
        await cluster.Database.ExecuteOwnerAsync("UPDATE tenants SET pinned_role=NULL WHERE name='alpha'");
        await cluster.Database.TakeLeaseAsync(await cluster.Database.TenantIdAsync(slug), "elsewhere/1");
        Assert.False(await router.MayStartAutonomousAsync(slug, true, default));
        await cluster.Database.ExecuteOwnerAsync("UPDATE tenant_leases SET state='released' WHERE owner_replica='elsewhere/1'");
        Assert.True(await router.MayStartAutonomousAsync(slug, true, default));
        router.Drain();
        Assert.False(await router.MayStartAutonomousAsync(slug, true, default));
    }

    [Fact]
    public async Task AStalledFirstCandidateDoesNotSpendTheWholeHoldOrForwardTheApplication()
    {
        const string slug = "alpha";
        await using var edge = await StartAsync(slug);
        var competitor = Enumerable.Range(0, 100).Select(i => "other-" + i)
            .First(name => Placement.Score(slug, name) > Placement.Score(slug, "replica-a"));
        var boot = competitor + "/first";
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel(server => server.Listen(IPAddress.Loopback, 0, endpoint => endpoint.Protocols = HttpProtocols.Http2));
        await using var first = builder.Build();
        var auth = new MeshAuthentication(edge.MeshKey, boot);
        var seen = new System.Collections.Concurrent.ConcurrentBag<MeshAttempt>();
        first.Run(async context =>
        {
            if (auth.Accept(context.Request) is { } attempt) seen.Add(attempt);
            await Task.Delay(Timeout.Infinite, context.RequestAborted);
        });
        await first.StartAsync();
        await new ReplicaRegistry(edge.Database.OpenApp()).RegisterAsync(boot, null, 1, 2, default, meshAddress: first.Urls.Single());
        Assert.StartsWith("alpha:", await edge.WhoAmIAsync(slug));
        Assert.Equal("activate", Assert.Single(seen).Purpose);
        Assert.Equal(edge.Replica.Replica, await edge.OwnerAsync(slug));
        Assert.Equal(1, edge.Builds);
    }

    [Theory]
    [InlineData(100, true)]
    [InlineData(65537, false)]
    public async Task AControlRefusalRetriesOnlyAnUploadTheEdgeCanStillSend(int length, bool retried)
    {
        await using var owner = await StartAsync("alpha");
        await owner.WhoAmIAsync("alpha");
        await using var edge = await StartReplicaAsync(owner.Database, "replica-b", owner.MeshKey);
        var boot = owner.Replica.Replica;
        var original = (string)(await owner.Database.ScalarAsync("SELECT mesh_address FROM replicas WHERE replica_id=$1", boot))!;
        var signer = new MeshAuthentication(owner.MeshKey, boot);
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel(server => server.Listen(IPAddress.Loopback, 0, endpoint => endpoint.Protocols = HttpProtocols.Http2));
        await using var peer = builder.Build();
        var declines = 0;
        peer.Run(async c =>
        {
            var attempt = signer.Accept(c.Request)!;
            // Simulate all bytes reaching the stale receiver before its admission check.
            // The tenant application still sees none of those bytes.
            await c.Request.Body.CopyToAsync(Stream.Null);
            await owner.Database.ScalarAsync("UPDATE replicas SET mesh_address=$1 WHERE replica_id=$2", original, boot);
            Interlocked.Increment(ref declines);
            c.Response.StatusCode = 421;
            c.Response.Headers[MeshAuthentication.Refusal] = signer.Refuse(attempt);
        });
        await peer.StartAsync();
        await owner.Database.ScalarAsync("UPDATE replicas SET mesh_address=$1 WHERE replica_id=$2", peer.Urls.Single(), boot);
        using var post = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{edge.Replica.FrontPort}/wire");
        post.Headers.Host = "alpha.test";
        post.Headers.TransferEncodingChunked = true;
        var data = new string('x', length);
        post.Content = new StringContent(data);
        using var result = await edge.Client.SendAsync(post);
        Assert.Equal(1, declines);
        Assert.Equal(retried ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable, result.StatusCode);
        if (retried) Assert.EndsWith("|" + data, await result.Content.ReadAsStringAsync());
        Assert.Equal(retried ? 1 : 0, owner.ApplicationCalls);
    }

    [Fact]
    public async Task ARemoteSlowResponseOutlivesTheHoldWithoutReceivingHeaders()
    {
        await using var owner = await StartAsync("alpha");
        await owner.WhoAmIAsync("alpha");
        await using var edge = await StartReplicaAsync(owner.Database, "replica-b", owner.MeshKey);
        var response = edge.GetAsync("alpha", "/slow");
        await owner.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(Fast.Ttl + TimeSpan.FromMilliseconds(200));
        Assert.False(response.IsCompleted);
        owner.Continue.SetResult();
        using var finished = await response;
        Assert.Equal("finished", await finished.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task ATruncatedResponseRemainsTruncatedAndTheSiblingMeshStreamFinishes()
    {
        await using var owner = await StartAsync("alpha");
        await owner.WhoAmIAsync("alpha");
        await using var edge = await StartReplicaAsync(owner.Database, "replica-b", owner.MeshKey);
        var slow = edge.GetAsync("alpha", "/slow");
        await owner.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{edge.Replica.FrontPort}/truncate");
        request.Headers.Host = "alpha.test";
        var getting = edge.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        await owner.Truncating.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var response = await getting.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var stream = await response.Content.ReadAsStreamAsync();
        var prefix = new byte[7];
        await stream.ReadExactlyAsync(prefix);
        Assert.Equal("partial", System.Text.Encoding.UTF8.GetString(prefix));
        owner.Cut.SetResult();
        await Assert.ThrowsAnyAsync<IOException>(async () => await stream.CopyToAsync(Stream.Null));
        owner.Continue.SetResult();
        using var finished = await slow;
        Assert.Equal("finished", await finished.Content.ReadAsStringAsync());
        Assert.Equal(1, owner.ApplicationCalls);
        Assert.Equal(2, owner.Connections.Count);
        Assert.Single(owner.Connections.Distinct());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AWebSocketCrossesTheMeshWithItsCloseStatusAndReason(bool ownerCloses)
    {
        await using var owner = await StartAsync("alpha");
        await owner.WhoAmIAsync("alpha");
        await using var edge = await StartReplicaAsync(owner.Database, "replica-b", owner.MeshKey);
        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Host", "alpha.test");
        socket.Options.AddSubProtocol("tenant");
        using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var uri = new Uri($"ws://127.0.0.1:{edge.Replica.FrontPort}/socket" + (ownerCloses ? "?owner" : ""));
        await socket.ConnectAsync(uri, bound.Token);
        Assert.Equal("tenant", socket.SubProtocol);
        var status = ownerCloses ? WebSocketCloseStatus.PolicyViolation : WebSocketCloseStatus.NormalClosure;
        var reason = ownerCloses ? "pair again" : "client done";
        if (ownerCloses)
        {
            var data = new byte[32];
            var final = await socket.ReceiveAsync(new ArraySegment<byte>(data), bound.Token);
            Assert.Equal(WebSocketMessageType.Text, final.MessageType);
            Assert.Equal("owner final", System.Text.Encoding.UTF8.GetString(data, 0, final.Count));
        }
        else
        {
            await socket.SendAsync("client final"u8.ToArray(), WebSocketMessageType.Text, true, bound.Token);
            await socket.CloseOutputAsync(status, reason, bound.Token);
        }
        var close = await socket.ReceiveAsync(new ArraySegment<byte>(new byte[32]), bound.Token);
        Assert.Equal(WebSocketMessageType.Close, close.MessageType);
        Assert.Equal(status, close.CloseStatus);
        Assert.Equal(reason, close.CloseStatusDescription);
        if (!ownerCloses) Assert.Contains("client final", owner.EventList());
    }

    [Fact]
    public async Task AbruptWebSocketLossEndsOnlyItsStreamWithoutReconnecting()
    {
        await using var owner = await StartAsync("alpha");
        await owner.WhoAmIAsync("alpha");
        await using var edge = await StartReplicaAsync(owner.Database, "replica-b", owner.MeshKey);
        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Host", "alpha.test");
        socket.Options.AddSubProtocol("tenant");
        using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{edge.Replica.FrontPort}/socket?loss"), bound.Token);
        var read = new ArraySegment<byte>(new byte[32]);
        Assert.Equal(WebSocketMessageType.Text, (await socket.ReceiveAsync(read, bound.Token)).MessageType);
        var sibling = edge.GetAsync("alpha", "/slow");
        await owner.Entered.Task.WaitAsync(bound.Token);
        owner.Cut.SetResult();
        await Assert.ThrowsAnyAsync<WebSocketException>(() => socket.ReceiveAsync(read, bound.Token));
        owner.Continue.SetResult();
        using var ordinary = await sibling;
        Assert.Equal("finished", await ordinary.Content.ReadAsStringAsync());
        Assert.Equal(1, owner.ApplicationCalls);
    }

}
