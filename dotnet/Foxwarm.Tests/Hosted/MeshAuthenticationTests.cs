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
        var signed = sender.Sign("dispatch", "owner/1", "alpha", 1, "GET", "Alpha.test:81", target);
        var observations = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => owner.Accept(Request(signed.Header, target)))));
        Assert.Equal(signed.Attempt, Assert.Single(observations.OfType<MeshAttempt>()));
        var next = sender.Sign("dispatch", "owner/1", "alpha", 1, "GET", "Alpha.test:81", target);
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
        var signed = edge.Sign("dispatch", "owner/1", "alpha", 2, "GET", "Alpha.test:81", "/item?a=%2F");
        Assert.Null(nextBoot.Accept(Request(signed.Header, "/item?a=%2F")));
        Assert.Null(owner.Accept(Request(signed.Header, "/item?a=/")));
        Assert.Null(owner.Accept(Request(signed.Header, "/item?a=%2F", "HEAD")));
        Assert.Null(owner.Accept(Request(signed.Header, "/item?a=%2F", authority: "beta.test")));
        Assert.Null(owner.Accept(Request(signed.Header.Replace(";2;", ";3;"), "/item?a=%2F")));
        var future = clock.Now;
        clock.Now = future.AddSeconds(-30);
        Assert.Equal(signed.Attempt, owner.Accept(Request(signed.Header, "/item?a=%2F")));
        clock.Now = future.AddSeconds(30);
        Assert.Null(owner.Accept(Request(signed.Header, "/item?a=%2F")));
        clock.Now = future.AddSeconds(31);
        Assert.Null(owner.Accept(Request(signed.Header, "/item?a=%2F")));
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
