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
            c.Response.Headers["X-Test-Body-Limit"] = c.Features.Get<IHttpMaxRequestBodySizeFeature>()?.MaxRequestBodySize?.ToString() ?? "none";
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
            if (c.Request.Query.ContainsKey("transport"))
            {
                await fixture.Continue.Task.WaitAsync(c.RequestAborted);
                await socket.SendAsync("final"u8.ToArray(), WebSocketMessageType.Text, true, c.RequestAborted);
                try { await socket.ReceiveAsync(new ArraySegment<byte>(new byte[32]), c.RequestAborted); }
                catch (Exception error) when (error is WebSocketException or OperationCanceledException) { }
                finally { fixture.Entered.TrySetResult(); }
                return;
            }
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
    public async Task AReplayBufferHeldPastResponseHeadersIsChargedToItsTenant()
    {
        await using var owner = await StartAsync("alpha", "beta");
        owner.AddRoutes = app => app.MapPost("/stream-reply", async context =>
        {
            await context.Response.WriteAsync("begin");
            await context.Response.Body.FlushAsync();
            await owner.Continue.Task.WaitAsync(context.RequestAborted);
        });
        await owner.WhoAmIAsync("alpha");
        await owner.WhoAmIAsync("beta");
        await using var edge = await StartReplicaAsync(owner.Database, "replica-b", owner.MeshKey, tenantHolds: 1);
        async Task<HttpResponseMessage> Post(string tenant, string path)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{edge.Replica.FrontPort}" + path);
            request.Headers.Host = tenant + ".test";
            request.Content = new StringContent("body");
            return await edge.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        }
        using var streaming = await Post("alpha", "/stream-reply");
        try
        {
            streaming.EnsureSuccessStatusCode();
            using var second = await Post("alpha", "/wire");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, second.StatusCode);
            using var neighbour = await Post("beta", "/wire");
            neighbour.EnsureSuccessStatusCode();
        }
        finally { owner.Continue.TrySetResult(); }
    }

    [Fact]
    public async Task CachedHostnameCanDispatchWhileTheUnresolvedShareIsOccupied()
    {
        await using var cluster = await StartAsync("alpha");
        await cluster.WhoAmIAsync("alpha");
        var database = cluster.Database.OpenApp();
        var hosts = new HostnameDirectory(database);
        await hosts.RefreshAsync(default);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        hosts.AfterQuery = async () => { entered.TrySetResult(); await release.Task; };
        var boot = cluster.Replica.Replica;
        using var router = new TenantRouter(boot, new MeshAuthentication(cluster.MeshKey, boot), new RouteDirectory(database),
            new ReplicaRegistry(database), cluster.Replica.Activations!, hosts, LeaseTimings.Default,
            (_, c) => { c.Response.StatusCode = 204; return Task.CompletedTask; }, () => true, _ => {}, default, tenantHoldLimit: 1);
        async Task<int> Get(string host)
        {
            var context = new DefaultHttpContext();
            context.Request.Host = new HostString(host);
            await router.PublicAsync(context, null!); // Exact local owner; no mesh forwarding.
            return context.Response.StatusCode;
        }
        var miss = Get("missing.test");
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal(503, await Get("other-miss.test").WaitAsync(TimeSpan.FromSeconds(3)));
            Assert.Equal(204, await Get("alpha.test").WaitAsync(TimeSpan.FromSeconds(3)));
        }
        finally { release.SetResult(); }
        Assert.Equal(404, await miss);
    }

    [Fact]
    public async Task WaitingForRemoteHeadersLeavesCapacityForAnotherTenant()
    {
        await using var owner = await StartAsync("alpha", "beta");
        await owner.WhoAmIAsync("alpha");
        await owner.WhoAmIAsync("beta");
        await using var edge = await StartReplicaAsync(owner.Database, "replica-b", owner.MeshKey, tenantHolds: 1);
        var slow = edge.GetAsync("alpha", "/slow");
        try
        {
            await owner.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            using var denied = await edge.GetAsync("alpha");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, denied.StatusCode);
            Assert.StartsWith("beta:", await edge.WhoAmIAsync("beta"));
        }
        finally { owner.Continue.TrySetResult(); (await slow).Dispose(); }
        Assert.StartsWith("alpha:", await edge.WhoAmIAsync("alpha"));
    }

    [Fact]
    public async Task RemoteNodeFileTransferStreamsPastTheFrontDefaultToTheRealTransferRoute()
    {
        await using var nodes = new NodeFileTransferTests.Fixture();
        await nodes.Start();
        await using var owner = await StartAsync("alpha");
        owner.AddRoutes = nodes.Manager.Nodes.RegisterFileStreamRoutes;
        await owner.WhoAmIAsync("alpha");
        await using var edge = await StartReplicaAsync(owner.Database, "replica-b", owner.MeshKey);
        var credentials = nodes.Manager.Nodes.Registry.Create("source");
        var socket = await nodes.Connect("source", credentials, streaming: true);
        var pending = nodes.Manager.Nodes.OpenReadStreamAsync("source", "large.bin", nodes.Owner, false, default);
        var call = await NodeFileTransferTests.Fixture.Read(socket);
        var payload = new byte[3 * 1024 * 1024];
        payload[^1] = 57;
        using var request = new HttpRequestMessage(HttpMethod.Put,
            $"http://127.0.0.1:{edge.Replica.FrontPort}/node/transfer/{call["transferId"]}");
        request.Headers.Host = "alpha.test";
        request.Headers.Add("X-Foxwarm-Node", "source");
        request.Headers.Authorization = new("Bearer", credentials["authToken"]!.ToString());
        request.Content = new ByteArrayContent(payload);
        var uploading = edge.Client.SendAsync(request);
        await using var transfer = await pending.WaitAsync(TimeSpan.FromSeconds(10));
        using var actual = new MemoryStream();
        await transfer.Stream.CopyToAsync(actual);
        Assert.Equal(payload, actual.ToArray());
        using var result = await uploading;
        Assert.Equal(HttpStatusCode.OK, result.StatusCode);
    }

    [Fact]
    public async Task ARemoteOwnerGetsTheOriginalRequestExactlyOnceAndOnlyTheOwnerSeesItsCredentials()
    {
        await using var owner = await StartAsync("alpha");
        await owner.WhoAmIAsync("alpha");
        await using var edge = await StartReplicaAsync(owner.Database, "replica-b", owner.MeshKey);
        const string path = "/wire?q=a%2Fb&q=b%2Bc";
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{edge.Replica.FrontPort}{path}");
        request.Headers.Host = "Alpha.test.:8443";
        request.Headers.TryAddWithoutValidation("Authorization", "Bearer alpha-key");
        request.Headers.TryAddWithoutValidation("Cookie", "session=alpha");
        request.Headers.TryAddWithoutValidation("Foxwarm-Mesh", "from-public-client");
        request.Headers.TryAddWithoutValidation("X-Forwarded-Host", "beta.test");
        request.Headers.TryAddWithoutValidation("Forwarded", "host=beta.test");
        request.Content = new StringContent("one body");
        using var response = await edge.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal($"Alpha.test.:8443|{path}|Bearer alpha-key|session=alpha|one body", await response.Content.ReadAsStringAsync());
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
        await registry.RegisterAsync(second + "/1", null, 1, 2, default, meshAddress: "127.0.0.1:1");
        var local = cluster.Replica.Replica;
        var capacity = true;
        using var stopping = new CancellationTokenSource();
        using var router = new TenantRouter(local, new MeshAuthentication(cluster.MeshKey, local), new RouteDirectory(database),
            registry, cluster.Replica.Activations!, new HostnameDirectory(database), Fast,
            (_, _) => throw new NotSupportedException(), () => capacity, _ => { }, stopping.Token);
        Assert.False(await router.MayStartAutonomousAsync(slug, false, default));
        Assert.True(await router.MayStartAutonomousAsync(slug, true, default));
        capacity = false;
        Assert.False(await router.MayStartAutonomousAsync(slug, true, default));
        capacity = true;
        await registry.RemoveAsync(second + "/1", default);
        Assert.True(await router.MayStartAutonomousAsync(slug, false, default));
        await cluster.Database.ExecuteOwnerAsync("UPDATE tenants SET profile='operator', pinned_role='master-host' WHERE name='alpha'");
        Assert.False(await router.MayStartAutonomousAsync(slug, true, default));
        await cluster.Database.ExecuteOwnerAsync("UPDATE tenants SET profile='hosted', pinned_role=NULL WHERE name='alpha'");
        await cluster.Database.TakeLeaseAsync(await cluster.Database.TenantIdAsync(slug), "elsewhere/1");
        Assert.False(await router.MayStartAutonomousAsync(slug, true, default));
        await cluster.Database.ExecuteOwnerAsync("UPDATE tenant_leases SET state='released' WHERE owner_replica='elsewhere/1'");
        Assert.True(await router.MayStartAutonomousAsync(slug, true, default));
        stopping.Cancel();
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
    [InlineData(100, true, false)]
    [InlineData(100, true, true)]
    [InlineData(65537, false, false)]
    public async Task AControlRefusalRetriesOnlyAnUploadTheEdgeCanStillSend(int length, bool retried, bool moveToEdge)
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
            if (moveToEdge)
            {
                owner.Stop.Cancel();
                await owner.Run.WaitAsync(TimeSpan.FromSeconds(3));
            }
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
        if (retried)
        {
            Assert.EndsWith("|" + data, await result.Content.ReadAsStringAsync());
            Assert.Equal("2097152", Assert.Single(result.Headers.GetValues("X-Test-Body-Limit")));
        }
        Assert.Equal(retried ? 1 : 0, (moveToEdge ? edge : owner).ApplicationCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RediscoveryEndsARequestWhoseOriginalHostnameBindingChanged(bool reassigned)
    {
        await using var f = await StartAsync("alpha", "beta");
        await f.WhoAmIAsync("beta");
        using (var missing = await f.GetAsync("marker")) Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        f.StartGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = f.GetAsync("alpha");
        await UntilAsync(() => f.EventList().Contains("alpha:start-waits"), "initial name resolved and cold start reached its gate");
        await f.Database.ExecuteOwnerAsync((reassigned
            ? "UPDATE tenant_hostnames SET kind='custom',tenant_id=(SELECT tenant_id FROM tenants WHERE name='beta') WHERE hostname='alpha.test';"
            : "DELETE FROM tenant_hostnames WHERE hostname='alpha.test';")
            + "INSERT INTO tenant_hostnames(hostname,tenant_id,kind) SELECT 'marker.test',tenant_id,'custom' FROM tenants WHERE name='beta';");
        // The same commit changes both names. A formerly negative name becoming positive
        // shows the directory has invalidated without starting another request for the held slug.
        await UntilAsync(async () =>
        {
            using var marker = await f.GetAsync("marker");
            return marker.IsSuccessStatusCode;
        }, "hostname change observed");
        f.StartGate.SetResult();
        using var refusal = await pending;
        Assert.Equal(HttpStatusCode.NotFound, refusal.StatusCode);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ARemoteActivationCannotDispatchThroughABindingTheEdgeAlreadyInvalidated(bool reassigned)
    {
        await using var edge = await StartAsync(LeaseTimings.Default, "alpha", "beta");
        await edge.WhoAmIAsync("beta");
        var candidate = Enumerable.Range(0, 100).Select(i => "other-" + i)
            .First(name => Placement.Score("alpha", name) > Placement.Score("alpha", "replica-a"));
        var boot = candidate + "/1";
        var database = edge.Database.OpenApp();
        var stale = new HostnameDirectory(database);
        await stale.RefreshAsync(default); // The receiver has not processed the later notification.
        var auth = new MeshAuthentication(edge.MeshKey, boot);
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel(k => k.Listen(IPAddress.Loopback, 0, e => e.Protocols = HttpProtocols.Http2));
        await using var peer = builder.Build();
        int activations = 0, dispatches = 0;
        var changeObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Run(async context =>
        {
            var attempt = auth.Accept(context.Request)!;
            if (attempt.Purpose == "dispatch")
            {
                if (context.Request.Path == "/held") Interlocked.Increment(ref dispatches);
                Assert.Equal("alpha", await stale.ResolveAsync(context.Request.Host.Host, default));
                await context.Response.WriteAsync("stale owner");
                return;
            }
            try
            {
                Interlocked.Increment(ref activations);
                await edge.Database.TakeLeaseAsync(await edge.Database.TenantIdAsync("alpha"), boot);
                await edge.Database.ExecuteOwnerAsync(reassigned
                    ? "UPDATE tenant_hostnames SET kind='custom',tenant_id=(SELECT tenant_id FROM tenants WHERE name='beta') WHERE hostname='alpha.test';"
                    : "DELETE FROM tenant_hostnames WHERE hostname='alpha.test';");
                // Probe the very same cached authority. Another name can miss the cache and see
                // its new row before this edge has received the invalidation for alpha.test.
                await UntilAsync(async () =>
                {
                    using var probe = await edge.GetAsync("alpha");
                    return reassigned ? (await probe.Content.ReadAsStringAsync()).StartsWith("beta:", StringComparison.Ordinal)
                        : probe.StatusCode == HttpStatusCode.NotFound;
                }, "edge observed the original binding change");
                changeObserved.SetResult();
                context.Response.StatusCode = StatusCodes.Status204NoContent;
            }
            catch (Exception error)
            {
                changeObserved.TrySetException(error);
                throw;
            }
        });
        await peer.StartAsync();
        await new ReplicaRegistry(database).RegisterAsync(boot, null, Foxwarm.Hosted.Schema.SchemaMigrator.BinaryLevel, 2, default, meshAddress: peer.Urls.Single());
        using var result = await edge.GetAsync("alpha", "/held");
        await changeObserved.Task.WaitAsync(TimeSpan.FromSeconds(12));
        Assert.Equal(1, activations);
        Assert.Equal("alpha", await stale.ResolveAsync("alpha.test", default));
        Assert.Equal(HttpStatusCode.NotFound, result.StatusCode);
        Assert.Equal(0, dispatches);
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
    public async Task ClientTransportFinWithoutACloseFrameEndsTheOwnerStreamWithinTheGraceBound()
    {
        await using var owner = await StartAsync("alpha");
        await owner.WhoAmIAsync("alpha");
        await using var edge = await StartReplicaAsync(owner.Database, "replica-b", owner.MeshKey);
        using var client = new System.Net.Sockets.TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, edge.Replica.FrontPort!.Value);
        await using var connection = client.GetStream();
        using var bound = new CancellationTokenSource(WebSocketEnd.CloseGrace + TimeSpan.FromSeconds(5));
        var key = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16));
        var upgrade = $"GET /socket?transport HTTP/1.1\r\nHost: alpha.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Protocol: tenant\r\n\r\n";
        await connection.WriteAsync(System.Text.Encoding.ASCII.GetBytes(upgrade), bound.Token);
        using var headers = new MemoryStream();
        var one = new byte[1];
        while (!System.Text.Encoding.ASCII.GetString(headers.ToArray()).EndsWith("\r\n\r\n"))
        {
            await connection.ReadExactlyAsync(one, bound.Token);
            headers.WriteByte(one[0]);
        }
        Assert.StartsWith("HTTP/1.1 101", System.Text.Encoding.ASCII.GetString(headers.ToArray()));
        owner.Continue.SetResult();
        var frame = new byte[7];
        await connection.ReadExactlyAsync(frame, bound.Token);
        Assert.Equal("final", System.Text.Encoding.UTF8.GetString(frame, 2, 5));
        // Kestrel can surface a TCP FIN as RequestAborted: once this public transport closes
        // it cannot deliver new reverse bytes. Already delivered data is preserved.
        client.Client.Shutdown(System.Net.Sockets.SocketShutdown.Send);
        await owner.Entered.Task.WaitAsync(bound.Token);
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
