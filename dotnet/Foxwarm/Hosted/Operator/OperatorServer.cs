using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Foxwarm.Limits;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Hosted.Operator;

internal sealed record OperatorListener(Uri Origin, IPEndPoint Endpoint, DeploymentConfiguration Deployment)
{
    internal static OperatorListener From(DeploymentConfiguration deployment)
    {
        var listener = ReadSettings(deployment);
        var template = (string?)deployment.Root["url"];
        if (template is null || !template[(template.IndexOf("://", StringComparison.Ordinal) + 3)..].StartsWith("{slug}.", StringComparison.Ordinal))
            throw new HostedBootstrapException("The operator service needs a tenant URL template whose first hostname label is {slug}.");
        return listener;
    }

    internal static OperatorListener ReadSettings(DeploymentConfiguration deployment)
    {
        if (deployment.Root["operator"] is not JsonObject settings || settings.Any(x => x.Key is not ("url" or "port"))
            || settings["url"] is not JsonValue origin || !origin.TryGetValue<string>(out var text)
            || !Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http")
            || uri.AbsolutePath != "/" || uri.UserInfo != "" || uri.Query != "" || uri.Fragment != ""
            || Sessions.SessionWait.Number(settings["port"]) is not { } port || port is < 1 or > 65535 || port != Math.Truncate(port))
            throw new HostedBootstrapException("The operator service needs operator.url (an HTTP or HTTPS origin) and operator.port.");
        return new(uri, new(deployment.PublicEndpoint.Address, (int)port), deployment);
    }

    internal static string CanonicalHost(string host) => host.TrimEnd('.').ToLowerInvariant();

    internal string Host => CanonicalHost(Origin.IdnHost);

    internal bool MatchesOrigin(string origin) =>
        Uri.TryCreate(origin, UriKind.Absolute, out var value)
        && value.GetLeftPart(UriPartial.Authority).Equals(origin,StringComparison.OrdinalIgnoreCase)
        && value.UserInfo.Length == 0 && value.Scheme == Origin.Scheme && value.Port == Origin.Port
        && CanonicalHost(value.IdnHost) == Host;

    internal void CheckSingleTenant(string slug)
    {
        if (CanonicalHost(new Uri(Deployment.TenantOrigin(slug)).IdnHost) == Host)
            throw new HostedBootstrapException("The operator hostname is already assigned to a tenant.");
    }

    internal string CheckHostname(string slug, string hostname)
    {
        var expected = CanonicalHost(new Uri(Deployment.TenantOrigin(slug)).IdnHost);
        var name = CanonicalHost(hostname);
        if (name != expected || name == Host)
            throw new OperatorProblem(400, $"The primary hostname must be the tenant's subdomain, {expected}.");
        return name;
    }
}

internal static class OperatorServer
{
    internal const string Path = "/operator/v1";

    internal static async Task ServeAsync(HostedBootstrap bootstrap, CancellationToken token)
    {
        var listener = OperatorListener.From(bootstrap.RequireDeployment());
        if (Environment.GetEnvironmentVariable("FOXWARM_HOSTED_TOPOLOGY") != "tenants")
            listener.CheckSingleTenant(bootstrap.Tenant);
        await using var database = new PgDatabase(bootstrap.RequireDatabaseUrl(), "foxwarm-operator");
        await SchemaMigrator.RequireCompatibleAsync(database, token: token);
        var store = new OperatorStore(database, bootstrap.RequireKeks().Current, listener.Deployment.Blobs.S3);
        await store.CheckRoleAsync(token);
        await store.RequireOperatorHostnameAsync(listener.Host, token);
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel(server =>
        {
            server.Listen(listener.Endpoint);
            server.Limits.MaxRequestBodySize = 2 * 1024 * 1024;
            server.AddServerHeader = false;
        });
        await using var app = builder.Build();
        var dist = HttpAssets.WebUiDirectory(HostPaths.Capture());
        var assets = dist is null ? null : new HttpAssets(System.IO.Path.GetDirectoryName(dist)!);
        var console = System.IO.Path.GetFileName(dist) + "/operator/";
        app.Run(context => Dispatch(context, store, listener, assets, console));
        await app.StartAsync(token);
        var cleanup = store.RunDeletionLoopAsync(app.Lifetime.ApplicationStopping);
        try { await app.WaitForShutdownAsync(token); }
        finally { await cleanup; }
    }

    internal static async Task Dispatch(HttpContext context, OperatorStore store, OperatorListener listener, HttpAssets? assets = null, string? consolePrefix = null)
    {
        var request = context.Request;
        var response = context.Response;
        var ct = context.RequestAborted;
        response.Headers.CacheControl = "no-store";
        if (OperatorListener.CanonicalHost(request.Host.Host) != listener.Host
            || (request.Host.Port ?? (listener.Origin.Scheme == "https" ? 443 : 80)) != listener.Origin.Port)
        {
            response.StatusCode = 404;
            return;
        }
        if (!request.Path.StartsWithSegments(Path, out var remaining))
        {
            var file = request.Path.Value switch
            {
                "/" => "index.html",
                "/operator/console.js" => "console.js",
                "/operator/console.css" => "console.css",
                _ => null,
            };
            if (file is null || assets is null || request.Method is not ("GET" or "HEAD"))
                response.StatusCode = 404;
            else
            {
                response.Headers.ContentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
                response.Headers["Referrer-Policy"] = "no-referrer";
                response.Headers.XContentTypeOptions = "nosniff";
                await assets.ServeAsync(context, consolePrefix + file);
            }
            return;
        }
        var segments = (remaining.Value ?? "").Trim('/').Split('/');
        var grantRoute = segments is ["tenants", _, "provider-grants"] && request.Method is "GET" or "PUT" or "DELETE";
        if (!grantRoute && (request.Method, segments) is not ("GET", ["placement"] or ["deletions"] or ["tenants"] or ["tenants", _] or ["profiles", _, "ceiling"])
            and not ("POST", ["replicas", "drain"] or ["tenants"] or ["tenants", _, "rotate" or "suspend" or "resume" or "move" or "release"]) and not ("DELETE", ["tenants", _]) and not ("PATCH", ["tenants", _]) and not ("PUT", ["profiles", _, "ceiling"]))
        {
            response.StatusCode = 404;
            return;
        }
        try
        {
            if (request.Headers.Origin.Count != 0 && !listener.MatchesOrigin(request.Headers.Origin.ToString()))
                throw new OperatorProblem(403, "Requests must come from the operator origin.");
            if (!AuthenticationHeaderValue.TryParse(request.Headers.Authorization, out var header)
                || !string.Equals(header.Scheme, "Bearer", StringComparison.OrdinalIgnoreCase) || header.Parameter is not { Length: 69 } bearer
                || !bearer.StartsWith("fwop_", StringComparison.Ordinal) || !await store.AuthorizedAsync(bearer, ct))
            {
                response.Headers.WWWAuthenticate = "Bearer";
                throw new OperatorProblem(401, "An operator bearer token is required.");
            }
            JsonNode result;
            switch (request.Method, segments)
            {
                case ("GET", ["deletions"]): result = await store.ReadReceiptsAsync(ct); break;
                case ("GET", ["tenants", var slug, "provider-grants"]): result = await store.ReadGrantsAsync(slug, ct); break;
                case ("PUT" or "DELETE", ["tenants", var slug, "provider-grants"]):
                    var ids = request.Query["providerId"];
                    if (ids.Count != 1 || string.IsNullOrEmpty(ids[0])) throw new OperatorProblem(400, "Supply one Provider ID.");
                    result = await store.ChangeGrantAsync(slug, ids[0]!, request.Method == "PUT" ? await Body(request, ct) : null,
                        new Providers.ProviderGrants(listener.Deployment), ct);
                    break;
                case ("POST", ["replicas", "drain"]):
                    var drain = await Body(request, ct);
                    if (drain.Count != 1 || drain["boot"] is not JsonValue bootValue || !bootValue.TryGetValue<string>(out var boot) || string.IsNullOrWhiteSpace(boot))
                        throw new OperatorProblem(400, "Supply the replica boot ID from placement.");
                    result = await store.RequestReplicaDrainAsync(boot, ct);
                    response.StatusCode = StatusCodes.Status202Accepted;
                    break;
                case ("POST", ["tenants", var slug, "move" or "release"]):
                    var grant = await Body(request, ct);
                    if (grant.Count != 3 || grant["tenantId"] is not JsonValue tenantId || !tenantId.TryGetValue<int>(out var id) || id < 1
                        || grant["owner"] is not JsonValue ownerValue || !ownerValue.TryGetValue<string>(out var owner) || string.IsNullOrWhiteSpace(owner)
                        || grant["epoch"] is not JsonValue epochValue || !epochValue.TryGetValue<long>(out var epoch) || epoch < 1)
                        throw new OperatorProblem(400, "Supply the tenant ID, owner boot ID and epoch from placement.");
                    result = await store.RequestTenantPlacementAsync(slug, id, owner, epoch,
                        segments[2] == "move" ? PlacementAction.Move : PlacementAction.Release, ct);
                    response.StatusCode = StatusCodes.Status202Accepted;
                    break;
                case ("GET", ["placement"]): result = await store.PlacementAsync(ct); break;
                case ("GET", ["tenants"]): result = await store.ReadAsync(null, ct); break;
                case ("GET", ["tenants", var slug]): result = await store.ReadAsync(slug, ct); break;
                case ("DELETE", ["tenants", var slug]):
                    result = await store.DeleteAsync(slug, ct);
                    response.StatusCode = StatusCodes.Status202Accepted;
                    break;
                case ("POST", ["tenants", var slug, "suspend"]): result = await store.SuspendAsync(slug, ct); break;
                case ("POST", ["tenants", var slug, "resume"]): result = await store.ResumeAsync(slug, ct); break;
                case ("POST", ["tenants", var slug, "rotate"]): result = await store.RotateAsync(slug, ct); break;
                case ("POST", ["tenants"]):
                    var create = await Body(request, ct);
                    if (create.Count != 3) throw new OperatorProblem(400, "Supply slug, profile and primaryHostname.");
                    var name = Text(create["slug"], "slug");
                    if (!TenantSlugs.IsValid(name)) throw new OperatorProblem(400, "Tenant slug must be " + TenantSlugs.Rule + ".");
                    var hostname = Text(create["primaryHostname"], "primaryHostname");
                    hostname = listener.CheckHostname(name, hostname);
                    result = await store.CreateAsync(name, Profile(Text(create["profile"], "profile")), hostname, ct);
                    response.StatusCode = 201;
                    break;
                case ("PATCH", ["tenants", var slug]):
                    var edits = await Body(request, ct);
                    if (edits.TryGetPropertyValue("primaryHostname", out var hostnameEdit))
                        edits["primaryHostname"] = listener.CheckHostname(slug, Text(hostnameEdit, "primaryHostname"));
                    foreach (var (field, value) in edits)
                        switch (field)
                        {
                            case "profile": Profile(Text(value, field)); break;
                            case "primaryHostname": break;
                            case "limits" when value is JsonObject limits: TenantLimits.RequireKnown(limits); break;
                            case "journal" when value is JsonObject: TenantSettings.Parse(new JsonObject { ["journal"] = value.DeepClone() }); break;
                            case "ceiling": ValidateCeiling(value); break;
                            default: throw new OperatorProblem(400, "Unknown or malformed tenant setting.");
                        }
                    if (edits.Count == 0) throw new OperatorProblem(400, "Supply at least one setting to change.");
                    result = await store.UpdateAsync(slug, edits, ct);
                    break;
                case ("GET", ["profiles", var profile, "ceiling"]): result = await store.ProfileCeilingAsync(Profile(profile), false, null, ct); break;
                case ("PUT", ["profiles", var profile, "ceiling"]):
                    var body = await Body(request, ct);
                    if (body.Count != 1 || !body.ContainsKey("ceiling")) throw new OperatorProblem(400, "Supply a ceiling document, or null to remove it.");
                    ValidateCeiling(body["ceiling"]);
                    result = await store.ProfileCeilingAsync(Profile(profile), true, (string?)body["ceiling"], ct); break;
                default: response.StatusCode = 404; return;
            }
            response.ContentType = "application/json";
            await response.WriteAsync(result.ToJsonString(), ct);
        }
        catch (OperatorProblem problem) { await Error(response, problem.Status, problem.Message, ct); }
        catch (JsonException) { await Error(response, 400, "The request body must be a JSON object.", ct); }
        catch (ArgumentException) { await Error(response, 400, "The request body must be a JSON object.", ct); }
        catch (InvalidDataException error) { await Error(response, 400, error.Message, ct); }
        catch (Npgsql.PostgresException error) when (error.SqlState == "23505" && error.ConstraintName == "tenants_one_operator")
        {
            await Error(response, 409, "This deployment already has an operator tenant.", ct);
        }
        catch (Npgsql.PostgresException error) when (error.SqlState == "23505") { await Error(response, 409, "That tenant slug or hostname is already in use.", ct); }
    }

    private static async Task<JsonObject> Body(HttpRequest request, CancellationToken token) =>
        await JsonNode.ParseAsync(request.Body, cancellationToken: token) as JsonObject ?? throw new OperatorProblem(400, "The request body must be a JSON object.");

    internal static string Profile(string name) => name is "hosted" or "operator" ? name : throw new OperatorProblem(400, "The profile must be hosted or operator.");
    private static string Text(JsonNode? value, string field) => value is JsonValue scalar && scalar.TryGetValue<string>(out var text) ? text : throw new OperatorProblem(400, $"{field} must be a string.");
    private static void ValidateCeiling(JsonNode? value)
    {
        if (value is not null) Tools.OperatorCeiling.Parse(Text(value, "ceiling"));
    }
    private static Task Error(HttpResponse response, int status, string text, CancellationToken token)
    {
        response.StatusCode = status;
        response.ContentType = "application/json";
        return response.WriteAsync(new JsonObject { ["error"] = text }.ToJsonString(), token);
    }
}
