using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System.Net;
using Foxwarm.Hosted.Runtimes;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// A replica front for tests: one Kestrel listener with its own routing and scoped services,
/// dispatching each request by <c>Host</c> to a tenant's <see cref="TenantServer"/>. The
/// product front (with placement and forwarding) comes with the runtimes host; this one has
/// exactly the parts that a tenant pipeline must not see through.
/// </summary>
internal sealed class TenantFront : IAsyncDisposable
{
    private readonly WebApplication app;
    private readonly Dictionary<string, TenantServer> tenants = new(StringComparer.OrdinalIgnoreCase);

    private TenantFront(WebApplication app) => this.app = app;

    internal Uri BaseUri => new(app.Urls.Single());

    /// <summary>The front's scoped service: resolved for every request before dispatch.</summary>
    internal sealed class FrontMarker
    {
        internal string Name => "front";
    }

    internal static async Task<TenantFront> StartAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        // As the Main server's own listener (HttpServer); tenant routes raise it per request.
        builder.WebHost.ConfigureKestrel(server => server.Limits.MaxRequestBodySize = 2 * 1024 * 1024);
        builder.Services.AddScoped<FrontMarker>();
        var app = builder.Build();
        var front = new TenantFront(app);
        app.Use(
            async (context, next) =>
            {
                // The front's DI scope exists before dispatch.
                _ = context.RequestServices.GetRequiredService<FrontMarker>();
                await next();
            }
        );
        app.UseRouting();
        app.MapGet("/front/marker", () => "front");
        // The front's routing selects this endpoint for every tenant request.
        app.MapFallback(async context =>
        {
            var host = context.Request.Host.Host;
            TenantServer? server;
            lock (front.tenants)
                front.tenants.TryGetValue(host, out server);
            if (server is null || !await server.DispatchAsync(context.Features))
                context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        });
        await app.StartAsync();
        return front;
    }

    internal TenantServer Server(string host)
    {
        var server = new TenantServer(BaseUri.ToString().TrimEnd('/'));
        lock (tenants)
            tenants[host] = server;
        return server;
    }

    internal HttpClient Client(string host, string? token = null)
    {
        var client = new HttpClient(
            new HttpClientHandler { UseProxy = false, AutomaticDecompression = DecompressionMethods.None }
        )
        {
            BaseAddress = BaseUri,
            Timeout = TimeSpan.FromSeconds(30),
        };
        client.DefaultRequestHeaders.Host = host;
        if (token is not null)
            client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return client;
    }

    public async ValueTask DisposeAsync() => await app.DisposeAsync();
}
