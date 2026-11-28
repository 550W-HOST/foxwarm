using System.Security.Cryptography;
using Foxwarm.Hosted.Forwarding;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Xunit;

namespace Foxwarm.Tests.Hosted;

public sealed class MeshAuthenticationTests
{
    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.FromUnixTimeSeconds(1000);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Fact]
    public async Task ATransportResendCanConsumeOneAttemptOnlyOnce()
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var sender = new MeshAuthentication(key, "edge/1");
        var owner = new MeshAuthentication(key, "owner/1");
        const string target = "/query?key=a%2Fb&key=c";
        var signed = sender.Sign("dispatch", "owner/1", "alpha", 42, 1, "GET", "Alpha.test:81", target);
        var observations = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => owner.Accept(Request(signed.Header, target)))));
        Assert.Equal(signed.Attempt, Assert.Single(observations.OfType<MeshAttempt>()));
        var next = sender.Sign("dispatch", "owner/1", "alpha", 42, 1, "GET", "Alpha.test:81", target);
        Assert.Equal(next.Attempt, owner.Accept(Request(next.Header, target)));
        Assert.True(sender.IsRefusal(signed.Attempt, owner.Refuse(signed.Attempt)));
        Assert.False(sender.IsRefusal(next.Attempt, owner.Refuse(signed.Attempt)));
    }

    [Fact]
    public void AuthorizationCoversTheExactWireRequestAndReceiverBoot()
    {
        var clock = new Clock();
        var key = RandomNumberGenerator.GetBytes(32);
        var edge = new MeshAuthentication(key, "edge/1", clock);
        var owner = new MeshAuthentication(key, "owner/1", clock);
        var nextBoot = new MeshAuthentication(key, "owner/2", clock);
        var signed = edge.Sign("dispatch", "owner/1", "alpha", 42, 2, "GET", "Alpha.test:81", "/item?a=%2F");
        Assert.Null(nextBoot.Accept(Request(signed.Header, "/item?a=%2F")));
        Assert.Null(owner.Accept(Request(signed.Header, "/item?a=/")));
        Assert.Null(owner.Accept(Request(signed.Header, "/item?a=%2F", "HEAD")));
        Assert.Null(owner.Accept(Request(signed.Header, "/item?a=%2F", authority: "beta.test")));
        Assert.Null(owner.Accept(Request(signed.Header.Replace(";2;", ";3;"), "/item?a=%2F")));
        Assert.Null(owner.Accept(Request(signed.Header.Replace(";42;", ";43;"), "/item?a=%2F")));
        Assert.False(edge.IsRefusal(signed.Attempt with { TenantId = 43 }, owner.Refuse(signed.Attempt)));
        var future = clock.Now;
        clock.Now = future.AddSeconds(-30);
        Assert.Equal(signed.Attempt, owner.Accept(Request(signed.Header, "/item?a=%2F")));
        clock.Now = future.AddSeconds(30);
        Assert.Null(owner.Accept(Request(signed.Header, "/item?a=%2F")));
        clock.Now = future.AddSeconds(31);
        Assert.Null(owner.Accept(Request(signed.Header, "/item?a=%2F")));
    }

    [Fact]
    public void FullNonceWindowRefusesNewAdmissionsUntilExpiryWithoutEvictingAnAcceptedNonce()
    {
        var clock = new Clock();
        var auth = new MeshAuthentication(RandomNumberGenerator.GetBytes(32), "owner", clock, nonceLimit: 2);
        HttpRequest New() => Request(auth.Sign("dispatch", "owner", "alpha", 42, 7, "GET", "Alpha.test:81", "/").Header, "/");
        var a = New();
        var control = auth.Sign("activate", "owner", "alpha", 42, null, "POST", "Alpha.test:81", "/");
        var b = Request(control.Header, "/", "POST");
        Assert.NotNull(auth.Accept(a, out _));
        Assert.NotNull(auth.Accept(b, out _));
        Assert.Null(auth.Accept(New(), out var full));
        Assert.True(full);
        Assert.Null(auth.Accept(a, out full));
        Assert.False(full);
        clock.Now = clock.Now.AddSeconds(61);
        Assert.NotNull(auth.Accept(New(), out full));
        Assert.False(full);
    }

    [Fact]
    public void DispatchAndActivationKeepSeparateRoomAcrossTenants()
    {
        var clock = new Clock();
        var auth = new MeshAuthentication(RandomNumberGenerator.GetBytes(32), "owner", clock, nonceLimit: 4);
        MeshAttempt? Send(string tenant, bool activate, out bool full)
        {
            var host = tenant + ".test";
            var method = activate ? "POST" : "GET";
            var signed = auth.Sign(activate ? "activate" : "dispatch", "owner", tenant, tenant[0], activate ? null : 1, method, host, "/");
            return auth.Accept(Request(signed.Header, "/", method, host), out full);
        }
        Assert.NotNull(Send("a", false, out _));
        Assert.NotNull(Send("b", false, out _));
        Assert.NotNull(Send("c", false, out _));
        Assert.Null(Send("d", false, out var full));
        Assert.True(full);
        Assert.NotNull(Send("d", true, out _));
        clock.Now = clock.Now.AddSeconds(61);
        Assert.NotNull(Send("a", true, out _));
        Assert.Null(Send("b", true, out full));
        Assert.True(full);
        Assert.NotNull(Send("d", false, out _));
    }

    [Fact]
    public void ARecreatedTenantGetsItsOwnNonceShare()
    {
        var auth = new MeshAuthentication(RandomNumberGenerator.GetBytes(32), "owner", nonceLimit: 16);
        HttpRequest Signed(int tenantId) => Request(auth.Sign("dispatch", "owner", "alpha", tenantId, 1, "GET", "Alpha.test:81", "/").Header, "/");
        Assert.NotNull(auth.Accept(Signed(12)));
        Assert.NotNull(auth.Accept(Signed(12)));
        Assert.Null(auth.Accept(Signed(12), out var full));
        Assert.True(full);
        Assert.NotNull(auth.Accept(Signed(13)));
    }

    private static HttpRequest Request(string header, string target, string method = "GET", string authority = "Alpha.test:81")
    {
        var context = new DefaultHttpContext();
        context.Features.Get<IHttpRequestFeature>()!.RawTarget = target;
        context.Request.Method = method;
        context.Request.Host = new HostString(authority);
        context.Request.Headers[MeshAuthentication.Header] = header;
        return context.Request;
    }
}
