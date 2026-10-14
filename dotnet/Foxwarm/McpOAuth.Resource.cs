using System.Net;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;

namespace Foxwarm;

internal sealed partial class McpOAuthService
{
    private JsonObject RequireGrant(string name, JsonObject config)
    {
        var grant = Load()[name] as JsonObject;
        if (!Matches(grant, config) || grant?["tokens"] is not JsonObject)
            throw Error(
                "needs-authorization",
                "This MCP server needs administrator authorization in Setup → Authorizations."
            );
        return grant!;
    }

    private void InvalidateGrant(string name, JsonObject grant, string message)
    {
        var next = Copy(grant);
        next.Remove("tokens");
        next.Remove("expiresAt");
        next["error"] = message;
        epochs[name] = Epoch(name) + 1;
        ClearFlows(name);
        try
        {
            Save(name, next);
        }
        finally
        {
            closeConnections(name);
        }
    }

    private async Task<JsonObject> AccessAsync(
        string name,
        JsonObject config,
        long epoch,
        CancellationToken token
    )
    {
        lock (gate)
        {
            Current(name, config, epoch);
            var grant = RequireGrant(name, config);
            if (
                Sessions.SessionWait.Number(grant["expiresAt"]) is not { } expires
                || expires > Now + (grant["tokens"]?["refresh_token"] is not null ? 5000 : 0)
            )
                return Copy(grant["tokens"]!.AsObject());
        }
        return await RefreshAsync(name, config, epoch, null, token);
    }

    private Task<JsonObject> RefreshAsync(
        string name,
        JsonObject config,
        long epoch,
        string? rejectedToken,
        CancellationToken token
    )
    {
        Renewal renewal;
        var start = false;
        lock (gate)
        {
            Current(name, config, epoch);
            if (!refreshing.TryGetValue(name, out renewal!) || renewal.Epoch != epoch)
            {
                renewal = new(epoch, new(TaskCreationOptions.RunContinuationsAsynchronously));
                refreshing[name] = renewal;
                renewals.Add(renewal.Completion.Task);
                start = true;
            }
        }
        if (start)
            _ = RenewAsync(name, config, renewal, rejectedToken);
        return renewal.Completion.Task.WaitAsync(token);
    }

    // Caller Stop releases its waiter, not another caller's same-grant renewal.
    private async Task RenewAsync(
        string name,
        JsonObject config,
        Renewal renewal,
        string? rejectedToken
    )
    {
        try
        {
            JsonObject captured;
            lock (gate)
            {
                Current(name, config, renewal.Epoch);
                captured = Copy(RequireGrant(name, config));
                if (
                    rejectedToken is not null
                    && Text(captured["tokens"]?["access_token"]) != rejectedToken
                )
                {
                    renewal.Completion.TrySetResult(Copy(captured["tokens"]!.AsObject()));
                    return;
                }
                if (Text(captured["tokens"]?["refresh_token"]) is not { Length: > 0 })
                {
                    InvalidateGrant(name, captured, "Authorize again to renew access.");
                    throw Error(
                        "needs-authorization",
                        "This MCP server needs administrator reauthorization."
                    );
                }
            }
            try
            {
                var tokens = await TokenRequestAsync(
                    config,
                    captured,
                    new Dictionary<string, string>
                    {
                        ["grant_type"] = "refresh_token",
                        ["refresh_token"] = Text(captured["tokens"]?["refresh_token"])!,
                        ["resource"] = Text(
                            captured["discovery"]?["resourceMetadata"]?["resource"]
                        )!,
                    },
                    shutdown
                );
                if (!tokens.ContainsKey("refresh_token"))
                    tokens["refresh_token"] = captured["tokens"]!["refresh_token"]!.DeepClone();
                Remember(Text(tokens["access_token"]), Text(tokens["refresh_token"]));
                lock (gate)
                {
                    Current(name, config, renewal.Epoch);
                    // Consent preparation may have replaced discovery/registration, not this account grant.
                    var next = WithTokens(RequireGrant(name, config), tokens);
                    Save(name, next);
                    renewal.Completion.TrySetResult(Copy(next["tokens"]!.AsObject()));
                }
            }
            catch (McpOAuthException error) when (error.Code is "invalid_grant" or "invalid_client")
            {
                lock (gate)
                {
                    Current(name, config, renewal.Epoch);
                    InvalidateGrant(
                        name,
                        RequireGrant(name, config),
                        "Authorization expired or was revoked. Authorize again."
                    );
                }
                throw;
            }
        }
        catch (Exception error)
        {
            renewal.Completion.TrySetException(SafeError(error));
        }
        finally
        {
            lock (gate)
            {
                if (refreshing.GetValueOrDefault(name) == renewal)
                    refreshing.Remove(name);
                renewals.Remove(renewal.Completion.Task);
            }
        }
    }

    internal async Task DrainAsync()
    {
        Task[] tasks;
        lock (gate)
            tasks = renewals.ToArray();
        try
        {
            await Task.WhenAll(tasks);
        }
        catch { }
    }

    internal HttpClient ResourceClient(string name, JsonObject config)
    {
        long epoch;
        lock (gate)
        {
            epoch = Epoch(name);
            Current(name, config, epoch);
        }
        return new HttpClient(new ResourceHandler(this, name, Copy(config), epoch))
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
    }

    private sealed class ResourceHandler(
        McpOAuthService service,
        string name,
        JsonObject config,
        long epoch
    ) : DelegatingHandler(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false })
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken token
        )
        {
            var endpoint =
                request.RequestUri ?? throw Error("resource", "MCP resource endpoint is missing.");
            if (!McpOAuthHttp.SameOrigin(endpoint, new Uri(Text(config["url"])!)))
                throw Error("resource", "MCP credentials cannot be sent to another server.");
            var tokens = await service.AccessAsync(name, config, epoch, token);
            // HTTP request bytes are captured before sending. Only a pre-dispatch Bearer 401 can use them again.
            var bytes = request.Content is not null
                ? await request.Content.ReadAsByteArrayAsync(token)
                : null;
            void SelectCredentials(HttpRequestMessage selected)
            {
                lock (service.gate)
                {
                    service.Current(name, config, epoch);
                    var grant = service.RequireGrant(name, config);
                    service.Remember(
                        Text(tokens["access_token"]),
                        Text(tokens["refresh_token"]),
                        Text(config["oauth"]?["clientSecret"]),
                        Text(grant["clientInformation"]?["client_secret"])
                    );
                }
                selected.Headers.Authorization = new AuthenticationHeaderValue(
                    "Bearer",
                    Text(tokens["access_token"])!
                );
            }
            SelectCredentials(request);
            var response = await base.SendAsync(request, token);
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                var standard = response.Headers.WwwAuthenticate.Any(header =>
                    header.Scheme.Equals("Bearer", StringComparison.OrdinalIgnoreCase)
                );
                response.Dispose();
                if (!standard)
                    throw Error(
                        "needs-authorization",
                        "MCP authorization was rejected without a Bearer challenge. Review Authorizations."
                    );
                tokens = await service.RefreshAsync(
                    name,
                    config,
                    epoch,
                    Text(tokens["access_token"]),
                    token
                );
                using var retry = new HttpRequestMessage(request.Method, request.RequestUri)
                {
                    Version = request.Version,
                    VersionPolicy = request.VersionPolicy,
                };
                foreach (var header in request.Headers)
                    if (!header.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase))
                        retry.Headers.TryAddWithoutValidation(header.Key, header.Value);
                if (bytes is not null)
                {
                    retry.Content = new ByteArrayContent(bytes);
                    foreach (var header in request.Content!.Headers)
                        retry.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
                }
                SelectCredentials(retry);
                response = await base.SendAsync(retry, token);
                if (response.StatusCode == HttpStatusCode.Unauthorized)
                {
                    response.Dispose();
                    lock (service.gate)
                    {
                        service.Current(name, config, epoch);
                        service.InvalidateGrant(
                            name,
                            service.RequireGrant(name, config),
                            "Authorization was rejected. Authorize again."
                        );
                    }
                    throw Error(
                        "needs-authorization",
                        "MCP authorization was rejected. Ask an administrator to authorize again."
                    );
                }
            }
            if ((int)response.StatusCode is >= 300 and < 400)
            {
                response.Dispose();
                throw Error("resource", "Authenticated MCP resource requests must not redirect.");
            }
            if (response.StatusCode == HttpStatusCode.Forbidden)
            {
                var header = string.Join(
                    ", ",
                    response.Headers.WwwAuthenticate.Select(value => value.ToString())
                );
                var scope = McpOAuthHttp.Challenge(header, "error") == "insufficient_scope";
                response.Dispose();
                if (scope)
                {
                    lock (service.gate)
                    {
                        service.Current(name, config, epoch);
                        var grant = Copy(service.RequireGrant(name, config));
                        var required = SafeScope(McpOAuthHttp.Challenge(header, "scope"));
                        if (required is not null)
                            grant["requiredScope"] = required;
                        grant["error"] =
                            "Additional access is required. Review the scopes and authorize again.";
                        service.Save(name, grant);
                    }
                    throw Error(
                        "scope",
                        "Additional MCP access requires administrator authorization in Setup → Authorizations."
                    );
                }
                throw Error(
                    "authorization",
                    "MCP access was forbidden. Review the server authorization settings."
                );
            }
            return response;
        }
    }
}
