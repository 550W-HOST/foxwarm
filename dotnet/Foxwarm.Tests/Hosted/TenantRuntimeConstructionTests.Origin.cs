using System.Net;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Runtimes;
using Foxwarm.Storage;
using Microsoft.AspNetCore.Builder;

namespace Foxwarm.Tests.Hosted;

public sealed partial class TenantRuntimeConstructionTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task TenantCookieAuthorityUsesMappedOriginsWithThePublicSchemeAndPort(bool configured)
    {
        await using var harness = await CreateAsync();
        await using var front = await TenantFront.StartAsync();
        var deployment = Deployment(configured ? "https://{slug}.tenants.example/app" : null);
        var lease = await harness.AddTenantAsync("alpha");
        var beta = await harness.AddTenantAsync("beta");
        var primary = new Uri(deployment.TenantOrigin("alpha"));
        await harness.Database.ExecuteOwnerAsync($"INSERT INTO tenant_hostnames(hostname,tenant_id,kind) VALUES ('{primary.Host}',{lease.Id},'primary'),('brand.tenants.example',{lease.Id},'custom'),('beta.tenants.example',{beta.Id},'primary')");
        var mapping = new HostnameDirectory(harness.App);
        var server = front.Server("ingress.test", new TenantServer(primary.AbsoluteUri, mapping, "alpha"));
        await using var runtime = await harness.BuildAsync("alpha", lease, deployment, server: server);
        var host = ((MainHostRuntime)runtime).Host;
        host.App.MapPost("/test-origin", () => "ok");
        await runtime.StartAsync();
        using var client = front.Client("ingress.test", null);
        client.DefaultRequestHeaders.Add("Cookie", "foxwarm_token=" + host.Sessions.Storage.Credentials.Read(InstanceCredentialName.HttpToken));
        client.DefaultRequestHeaders.Add("Sec-Fetch-Site", "same-site");
        var alias = new UriBuilder(primary) { Host = "brand.tenants.example" }.Uri.GetLeftPart(UriPartial.Authority);
        async Task<HttpStatusCode> Send(string? origin)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "test-origin");
            if (origin is not null) request.Headers.TryAddWithoutValidation("Origin", origin);
            using var response = await client.SendAsync(request);
            return response.StatusCode;
        }
        foreach (var (origin, status) in new (string?, HttpStatusCode)[] {
            ("https://beta.tenants.example", HttpStatusCode.Forbidden),
            ("http://ingress.test", HttpStatusCode.Forbidden),
            ("https://alpha.tenants.example:444", HttpStatusCode.Forbidden),
            ("http://alpha.tenants.example", HttpStatusCode.Forbidden),
            ("null", HttpStatusCode.Forbidden),
            ("https://alpha.tenants.example/app", HttpStatusCode.Forbidden),
            (new UriBuilder(primary) { Host = "unmapped.example" }.Uri.GetLeftPart(UriPartial.Authority), HttpStatusCode.Forbidden),
            (new UriBuilder(primary) { Host = "beta.tenants.example" }.Uri.GetLeftPart(UriPartial.Authority), HttpStatusCode.Forbidden),
            (alias, HttpStatusCode.OK),
            (primary.GetLeftPart(UriPartial.Authority), HttpStatusCode.OK),
            (null, HttpStatusCode.OK),
        })
            Assert.Equal(status, await Send(origin));
        using (var upgrade = new HttpRequestMessage(HttpMethod.Get, "api/webui/stream"))
        {
            upgrade.Headers.Add("Origin", new UriBuilder(primary) { Host = "beta.tenants.example" }.Uri.GetLeftPart(UriPartial.Authority));
            upgrade.Headers.Add("Connection", "Upgrade");
            upgrade.Headers.Add("Upgrade", "websocket");
            upgrade.Headers.Add("Sec-WebSocket-Key", Convert.ToBase64String(new byte[16]));
            upgrade.Headers.Add("Sec-WebSocket-Version", "13");
            using var refused = await client.SendAsync(upgrade);
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            Assert.Equal("Cross-origin request refused.", await refused.Content.ReadAsStringAsync());
        }
        client.DefaultRequestHeaders.Remove("Sec-Fetch-Site");
        client.DefaultRequestHeaders.Add("Sec-Fetch-Site", "same-origin");
        client.DefaultRequestHeaders.Add("X-Forwarded-Host", "beta.tenants.example");
        Assert.Equal(HttpStatusCode.Forbidden, await Send(new UriBuilder(primary) { Host = "beta.tenants.example" }.Uri.GetLeftPart(UriPartial.Authority)));
        await harness.Database.ExecuteOwnerAsync($"UPDATE tenant_hostnames SET tenant_id={beta.Id} WHERE hostname='brand.tenants.example'");
        mapping.Invalidate();
        Assert.Equal(HttpStatusCode.Forbidden, await Send(alias));
    }
}
