using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Foxwarm.Hosted.Forwarding;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Connections.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
[Collection("Process console")]
public sealed class ForwardingProcessTests
{
    [Fact]
    public async Task ChunkedSessionCreationReachesTheOwnerWithItsRequestedIdentity()
    {
        await using var cluster = await ReplicaProcessHarness.CreateAsync();
        await cluster.AddTenantAsync("alpha");
        var owner = await cluster.StartAsync("owner");
        using (var warm = await owner.GetAsync("alpha")) Assert.Equal(HttpStatusCode.Unauthorized, warm.StatusCode);
        var edge = await cluster.StartAsync("edge");
        using var client = new HttpClient(new SocketsHttpHandler { UseProxy = false });
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{edge.FrontPort}/api/sessions");
        request.Headers.Host = "alpha.test";
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await cluster.SignInTokenAsync("alpha"));
        request.Headers.TransferEncodingChunked = true;
        request.Content = new StringContent("{\"sessionId\":\"mesh-session\"}", Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request);
        var json = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, json);
        Assert.Contains("mesh-session", json);
    }

    [Fact]
    public async Task TheCliNodeReceivesTheRealOwnersPolicyCloseAndFallsBackToPairing()
    {
        await using var cluster = await ReplicaProcessHarness.CreateAsync();
        await cluster.AddTenantAsync("alpha");
        await cluster.Database.ExecuteOwnerAsync("INSERT INTO tenant_hostnames (hostname,tenant_id,kind) SELECT '127.0.0.1',tenant_id,'custom' FROM tenants WHERE name='alpha'");
        var owner = await cluster.StartAsync("owner");
        using (var warm = await owner.GetAsync("alpha")) Assert.Equal(HttpStatusCode.Unauthorized, warm.StatusCode);
        var edge = await cluster.StartAsync("edge");
        using var root = new TempDirectory();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var invalid = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pairing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var node = new Foxwarm.CliNode.NodeClient(new($"http://127.0.0.1:{edge.FrontPort}", "missing-node", "pair", "stale", null,
            LocalTrigger: false, OnStatus: (state, detail) =>
            {
                if (state == "authentication_failed") invalid.TrySetResult();
                if (state == "connecting" && detail.Contains("mode=pairing")) pairing.TrySetResult();
            }), new Foxwarm.CliNode.NodePaths(root.Path));
        var run = node.Run(stop.Token);
        try
        {
            await invalid.Task.WaitAsync(stop.Token);
            await pairing.Task.WaitAsync(stop.Token);
        }
        finally
        {
            stop.Cancel();
            await run;
        }
    }

    [Theory]
    [InlineData(8, false)] // CANCEL: this application outcome is unknown.
    [InlineData(7, false)] // REFUSED_STREAM: the pooled client may transparently resend the same attempt.
    [InlineData(7, true)] // The first attempt uses the warmed connection while it is closing.
    public async Task ACommittedBodylessSessionCreationIsNeverRepeatedWhenItsReplyIsLost(int streamError, bool stalePool)
    {
        await using var cluster = await ReplicaProcessHarness.CreateAsync();
        await cluster.AddTenantAsync("alpha");
        await cluster.AddTenantAsync("beta");
        var owner = await cluster.StartAsync("owner");
        using (var warm = await owner.GetAsync("alpha")) Assert.Equal(HttpStatusCode.Unauthorized, warm.StatusCode);
        using (var warm = await owner.GetAsync("beta")) Assert.Equal(HttpStatusCode.Unauthorized, warm.StatusCode);
        var edge = await cluster.StartAsync("edge");
        var boot = (string)(await cluster.OwnerAsync("alpha"))!;
        var original = (string)(await cluster.Database.ScalarAsync("SELECT mesh_address FROM replicas WHERE replica_id=$1", boot))!;
        var token = await cluster.SignInTokenAsync("alpha");
        using var client = new HttpClient(new SocketsHttpHandler { UseProxy = false });
        using var wrongHost = Public(HttpMethod.Get, "beta");
        using (var refused = await client.SendAsync(wrongHost)) Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
        var initial = await CountAsync();
        var replies = new List<HttpStatusCode>();
        var connectionIds = new List<string>();
        string? warmedConnection = null;
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel(server => server.Listen(IPAddress.Loopback, 0, endpoint => endpoint.Protocols = HttpProtocols.Http2));
        await using var relay = builder.Build();
        relay.Run(async context =>
        {
            if (context.Request.Method == "GET")
            {
                warmedConnection = context.Connection.Id;
                await context.Response.WriteAsync("warm");
                return;
            }
            // Let the real owner finish the request. Only its first response is discarded.
            // If the HTTP client retries this stream internally, keep the same signed headers.
            using var onward = new HttpRequestMessage(HttpMethod.Post, original + "/api/sessions")
            { Version = HttpVersion.Version20, VersionPolicy = HttpVersionPolicy.RequestVersionExact };
            onward.Headers.Host = context.Request.Host.Value;
            onward.Headers.TryAddWithoutValidation(MeshAuthentication.Header, context.Request.Headers[MeshAuthentication.Header].ToString());
            onward.Headers.TryAddWithoutValidation("Authorization", context.Request.Headers.Authorization.ToString());
            using var result = await client.SendAsync(onward, context.RequestAborted);
            bool first;
            lock (replies)
            {
                first = replies.Count == 0;
                replies.Add(result.StatusCode);
                connectionIds.Add(context.Connection.Id);
            }
            if (first)
            {
                if (stalePool)
                    context.Features.Get<IConnectionLifetimeNotificationFeature>()!.RequestClose();
                context.Features.Get<IHttpResetFeature>()!.Reset(streamError);
                return;
            }
            context.Response.StatusCode = (int)result.StatusCode;
            foreach (var (key, value) in result.Headers.Where(pair => pair.Key.StartsWith("Foxwarm-Mesh-", StringComparison.OrdinalIgnoreCase)))
                context.Response.Headers[key] = value.ToArray();
        });
        await relay.StartAsync();
        await cluster.Database.ScalarAsync("UPDATE replicas SET mesh_address=$1 WHERE replica_id=$2", relay.Urls.Single(), boot);
        if (stalePool)
        {
            using var warming = Public(HttpMethod.Get, "alpha");
            using var pooled = await client.SendAsync(warming);
            Assert.Equal("warm", await pooled.Content.ReadAsStringAsync());
        }
        using var post = Public(HttpMethod.Post, "alpha");
        using var response = await client.SendAsync(post);
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Contains("outcome unknown", await response.Content.ReadAsStringAsync());
        Assert.Null(response.Headers.RetryAfter);
        Assert.Equal(initial + 1, await CountAsync());
        lock (replies)
        {
            Assert.InRange((int)replies[0], 200, 299);
            if (streamError == 7) Assert.True(replies.Count > 1, "the transport didn't resend the refused stream");
            Assert.All(replies.Skip(1), code => Assert.Equal(HttpStatusCode.Forbidden, code));
            if (stalePool)
            {
                Assert.NotNull(warmedConnection);
                Assert.Equal(warmedConnection, connectionIds[0]);
                Assert.NotEqual(warmedConnection, connectionIds[^1]);
            }
        }

        HttpRequestMessage Public(HttpMethod method, string slug)
        {
            var request = new HttpRequestMessage(method, $"http://127.0.0.1:{edge.FrontPort}/api/sessions");
            request.Headers.Host = slug + ".test";
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            return request;
        }
        async Task<long> CountAsync() => (long)(await cluster.Database.ScalarAsync(
            "SELECT count(*) FROM session_catalog WHERE tenant_id=(SELECT tenant_id FROM tenants WHERE name=$1)", "alpha"))!;
    }
}
