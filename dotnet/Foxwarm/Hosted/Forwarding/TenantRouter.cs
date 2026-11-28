using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Runtimes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Yarp.ReverseProxy.Forwarder;

namespace Foxwarm.Hosted.Forwarding;

/// <summary>The public edge resolves and retries. A mesh receiver either dispatches locally or declines.</summary>
internal sealed class TenantRouter(string boot, MeshAuthentication authentication, RouteDirectory directory,
    ReplicaRegistry registry, TenantActivations activations, HostnameDirectory hosts, LeaseTimings timings,
    Func<TenantGeneration, HttpContext, Task> dispatch, Func<bool> hasCapacity, Action<string> log, CancellationToken processStop) : IDisposable
{
    private readonly SemaphoreSlim queue = new(2048);
    private readonly SemaphoreSlim buffers = new(2048);
    private readonly MeshTransport transport = new(authentication);
    private readonly object gate = new();
    private readonly Dictionary<string, Task<TenantRouteState?>> reads = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource stopping = new();

    internal void EndHoldsAfter(TimeSpan bound) => stopping.CancelAfter(bound);

    private Task<TenantRouteState?> ReadAsync(string slug, CancellationToken token)
    {
        lock (gate)
        {
            if (!reads.TryGetValue(slug, out var read) || read.IsCompleted)
            {
                reads[slug] = read = SharedReadAsync(slug);
                _ = read.ContinueWith(done =>
                {
                    _ = done.Exception;
                    lock (gate)
                        if (reads.GetValueOrDefault(slug) == done)
                            reads.Remove(slug);
                }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
            }
            return read.WaitAsync(token);
        }
    }

    private async Task<TenantRouteState?> SharedReadAsync(string slug)
    {
        using var bound = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
        bound.CancelAfter(timings.Ttl);
        return await directory.ReadAsync(slug, bound.Token).ConfigureAwait(false);
    }

    internal async Task MeshAsync(HttpContext context)
    {
        var request = context.Request;
        var attempt = authentication.Accept(request, out var full);
        if (attempt is null)
        {
            context.Response.StatusCode = full ? StatusCodes.Status503ServiceUnavailable : StatusCodes.Status403Forbidden;
            if (!full) context.Response.Headers["Foxwarm-Mesh-Rejected"] = "1";
            return;
        }
        MeshAuthentication.StripControlHeaders(request.Headers);
        var slug = await hosts.ResolveAsync(request.Host.Host, context.RequestAborted).ConfigureAwait(false);
        if (slug != attempt.Tenant)
        {
            Refuse(context, attempt);
            return;
        }
        if (attempt.Purpose == "activate")
        {
            if (request.Method != "POST" || MeshAuthentication.RawTarget(request) != "/" || !MayActivate(slug))
            {
                Refuse(context, attempt);
                return;
            }
            try
            {
                await activations.ActivateAsync(slug, token: context.RequestAborted).ConfigureAwait(false);
                context.Response.StatusCode = StatusCodes.Status204NoContent;
            }
            catch (Exception error) when (!context.RequestAborted.IsCancellationRequested)
            {
                LogActivation(slug, error);
                Refuse(context, attempt);
            }
            return;
        }
        if (activations.TryAdmitExact(slug, attempt.Epoch!.Value, attempt.Receiver) is not { } exact)
        {
            Refuse(context, attempt);
            return;
        }
        // A tenant application never supplies mesh-control response metadata to the edge.
        context.Response.OnStarting(() => { MeshAuthentication.StripControlHeaders(context.Response.Headers); return Task.CompletedTask; });
        using (exact.Admission)
            await dispatch(exact.Generation, context).ConfigureAwait(false);
    }

    private void Refuse(HttpContext context, MeshAttempt attempt)
    {
        context.Response.StatusCode = StatusCodes.Status421MisdirectedRequest;
        context.Response.Headers[MeshAuthentication.Refusal] = authentication.Refuse(attempt);
    }

    internal async Task PublicAsync(HttpContext context, IHttpForwarder forwarder)
    {
        var request = context.Request;
        MeshAuthentication.StripControlHeaders(request.Headers);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, stopping.Token);
        budget.CancelAfter(timings.Ttl);
        int held = 0;
        bool Enter()
        {
            if (!queue.Wait(0)) return false;
            held = 1;
            return true;
        }
        void EndHold() { if (Interlocked.Exchange(ref held, 0) != 0) queue.Release(); }
        if (!Enter()) { context.Response.StatusCode = 503; return; }
        var originalBody = request.Body;
        ForwardedBody? body = null;
        var reservedBuffer = false;
        var dispatched = false;
        try
        {
            var slug = await hosts.ResolveAsync(request.Host.Host, budget.Token).ConfigureAwait(false);
            if (slug is null) { context.Response.StatusCode = 404; return; }
            var hasBody = context.Features.Get<IHttpRequestBodyDetectionFeature>()?.CanHaveBody
                ?? (request.ContentLength > 0 || request.Headers.ContainsKey("Transfer-Encoding"));
            while (!budget.IsCancellationRequested)
            {
                if (await hosts.ResolveAsync(request.Host.Host, budget.Token).ConfigureAwait(false) != slug)
                {
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }
                var state = await ReadAsync(slug, budget.Token).ConfigureAwait(false);
                if (state is not { Available: true }) break;
                var route = state.Owner;
                if (route is null)
                    route = await ActivateAsync(slug, state, request.Host.Value, budget.Token).ConfigureAwait(false);
                if (route is not null && !state.Draining)
                {
                    if (await hosts.ResolveAsync(request.Host.Host, budget.Token).ConfigureAwait(false) != slug)
                    {
                        context.Response.StatusCode = StatusCodes.Status404NotFound;
                        return;
                    }
                    // A previously forwarded upload has already used the public body feature.
                    // Even if the next owner is this boot, enter its mesh listener with a fresh
                    // owner-side limit and a body the selected route can configure before reading.
                    if (route.Boot == boot && body is null)
                    {
                        if (activations.TryAdmitExact(slug, route.Epoch, route.Boot) is { } local)
                        {
                            using (local.Admission)
                            {
                                EndHold();
                                dispatched = true;
                                await dispatch(local.Generation, context).ConfigureAwait(false);
                            }
                            return;
                        }
                    }
                    else if (route.MeshAddress is not null)
                    {
                        if (hasBody && body is null)
                        {
                            // Only the owner's route knows whether to keep its normal default.
                            if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } size)
                                size.MaxRequestBodySize = null;
                            if (request.ContentLength is null or <= ForwardedBody.Limit)
                            {
                                reservedBuffer = buffers.Wait(0);
                                if (!reservedBuffer) break;
                            }
                            request.Body = body = new ForwardedBody(originalBody, request.ContentLength, reservedBuffer);
                        }
                        var outcome = await transport.DispatchAsync(context, forwarder, route, slug, budget.Token, EndHold).ConfigureAwait(false);
                        if (outcome == DispatchOutcome.Completed) return;
                        if (body is not null && !body.RewindIfAvailable()) break;
                        if (held == 0 && !Enter()) break;
                    }
                }
                await Task.Delay(TimeSpan.FromMilliseconds(100), budget.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (budget.IsCancellationRequested && !dispatched) { }
        catch (Exception error) when (!dispatched && !context.Response.HasStarted)
        {
            log("[hosted] Tenant route unavailable: " + error.GetType().Name);
        }
        finally
        {
            EndHold();
            request.Body = originalBody;
            body?.Dispose();
            if (reservedBuffer) buffers.Release();
        }
        if (!context.RequestAborted.IsCancellationRequested) context.Response.StatusCode = 503;
    }

    /// <summary>A scanner may claim locally at rank one, or at any eligible rank after grace.
    /// The caller activates with its original cause. A current lease always wins.</summary>
    internal async Task<bool> MayStartAutonomousAsync(string slug, bool graceElapsed, CancellationToken token)
    {
        if (processStop.IsCancellationRequested || !hasCapacity()) return false;
        var state = await ReadAsync(slug, token).ConfigureAwait(false);
        if (state is not { Available: true, Owner: null }) return false;
        var candidates = await CandidatesAsync(slug, state, token).ConfigureAwait(false);
        return graceElapsed ? candidates.Any(candidate => candidate.Replica == boot)
            : candidates.Count > 0 && candidates[0].Replica == boot;
    }

    private async Task<IReadOnlyList<ReplicaRow>> CandidatesAsync(string slug, TenantRouteState state, CancellationToken token)
    {
        var live = await registry.LiveAsync(timings.Ttl, token).ConfigureAwait(false);
        var candidates = Placement.Candidates(slug, state.Profile, state.Pin, live, row => row.ReaderVersion >= state.ReaderFloor && (row.Replica == boot || row.MeshAddress != null));
        if (state.ExcludedBoot is null) return candidates;
        var alternatives = candidates.Where(row => row.Replica != state.ExcludedBoot && row.MeshAddress != null).ToArray();
        if (alternatives.Length != 0) return alternatives;
        // The last alternative disappeared after hand-back. Lift just this epoch’s exclusion.
        return await directory.CancelUnavailableMoveAsync(state, token).ConfigureAwait(false) ? candidates : [];
    }

    private async Task<DispatchRoute?> ActivateAsync(string slug, TenantRouteState state, string host, CancellationToken token)
    {
        var candidates = await CandidatesAsync(slug, state, token).ConfigureAwait(false);
        foreach (var candidate in candidates)
        {
            token.ThrowIfCancellationRequested();
            using var attempt = CancellationTokenSource.CreateLinkedTokenSource(token);
            attempt.CancelAfter(timings.RenewInterval);
            try
            {
                if (candidate.Replica == boot && MayActivate(slug))
                {
                    var generation = await activations.ActivateAsync(slug, token: attempt.Token).ConfigureAwait(false);
                    return new(boot, generation.Id.Epoch, candidate.MeshAddress);
                }
                if (candidate.Replica != boot && candidate.MeshAddress is not null)
                    await transport.ActivateAsync(candidate.MeshAddress, candidate.Replica, slug, host, attempt.Token).ConfigureAwait(false);
            }
            catch (Exception error) when (!token.IsCancellationRequested)
            {
                if (candidate.Replica == boot) LogActivation(slug, error);
            }
            var updated = await ReadAsync(slug, token).ConfigureAwait(false);
            if (updated is not { Available: true, Draining: false }) return null;
            if (updated.Owner is { } owner) return owner;
        }
        return null;
    }

    private bool MayActivate(string slug) => !processStop.IsCancellationRequested && (activations.Current(slug) is not null || hasCapacity());

    private void LogActivation(string slug, Exception error)
    {
        if (error is not (TenantHeldElsewhereException or ObjectDisposedException or OperationCanceledException))
            log($"[hosted] Tenant {slug} couldn't be activated: {error.GetType().Name}.");
    }

    public void Dispose()
    {
        stopping.Cancel();
        transport.Dispose();
        stopping.Dispose();
    }
}
