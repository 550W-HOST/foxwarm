using System.Net;
using System.Net.WebSockets;
using Foxwarm.Net;

namespace Foxwarm.Tests.Net;

/// <summary>
/// Plan §11, the egress matrix: literals of each denied kind, names resolving to them,
/// rebinding, redirects to each and a WebSocket upgrade to each. All are denied for a hosted
/// tenant; the operator profile reaches internal destinations except the deployment's
/// <c>egress.deny</c>, and <c>egress.allow</c> makes exceptions for either profile.
/// </summary>
public sealed class EgressMatrixTests
{
    // Every denied kind of §7.1, as a URL host.
    private static readonly string[] Literals =
        [
            "127.0.0.1",
            "127.255.0.9",
            "0.0.0.0",
            "0.1.2.3",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "100.64.0.1",
            "100.127.255.254",
            "169.254.169.254",
            "169.254.0.1",
            "224.0.0.1",
            "239.255.255.250",
            "255.255.255.255",
            "[::1]",
            "[::]",
            "[fc00::1]",
            "[fd12:3456::1]",
            "[fe80::1]",
            "[ff02::1]",
            "[::ffff:127.0.0.1]",
            "[::ffff:10.0.0.1]",
            "[::ffff:169.254.169.254]",
            "[::ffff:192.168.0.1]",
            "[::127.0.0.1]",
            "[::10.0.0.1]",
            "[::a9fe:a9fe]",
            // NAT64 and 6to4 forms embed the IPv4 address the rules apply to.
            "[64:ff9b::a00:1]",
            "[64:ff9b::7f00:1]",
            "[64:ff9b::a9fe:a9fe]",
            "[64:ff9b:1::c0a8:1]",
            "[2002:a00:1::1]",
            "[2002:a9fe:a9fe::]",
        ];

    public static TheoryData<string> DeniedLiterals => new(Literals);

    private static IPAddress Address(string host) => IPAddress.Parse(host.Trim('[', ']'));

    private static bool Denied(Exception? error)
    {
        for (; error is not null; error = error.InnerException)
            if (error is EgressDeniedException)
                return true;
        return false;
    }

    private static async Task<Exception?> GetAsync(EgressPolicy policy, string url)
    {
        using var client = EgressHttp.Client(policy, EgressPurpose.Model);
        try
        {
            using var response = await client.GetAsync(url);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("ok", await response.Content.ReadAsStringAsync());
            return null;
        }
        catch (HttpRequestException error)
        {
            return error;
        }
    }

    private static async Task<Exception?> WebSocketAsync(EgressPolicy policy, string url)
    {
        using var socket = EgressHttp.WebSocket();
        try
        {
            await EgressHttp.ConnectWebSocketAsync(
                policy,
                EgressPurpose.Channel,
                socket,
                new Uri(url),
                null,
                CancellationToken.None
            );
            var buffer = new byte[16];
            var frame = await socket.ReceiveAsync(buffer, CancellationToken.None);
            Assert.Equal(WebSocketMessageType.Close, frame.MessageType);
            Assert.Equal("bye", socket.CloseStatusDescription);
            return null;
        }
        catch (WebSocketException error)
        {
            return error;
        }
    }

    [Theory]
    [MemberData(nameof(DeniedLiterals))]
    public async Task HostedRefusesEachDeniedLiteralBeforeConnecting(string host)
    {
        await using var fixture = await EgressFixture.StartAsync();
        var error = await GetAsync(fixture.Hosted(), $"http://{host}:{fixture.Port}/ok");
        Assert.True(Denied(error), error?.ToString());
        Assert.Empty(fixture.Connects);
        Assert.Empty(fixture.Lookups);
    }

    [Theory]
    [MemberData(nameof(DeniedLiterals))]
    public async Task HostedRefusesANameResolvingToEachDeniedKind(string host)
    {
        await using var fixture = await EgressFixture.StartAsync();
        fixture.Name("internal.example", Address(host));
        // A name that mixes a public address with an internal one is refused too.
        fixture.Name("mixed.example", [EgressFixture.PublicV4, Address(host)]);
        var policy = fixture.Hosted();
        Assert.True(Denied(await GetAsync(policy, $"http://internal.example:{fixture.Port}/ok")));
        Assert.True(Denied(await GetAsync(policy, $"http://mixed.example:{fixture.Port}/ok")));
        Assert.Empty(fixture.Connects);
    }

    [Theory]
    [MemberData(nameof(DeniedLiterals))]
    public async Task HostedRefusesARedirectToEachDeniedKind(string host)
    {
        await using var fixture = await EgressFixture.StartAsync();
        fixture.Name("public.example", EgressFixture.PublicV4);
        fixture.Name("internal.example", Address(host));
        var policy = fixture.Hosted();
        foreach (
            var target in new[]
            {
                $"http://{host}:{fixture.Port}/ok",
                $"http://internal.example:{fixture.Port}/ok",
            }
        )
        {
            var error = await GetAsync(
                policy,
                $"http://public.example:{fixture.Port}/redirect?to={Uri.EscapeDataString(target)}"
            );
            Assert.True(Denied(error), error?.ToString());
        }
        // Only the public hop connected.
        Assert.All(fixture.Connects, endpoint => Assert.Equal(EgressFixture.PublicV4, endpoint.Address));
    }

    [Theory]
    [MemberData(nameof(DeniedLiterals))]
    public async Task HostedRefusesAWebSocketUpgradeToEachDeniedKind(string host)
    {
        await using var fixture = await EgressFixture.StartAsync();
        fixture.Name("internal.example", Address(host));
        var policy = fixture.Hosted();
        Assert.True(Denied(await WebSocketAsync(policy, $"ws://{host}:{fixture.Port}/ws")));
        Assert.True(
            Denied(await WebSocketAsync(policy, $"ws://internal.example:{fixture.Port}/ws"))
        );
        Assert.Empty(fixture.Connects);
    }

    [Fact]
    public async Task HostedReachesPublicDestinationsResolvingOncePerConnection()
    {
        await using var fixture = await EgressFixture.StartAsync();
        fixture.Name("public.example", EgressFixture.PublicV4);
        fixture.Name("public6.example", EgressFixture.PublicV6);
        var policy = fixture.Hosted();
        Assert.Null(await GetAsync(policy, $"http://public.example:{fixture.Port}/ok"));
        Assert.Null(await GetAsync(policy, $"http://public6.example:{fixture.Port}/ok"));
        Assert.Null(await WebSocketAsync(policy, $"ws://public.example:{fixture.Port}/ws"));
        Assert.Equal(new[] { "public.example", "public6.example", "public.example" }, fixture.Lookups);
        // Each connection went to the address that was checked, never to a second lookup's.
        Assert.Equal(
            new[] { EgressFixture.PublicV4, EgressFixture.PublicV6, EgressFixture.PublicV4 },
            fixture.Connects.Select(endpoint => endpoint.Address)
        );
    }

    [Fact]
    public async Task RebindingFromPublicToPrivateIsRefusedOnTheNextConnection()
    {
        await using var fixture = await EgressFixture.StartAsync();
        fixture.Name(
            "rebind.example",
            [EgressFixture.PublicV4],
            [IPAddress.Loopback],
            [IPAddress.Parse("169.254.169.254")]
        );
        using var client = EgressHttp.Client(fixture.Hosted(), EgressPurpose.Model);
        var url = $"http://rebind.example:{fixture.Port}/ok";
        using (var first = new HttpRequestMessage(HttpMethod.Get, url))
        {
            first.Headers.ConnectionClose = true;
            using var response = await client.SendAsync(first);
            Assert.Equal("ok", await response.Content.ReadAsStringAsync());
        }
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var error = await Assert.ThrowsAsync<HttpRequestException>(() =>
                client.GetStringAsync(url)
            );
            Assert.True(Denied(error));
        }
        Assert.Equal(3, fixture.Lookups.Count);
        Assert.Equal(
            new[] { EgressFixture.PublicV4 },
            fixture.Connects.Select(endpoint => endpoint.Address)
        );
    }

    [Fact]
    public async Task OperatorReachesInternalDestinationsExceptTheDeploymentDenySet()
    {
        await using var fixture = await EgressFixture.StartAsync();
        fixture.Name("public.example", EgressFixture.PublicV4);
        fixture.Name("loopback.example", IPAddress.Loopback);
        var policy = fixture.Operator();
        Assert.Null(await GetAsync(policy, $"http://127.0.0.1:{fixture.Port}/ok"));
        Assert.Null(await GetAsync(policy, $"http://[::ffff:127.0.0.1]:{fixture.Port}/ok"));
        Assert.Null(await GetAsync(policy, $"http://loopback.example:{fixture.Port}/ok"));
        var redirect = Uri.EscapeDataString($"http://127.0.0.1:{fixture.Port}/ok");
        Assert.Null(
            await GetAsync(policy, $"http://public.example:{fixture.Port}/redirect?to={redirect}")
        );
        Assert.Null(await WebSocketAsync(policy, $"ws://127.0.0.1:{fixture.Port}/ws"));

        // The deployment's deny set (here the loopback range, as it would be the mesh or the
        // database) holds for the operator profile too, in every form.
        var denying = fixture.Operator(
            EgressRules.Parse(Yaml("deny: [127.0.0.0/8, \"::1\", 10.0.0.0/8]"))
        );
        // The deny set applies to the IPv4 address a NAT64 or 6to4 address embeds.
        foreach (var embedded in new[] { "64:ff9b::a00:1", "2002:a00:5::1", "64:ff9b::7f00:1" })
            Assert.True(denying.Denies(IPAddress.Parse(embedded)), embedded);
        Assert.False(denying.Denies(IPAddress.Parse("64:ff9b::808:808")));
        foreach (
            var url in new[]
            {
                $"http://127.0.0.1:{fixture.Port}/ok",
                $"http://[::ffff:127.0.0.1]:{fixture.Port}/ok",
                $"http://[::1]:{fixture.Port}/ok",
                $"http://loopback.example:{fixture.Port}/ok",
                $"http://public.example:{fixture.Port}/redirect?to={redirect}",
            }
        )
            Assert.True(Denied(await GetAsync(denying, url)), url);
        Assert.True(Denied(await WebSocketAsync(denying, $"ws://127.0.0.1:{fixture.Port}/ws")));
    }

    [Fact]
    public async Task AllowExceptionsApplyPerProfile()
    {
        await using var fixture = await EgressFixture.StartAsync();
        fixture.Name("gateway.internal", IPAddress.Loopback);
        fixture.Name("other.internal", IPAddress.Parse("127.0.0.2"));
        var rules = EgressRules.Parse(
            Yaml(
                "deny: [127.0.0.0/8]\nallow:\n  hosted: [127.0.0.1/32, gateway.internal]\n  operator: [\"::1\"]"
            )
        );
        var hosted = fixture.Hosted(rules);
        Assert.Null(await GetAsync(hosted, $"http://127.0.0.1:{fixture.Port}/ok"));
        Assert.Null(await GetAsync(hosted, $"http://[::ffff:127.0.0.1]:{fixture.Port}/ok"));
        Assert.Null(await GetAsync(hosted, $"http://gateway.internal:{fixture.Port}/ok"));
        Assert.Null(await WebSocketAsync(hosted, $"ws://127.0.0.1:{fixture.Port}/ws"));
        Assert.True(Denied(await GetAsync(hosted, $"http://127.0.0.2:{fixture.Port}/ok")));
        Assert.True(Denied(await GetAsync(hosted, $"http://other.internal:{fixture.Port}/ok")));
        Assert.True(Denied(await GetAsync(hosted, $"http://[::1]:{fixture.Port}/ok")));
        // An allowed IPv4 network covers its NAT64 form too.
        Assert.False(hosted.Denies(IPAddress.Parse("64:ff9b::7f00:1")));
        Assert.True(hosted.Denies(IPAddress.Parse("64:ff9b::7f00:2")));
        // The hosted exceptions aren't the operator's.
        var @operator = fixture.Operator(rules);
        Assert.True(Denied(await GetAsync(@operator, $"http://gateway.internal:{fixture.Port}/ok")));
        Assert.True(Denied(await GetAsync(@operator, $"http://127.0.0.1:{fixture.Port}/ok")));
    }

    [Fact]
    public async Task ADeploymentPurposeUsesTheOperatorRulesInAHostedRuntime()
    {
        await using var fixture = await EgressFixture.StartAsync();
        var hosted = fixture.Hosted();
        using var asr = EgressHttp.Client(hosted, EgressPurpose.Deployment);
        Assert.Equal("ok", await asr.GetStringAsync($"http://127.0.0.1:{fixture.Port}/ok"));
        using var model = EgressHttp.Client(hosted, EgressPurpose.Model);
        var error = await Assert.ThrowsAsync<HttpRequestException>(() =>
            model.GetStringAsync($"http://127.0.0.1:{fixture.Port}/ok")
        );
        Assert.True(Denied(error));
    }

    [Fact]
    public void GuardedHandlersUseNoProxyAndFileHandlersAreUnchanged()
    {
        using var hosted = (SocketsHttpHandler)EgressHttp.Handler(
            EgressPolicy.Hosted(),
            EgressPurpose.Model
        );
        Assert.False(hosted.UseProxy);
        Assert.NotNull(hosted.ConnectCallback);
        using var @operator = (SocketsHttpHandler)EgressHttp.Handler(
            EgressPolicy.Operator(),
            EgressPurpose.Model,
            new EgressHandlerOptions { UseProxy = true }
        );
        Assert.False(@operator.UseProxy);
        Assert.NotNull(@operator.ConnectCallback);
        using var file = (SocketsHttpHandler)EgressHttp.Handler(
            EgressPolicy.Unguarded,
            EgressPurpose.Model
        );
        Assert.True(file.UseProxy);
        Assert.Null(file.ConnectCallback);
    }

    [Fact]
    public void TheDeploymentRulesRefuseMalformedEntriesNamingThem()
    {
        Assert.Same(EgressRules.None, EgressRules.Parse(null));
        Assert.Equal(
            "`egress.deny[1]` must be an IP address or CIDR.",
            Assert.Throws<InvalidDataException>(() =>
                EgressRules.Parse(Yaml("deny: [10.0.0.0/8, mesh.internal]"))
            ).Message
        );
        Assert.Equal(
            "`egress.allow.tenant` isn't a setting.",
            Assert.Throws<InvalidDataException>(() =>
                EgressRules.Parse(Yaml("allow:\n  tenant: [10.0.0.1]"))
            ).Message
        );
        Assert.Equal(
            "`egress.allow.hosted[0]` must be an IP address, a CIDR or a host name.",
            Assert.Throws<InvalidDataException>(() =>
                EgressRules.Parse(Yaml("allow:\n  hosted: [\"10.0.0.0/33\"]"))
            ).Message
        );
        Assert.Equal(
            "`egress.proxy` isn't a setting.",
            Assert.Throws<InvalidDataException>(() => EgressRules.Parse(Yaml("proxy: x"))).Message
        );
    }

    [Fact]
    public void TheDeploymentConfigurationCarriesTheRules()
    {
        const string required = "health: {port: 3081}\nblobs: {backend: postgres}\n";
        var deployment = Foxwarm.Hosted.DeploymentConfiguration.Parse(
            required + "egress: {deny: [10.96.0.0/12], allow: {hosted: [llm.internal]}}\n"
        );
        Assert.Equal([IPNetwork.Parse("10.96.0.0/12")], deployment.Egress.Deny);
        Assert.Contains("llm.internal", deployment.Egress.HostedAllow.Hosts);
        Assert.Same(
            EgressRules.None,
            Foxwarm.Hosted.DeploymentConfiguration.Parse(required).Egress
        );
        Assert.Equal(
            "Deployment configuration: `egress.deny[0]` must be an IP address or CIDR.",
            Assert.Throws<Foxwarm.Hosted.HostedBootstrapException>(() =>
                Foxwarm.Hosted.DeploymentConfiguration.Parse(required + "egress: {deny: [mesh]}\n")
            ).Message
        );
    }

    [Theory]
    // Each rule form against each input form of the same IPv4 endpoint.
    [InlineData("198.51.100.7")]
    [InlineData("\"::ffff:198.51.100.7\"")]
    [InlineData("198.51.100.0/24")]
    [InlineData("\"::ffff:198.51.100.0/120\"")]
    [InlineData("\"[::ffff:198.51.100.7]\"")]
    public void DeploymentRulesMatchAnIPv4EndpointInEitherForm(string rule)
    {
        var rules = EgressRules.Parse(Yaml($"deny: [{rule}]"));
        var @operator = EgressPolicy.Operator(rules);
        foreach (var input in new[] { "198.51.100.7", "::ffff:198.51.100.7", "64:ff9b::c633:6407", "2002:c633:6407::1" })
            Assert.True(@operator.Denies(IPAddress.Parse(input)), $"{rule} / {input}");
        Assert.False(@operator.Denies(IPAddress.Parse("198.51.101.7")));
        // An allow exception matches both forms too.
        var allowed = EgressPolicy.Hosted(EgressRules.Parse(Yaml($"allow: {{hosted: [{rule}]}}")));
        foreach (var input in new[] { "198.51.100.7", "::ffff:198.51.100.7", "64:ff9b::c633:6407" })
            Assert.False(allowed.Denies(IPAddress.Parse(input)), $"{rule} / {input}");
    }

    [Fact]
    public void AnIPv6RuleWiderThanTheMappedRangeStaysIPv6()
    {
        var rules = EgressRules.Parse(Yaml("deny: [\"2001:db8::/32\", \"::/8\"]"));
        var @operator = EgressPolicy.Operator(rules);
        Assert.True(@operator.Denies(IPAddress.Parse("2001:db8::1")));
        Assert.True(@operator.Denies(IPAddress.Parse("::1")));
        // Native IPv4 isn't inside ::/8 because its mapped form is.
        Assert.False(@operator.Denies(IPAddress.Parse("8.8.8.8")));
        Assert.False(@operator.Denies(IPAddress.Parse("::ffff:8.8.8.8")));
    }

    [Fact]
    public void HostExceptionsCompareInTheirWireForm()
    {
        var policy = EgressPolicy.Hosted(EgressRules.Parse(Yaml("allow: {hosted: [Bücher.Example.]}")));
        Assert.True(policy.AllowsHost("xn--bcher-kva.example."));
        Assert.True(policy.AllowsHost("bücher.example."));
        Assert.True(policy.AllowsHost("BÜCHER.example。"));
        Assert.True(policy.AllowsHost(new Uri("https://bücher.example./").IdnHost));
        Assert.False(policy.AllowsHost("buecher.example."));
        Assert.False(policy.AllowsHost("bucher.example."));
        // An absolute exception doesn't match the relative spelling.
        Assert.False(policy.AllowsHost("bücher.example"));
        Assert.False(policy.AllowsHost("xn--bcher-kva.example"));
        // The ASCII spelling in the configuration is the same exception, and an ideographic
        // full stop ends a name as a dot does.
        var ascii = EgressPolicy.Hosted(EgressRules.Parse(Yaml("allow: {hosted: [xn--bcher-kva.example]}")));
        Assert.True(ascii.AllowsHost("bücher.example"));
        Assert.True(ascii.AllowsHost(new Uri("https://bücher.example/").IdnHost));
        Assert.False(ascii.AllowsHost("bücher.example."));
        Assert.False(ascii.AllowsHost("bücher.example。"));
        var ideographic = EgressPolicy.Hosted(EgressRules.Parse(Yaml("allow: {hosted: [Bücher.example。]}")));
        Assert.True(ideographic.AllowsHost("xn--bcher-kva.example."));
        Assert.False(ideographic.AllowsHost("xn--bcher-kva.example"));
    }

    [Fact]
    public async Task AHostExceptionResolvesTheFormItAuthorizes()
    {
        await using var fixture = await EgressFixture.StartAsync();
        // The search list and the absolute name answer differently.
        fixture.Name("mock-llm", IPAddress.Loopback);
        fixture.Name("mock-llm.", IPAddress.Parse("127.0.0.2"));
        fixture.Name("api.example.com.", IPAddress.Parse("127.0.0.3"));
        fixture.Name("api.example.com", IPAddress.Parse("10.1.2.3"));
        var policy = fixture.Hosted(
            EgressRules.Parse(Yaml("allow: {hosted: [mock-llm, api.example.com.]}"))
        );
        Assert.Equal([IPAddress.Loopback], await policy.ResolveCheckedAsync("mock-llm", default));
        Assert.Equal(
            [IPAddress.Parse("127.0.0.3")],
            await policy.ResolveCheckedAsync("API.example.com.", default)
        );
        // The other forms aren't exceptions: their internal answers are refused.
        await Assert.ThrowsAsync<EgressDeniedException>(() => policy.ResolveCheckedAsync("mock-llm.", default));
        await Assert.ThrowsAsync<EgressDeniedException>(() =>
            policy.ResolveCheckedAsync("api.example.com", default)
        );
        Assert.Equal(["mock-llm", "api.example.com.", "mock-llm.", "api.example.com"], fixture.Lookups);
        // Through a client, the request host is the form resolved.
        Assert.Null(await GetAsync(policy, $"http://mock-llm:{fixture.Port}/ok"));
        Assert.True(Denied(await GetAsync(policy, $"http://mock-llm.:{fixture.Port}/ok")));
    }

    [Fact]
    public void TheLocalUseNat64RangeIsDeniedWholeUnlessAllowed()
    {
        // RFC 8215 leaves the translation prefix and any embedded address to the operator, so
        // no IPv4 identity is read from it: a public-looking and an internal-looking suffix are
        // both denied, for both profiles.
        foreach (var policy in new[] { EgressPolicy.Hosted(), EgressPolicy.Operator() })
            foreach (var input in new[] { "64:ff9b:1::808:808", "64:ff9b:1:808:800::", "64:ff9b:1::a00:1" })
                Assert.True(policy.Denies(IPAddress.Parse(input)), $"{policy.Profile} {input}");
        // An operator running a translator there allows its range; that gives up the embedded
        // IPv4 checks for it.
        var rules = EgressRules.Parse(
            Yaml("deny: [10.0.0.0/8]\nallow:\n  hosted: [\"64:ff9b:1:808::/64\"]\n  operator: [\"64:ff9b:1::/48\"]")
        );
        Assert.False(EgressPolicy.Operator(rules).Denies(IPAddress.Parse("64:ff9b:1::a00:1")));
        Assert.False(EgressPolicy.Hosted(rules).Denies(IPAddress.Parse("64:ff9b:1:808:800::")));
        Assert.True(EgressPolicy.Hosted(rules).Denies(IPAddress.Parse("64:ff9b:1::808:808")));
        // The well-known prefix keeps its low-32-bit translation.
        Assert.False(EgressPolicy.Hosted().Denies(IPAddress.Parse("64:ff9b::808:808")));
        Assert.True(EgressPolicy.Hosted().Denies(IPAddress.Parse("64:ff9b::a00:1")));
    }

    [Fact]
    public void AnIPv4ExceptionAllowsATranslationButNotATunnel()
    {
        var rules = EgressRules.Parse(Yaml("deny: [\"2002:808:808::/48\"]\nallow: {hosted: [10.0.0.5, 8.8.8.8]}"));
        var hosted = EgressPolicy.Hosted(rules);
        Assert.False(hosted.Denies(IPAddress.Parse("10.0.0.5")));
        // NAT64 translates to the excepted host itself.
        Assert.False(hosted.Denies(IPAddress.Parse("64:ff9b::a00:5")));
        // A 6to4 site behind that router is another host: denies still see the router.
        Assert.True(hosted.Denies(IPAddress.Parse("2002:a00:5::1")));
        // An IPv4 exception for a router doesn't undo an IPv6 deny of the site behind it.
        Assert.True(hosted.Denies(IPAddress.Parse("2002:808:808::1")));
        // The site takes an IPv6 exception.
        var site = EgressPolicy.Hosted(EgressRules.Parse(Yaml("allow: {hosted: [\"2002:a00:5::/48\"]}")));
        Assert.False(site.Denies(IPAddress.Parse("2002:a00:5::1")));
    }

    [Fact]
    public void TheDefaultDenySetCoversEveryRangeOfThePlan()
    {
        // The local-use NAT64 range is denied whole rather than as an internal IPv4 address.
        foreach (var host in Literals)
            Assert.True(EgressPolicy.Hosted().Denies(Address(host)), host);
        foreach (
            var host in new[]
            {
                "8.8.8.8",
                "1.1.1.1",
                "100.63.255.255",
                "100.128.0.0",
                "172.15.255.255",
                "172.32.0.0",
                "169.253.255.255",
                "223.255.255.255",
                "::ffff:8.8.8.8",
                "2001:4860:4860::8888",
                "64:ff9b::808:808",
                "2002:808:808::1",
                // Teredo isn't decoded.
                "2001:0:4136:e378:8000:63bf:3fff:fdd2",
            }
        )
            Assert.False(EgressAddresses.IsInternal(IPAddress.Parse(host), translated: true), host);
    }

    private static System.Text.Json.Nodes.JsonNode Yaml(string text) =>
        ConfigurationYaml.Parse(text, "egress");
}
