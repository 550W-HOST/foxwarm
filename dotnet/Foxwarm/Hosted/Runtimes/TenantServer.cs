using Microsoft.AspNetCore.Connections.Features;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core.Features;

namespace Foxwarm.Hosted.Runtimes;

/// <summary>
/// The server of a tenant runtime's <c>WebApplication</c> inside a replica that hosts several
/// tenants: it has no listener. The replica's front server receives every request and hands it
/// to the tenant's pipeline with <see cref="DispatchAsync"/>.
/// </summary>
/// <remarks>
/// The tenant pipeline runs over its own feature collection. The front's transport features
/// (request, response and its body, abort, upgrade, connection, size limits, trailers, reset)
/// are forwarded deliberately; endpoint, routing values, the DI scope, items, the user and
/// every cache built on the request (query, cookies, form) are the tenant context's own. Sharing
/// the front's whole collection would let the tenant resolve the front's scoped services and
/// reuse the endpoint the front's routing selected.
/// </remarks>
internal sealed class TenantServer : IServer
{
    // Features of the front request that carry the transport; everything else stays per context.
    private static readonly Type[] Forwarded =
    [
        typeof(IHttpRequestFeature),
        typeof(IHttpResponseFeature),
        typeof(IHttpResponseBodyFeature),
        typeof(IHttpRequestBodyDetectionFeature),
        typeof(IHttpRequestLifetimeFeature),
        typeof(IHttpRequestIdentifierFeature),
        typeof(IHttpConnectionFeature),
        typeof(IHttpUpgradeFeature),
        typeof(IHttpExtendedConnectFeature),
        typeof(IHttpMaxRequestBodySizeFeature),
        typeof(IHttpBodyControlFeature),
        typeof(IHttpRequestTrailersFeature),
        typeof(IHttpResponseTrailersFeature),
        typeof(IHttpResetFeature),
        typeof(ITlsConnectionFeature),
        typeof(ITlsHandshakeFeature),
        typeof(IHttpMinRequestBodyDataRateFeature),
        typeof(IHttpMinResponseDataRateFeature),
        typeof(IConnectionItemsFeature),
        typeof(IHttpActivityFeature),
    ];

    private readonly object gate = new();
    private Func<IFeatureCollection, Task>? application;
    private readonly HashSet<IFeatureCollection> inFlight = new(ReferenceEqualityComparer.Instance);
    private bool stopping;
    private TaskCompletionSource drained = NewSignal();

    /// <param name="publicUrl">The address the tenant's own URLs are built from: the front's.</param>
    internal TenantServer(string publicUrl)
    {
        PublicUrl = new Uri(publicUrl);
        var addresses = new ServerAddressesFeature();
        addresses.Addresses.Add(publicUrl);
        Features.Set<IServerAddressesFeature>(addresses);
    }

    internal TenantServer(string publicUrl, HostnameDirectory directory, int tenantId) : this(publicUrl)
    {
        OwnsHostname = async (host, token) => (await directory.ResolveAsync(host, token).ConfigureAwait(false))?.Id == tenantId;
    }

    internal Func<string, CancellationToken, Task<bool>>? OwnsHostname { get; }
    internal Uri PublicUrl { get; }

    internal MainLog? Log { private get; set; }

    public IFeatureCollection Features { get; } = new FeatureCollection();

    /// <summary>The tenant's application has started and isn't stopping.</summary>
    internal bool Serving
    {
        get
        {
            lock (gate)
                return application is not null && !stopping;
        }
    }

    public Task StartAsync<TContext>(IHttpApplication<TContext> app, CancellationToken cancellationToken)
        where TContext : notnull
    {
        lock (gate)
        {
            if (application is not null)
                throw new InvalidOperationException("The tenant server has already started.");
            application = features => RunAsync(app, features);
        }
        return Task.CompletedTask;
    }

    /// <summary>
    /// Runs one front request through the tenant's pipeline. Returns false, before anything of
    /// the request is consumed, when the tenant isn't serving (not started, or stopping).
    /// </summary>
    internal async Task<bool> DispatchAsync(IFeatureCollection front)
    {
        Func<IFeatureCollection, Task> run;
        lock (gate)
        {
            if (application is null || stopping)
                return false;
            run = application;
            inFlight.Add(front);
        }
        try
        {
            await run(Overlay(front)).ConfigureAwait(false);
            return true;
        }
        finally
        {
            lock (gate)
            {
                inFlight.Remove(front);
                if (inFlight.Count == 0 && stopping)
                    drained.TrySetResult();
            }
        }
    }

    // ASP.NET's own hosting contract: one context per request, disposed with the outcome.
    private async Task RunAsync<TContext>(IHttpApplication<TContext> app, IFeatureCollection features)
        where TContext : notnull
    {
        Log?.UseFor();
        var context = app.CreateContext(features);
        Exception? failure = null;
        try
        {
            await app.ProcessRequestAsync(context).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            failure = error;
            throw;
        }
        finally
        {
            app.DisposeContext(context, failure);
        }
    }

    internal static IFeatureCollection Overlay(IFeatureCollection front)
    {
        var features = new FeatureCollection();
        foreach (var type in Forwarded)
            if (front[type] is { } feature)
                features[type] = feature;
        return features;
    }

    /// <summary>
    /// Refuses new dispatch, then waits for requests in progress until <paramref name="cancellationToken"/>
    /// (the host's shutdown timeout) and aborts the requests still running then, as Kestrel
    /// aborts its connections. The front's other requests aren't affected.
    /// </summary>
    public async Task StopAsync(CancellationToken cancellationToken)
    {
        Task wait;
        lock (gate)
        {
            stopping = true;
            if (inFlight.Count == 0)
                return;
            wait = drained.Task;
        }
        try
        {
            await wait.WaitAsync(cancellationToken).ConfigureAwait(false);
            return;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        IFeatureCollection[] remaining;
        lock (gate)
            remaining = [.. inFlight];
        foreach (var request in remaining)
            request.Get<IHttpRequestLifetimeFeature>()?.Abort();
        // Aborted requests unwind on their own; their dispatch returns when they have.
        await wait.WaitAsync(TimeSpan.FromSeconds(5)).ContinueWith(_ => { }, TaskScheduler.Default).ConfigureAwait(false);
    }

    public void Dispose()
    {
        lock (gate)
            stopping = true;
    }

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private sealed class ServerAddressesFeature : IServerAddressesFeature
    {
        public ICollection<string> Addresses { get; } = new List<string>();
        public bool PreferHostingUrls { get; set; }
    }
}
