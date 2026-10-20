using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Routing;

namespace Foxwarm.Channels.WebUi;

internal sealed class WebUiAccessException()
    : InvalidOperationException("WebUI identity session binding changed.");

internal sealed class WebUiAccess(SessionRuntime runtime, AccessConfiguration configuration)
    : IDisposable
{
    private readonly ConcurrentDictionary<HttpContext, WebUiRequest> requests = new();
    private readonly ConcurrentDictionary<string, UploadOwner> uploads = new(
        StringComparer.Ordinal
    );

    private sealed record UploadOwner(string IdentityId, string Token, string SessionId);

    private static readonly object RequestKey = new();

    internal static WebUiRequest? Request(HttpContext context) =>
        context.Items.TryGetValue(RequestKey, out var value) ? value as WebUiRequest : null;

    internal static WebUiRequest? Request(HttpRequest request) => Request(request.HttpContext);

    internal void Start()
    {
        configuration.Changed += Revoke;
        runtime.TopologyChanged += CheckBindings;
    }

    public void Dispose()
    {
        configuration.Changed -= Revoke;
        runtime.TopologyChanged -= CheckBindings;
    }

    internal string? Canonical(string id) =>
        SessionCatalog.Text(runtime.Catalog.Resolve(id)["sessionId"]);

    internal bool Allows(AccessIdentity identity, string requested)
    {
        var id = Canonical(requested);
        if (id is null)
            return false;
        var row = runtime.Catalog.Get(id);
        if (row is null)
            return false;
        return identity.Sessions.Any(binding =>
            AccessConfiguration.ScopeAgent(binding) is { } agent
                ? SessionCatalog.Text(row["agent"]) == agent
                : Canonical(binding) == id
        );
    }

    internal string[] Project(AccessIdentity identity) =>
        identity
            .Sessions.SelectMany(binding =>
                AccessConfiguration.ScopeAgent(binding) is { } agent
                    ? runtime
                        .Catalog.OffsetPage(int.MaxValue, 0, agent)
                        .Select(row => SessionCatalog.Text(row["id"])!)
                        .ToArray()
                : Canonical(binding) is { } id ? new[] { id }
                : []
            )
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    internal WebUiRequest? Authenticate(HttpContext context)
    {
        string? token = null;
        if (
            context.Request.Headers.Authorization.Count == 1
            && context
                .Request.Headers.Authorization.ToString()
                .StartsWith("Bearer ", StringComparison.Ordinal)
        )
            token = context.Request.Headers.Authorization.ToString()[7..].Trim();
        token ??= context.Request.Cookies["foxwarm_token"];
        if (configuration.Authenticate(token) is not { } verified)
            return null;
        var request = new WebUiRequest(this, configuration, verified.Id, verified.Identity);
        context.Items[RequestKey] = request;
        return request;
    }

    // Explicit allowlist: all newly added endpoints remain administrator-only.
    internal static bool BrowserRoute(HttpContext context)
    {
        if (
            context.Request.Method == "GET"
            && (
                context.Request.Path is { Value: "/" or "/login.html" }
                || context.Request.Path.StartsWithSegments("/assets")
            )
        )
            return true;
        var route = (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText;
        return (context.Request.Method, route) switch
        {
            (
                "GET",
                "/api/auth/session"
                    or "/api/sessions"
                    or "/api/webui/stream"
                    or "/api/sessions/{id}/artifacts/{artifactId}/{revision}"
                    or "/api/sessions/{id}/artifacts/{artifactId}/{revision}/resources/{resource}"
                    or "/api/sessions/{id}/history"
                    or "/api/sessions/{id}/history/continuous"
                    or "/api/sessions/{id}/stream"
            ) => true,
            (
                "POST",
                "/api/upload"
                    or "/api/sessions/{id}/message"
                    or "/api/sessions/{id}/blobs/{blobId}/download"
            ) => true,
            ("GET" or "HEAD", "/api/sessions/{id}/blobs/{blobId}") => true,
            _ => false,
        };
    }

    internal IDisposable Track(HttpContext context, WebUiRequest request)
    {
        requests[context] = request;
        return new Registration(() => requests.TryRemove(context, out _));
    }

    private sealed class Registration(Action dispose) : IDisposable
    {
        public void Dispose() => dispose();
    }

    private void CheckBindings()
    {
        foreach (var (context, request) in requests)
            if (!request.Current || !request.BindingsCurrent())
                context.Abort();
    }

    private Task Revoke(AccessChange change)
    {
        foreach (var (context, request) in requests)
            if (change.WebUi.Contains(request.IdentityId))
                context.Abort();
        var failures = new List<Exception>();
        foreach (var (path, owner) in uploads)
        {
            if (!change.WebUi.Contains(owner.IdentityId))
                continue;
            if (
                change.Current.TryGetValue(owner.IdentityId, out var current)
                && current.Token == owner.Token
                && current.WebUi
                && Allows(current, owner.SessionId)
            )
                continue;
            if (uploads.TryRemove(path, out _))
                try
                {
                    File.Delete(path);
                }
                catch (Exception error)
                {
                    failures.Add(error);
                }
        }
        return failures.Count == 0
            ? Task.CompletedTask
            : Task.FromException(new AggregateException(failures));
    }

    internal void RegisterUpload(WebUiRequest request, string session, string path)
    {
        request.Require(session);
        uploads[path] = new(request.IdentityId, request.Identity.Token, session);
        // Publication and revocation are synchronous; a concurrent change must not leave stale authority.
        if (!request.Current)
        {
            uploads.TryRemove(path, out _);
            File.Delete(path);
            throw new WebUiAccessException();
        }
    }

    internal void RequireUpload(WebUiRequest request, string session, string path)
    {
        request.Require(session);
        if (
            !uploads.TryGetValue(path, out var owner)
            || owner.IdentityId != request.IdentityId
            || owner.Token != request.Identity.Token
            || Canonical(owner.SessionId) != Canonical(session)
            || !Allows(request.Identity, owner.SessionId)
        )
            throw new WebUiAccessException();
    }

    internal void ConsumeUpload(string path) => uploads.TryRemove(path, out _);

    internal static JsonObject Features(bool admin) =>
        new()
        {
            ["chat"] = true,
            ["attachments"] = true,
            ["commands"] = admin,
            ["terminal"] = admin,
            ["workspace"] = admin,
            ["setup"] = admin,
            ["settings"] = admin,
            ["sessionManagement"] = admin,
            ["debug"] = admin,
            ["modelSelection"] = admin,
            ["sidebar"] = admin,
        };

    internal JsonObject SafeSession(JsonObject source)
    {
        var result = new JsonObject();
        foreach (
            var key in new[]
            {
                "id",
                "agent",
                "aliases",
                "busy",
                "busyStartedAt",
                "queueLength",
                "messageCount",
                "historyVersion",
                "runtimeState",
                "displayName",
                "archived",
                "currentNode",
                "cwd",
                "model",
                "modelKey",
                "defaultModelKey",
                "effort",
                "effectiveEffort",
                "effortAllowed",
                "effortDefault",
                "isolated",
                "childModelDefault",
                "childModelPolicySource",
                "childPolicyChain",
                "effectiveChildModelKey",
                "childEffortDefault",
                "effectiveChildEffort",
                "childEffortAllowed",
                "childModelEffortDefault",
            }
        )
            if (source.ContainsKey(key))
                result[key] = source[key]?.DeepClone();
        var id = SessionCatalog.Text(source["id"]);
        var row = id is null ? null : runtime.Catalog.Get(id);
        result["aliases"] = row?["aliases"]?.DeepClone() ?? new JsonArray();
        result["archived"] = row is not null && SessionCatalog.Flag(row["archived"]);
        result["isolated"] = runtime.Manager.AgentIsolated(
            SessionCatalog.Text(row?["agent"] ?? source["agent"]) ?? "main"
        );
        return result;
    }
}

internal sealed class WebUiRequest(
    WebUiAccess access,
    AccessConfiguration configuration,
    string identityId,
    AccessIdentity identity
)
{
    private readonly ConcurrentDictionary<string, string> bindings = new(StringComparer.Ordinal);
    internal string IdentityId => identityId;
    internal AccessIdentity Identity => identity;
    internal bool Current => configuration.Current(identityId, identity);

    internal bool Allows(string id) => Current && access.Allows(identity, id);

    internal bool BindingsCurrent() =>
        bindings.All(pair => Allows(pair.Key) && access.Canonical(pair.Key) == pair.Value);

    internal void ResetBindings() => bindings.Clear();

    internal string Bind(string requested)
    {
        Require(requested);
        var canonical = access.Canonical(requested)!;
        bindings[requested] = canonical;
        return canonical;
    }

    internal void Require(string? id = null)
    {
        if (!Current || !BindingsCurrent() || id is not null && !Allows(id))
            throw new WebUiAccessException();
    }

    internal JsonObject AuthPayload() =>
        new()
        {
            ["role"] = "webui",
            ["identityId"] = identityId,
            ["sessionIds"] = new JsonArray(
                access.Project(identity).Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
            ),
            ["features"] = WebUiAccess.Features(false),
        };

    internal JsonObject Session(JsonObject source) => access.SafeSession(source);

    internal void RegisterUpload(string session, string path) =>
        access.RegisterUpload(this, session, path);

    internal void RequireUpload(string session, string path) =>
        access.RequireUpload(this, session, path);

    internal void ConsumeUpload(string path) => access.ConsumeUpload(path);
}
