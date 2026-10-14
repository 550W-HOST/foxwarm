using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm;

internal static class McpOAuthRoutes
{
    private const string ManagementPath = "/api/setup/authorizations";

    internal static bool IsPublic(HttpRequest request) =>
        request.Method == "GET"
        && (
            request.Path == McpOAuthService.CallbackPath
            || request.Path == McpOAuthService.ClientPath
        );

    private static void RequireJson(HttpRequest request, McpOAuthService service)
    {
        if (
            !MediaTypeHeaderValue.TryParse(request.ContentType, out var type)
            || !string.Equals(
                type.MediaType,
                "application/json",
                StringComparison.OrdinalIgnoreCase
            )
            || request.Headers["Sec-Fetch-Site"].ToString() == "cross-site"
        )
            throw new McpOAuthException(
                "request",
                "Use the authenticated Authorizations panel for this action."
            );
        string? origin = null;
        try
        {
            origin = new Uri(service.PublicUrl(McpOAuthService.CallbackPath)).GetLeftPart(
                UriPartial.Authority
            );
        }
        catch (McpOAuthException) { }
        if (
            request.Headers.Origin.Count > 1
            || request.Headers.Origin.Count == 1
                && origin is not null
                && request.Headers.Origin.ToString() != origin
        )
            throw new McpOAuthException(
                "request",
                "Open Authorizations at the configured public instance URL."
            );
    }

    private static IResult Failure(Exception error)
    {
        var safe = McpOAuthService.SafeError(error);
        return Results.BadRequest(new { error = safe.Message, code = safe.Code });
    }

    private static async Task<JsonObject> BodyAsync(HttpRequest request, McpOAuthService service)
    {
        RequireJson(request, service);
        return await JsonNode.ParseAsync(
                request.Body,
                cancellationToken: request.HttpContext.RequestAborted
            ) as JsonObject
            ?? throw new McpOAuthException("request", "Use a JSON object for this action.");
    }

    internal static void Register(WebApplication app, McpClient client)
    {
        var service = client.OAuth;
        app.MapGet(
            ManagementPath,
            () =>
            {
                try
                {
                    return Results.Json(client.Authorizations());
                }
                catch (Exception error)
                {
                    return Failure(error);
                }
            }
        );
        app.MapPut(
            ManagementPath + "/{server}",
            async (HttpContext context, string server) =>
            {
                try
                {
                    var body = await BodyAsync(context.Request, service);
                    await client.SetAuthorizationAsync(server, body);
                    return Results.Ok(new { success = true });
                }
                catch (Exception error)
                {
                    return Failure(error);
                }
            }
        );
        app.MapPost(
            ManagementPath + "/{server}/authorize",
            async (HttpContext context, string server) =>
            {
                try
                {
                    _ = await BodyAsync(context.Request, service);
                    var config = client.AuthorizationServer(server);
                    var url = await service.BeginAsync(server, config, context.RequestAborted);
                    return Results.Ok(new { authorizationUrl = url });
                }
                catch (Exception error)
                {
                    return Failure(error);
                }
            }
        );
        app.MapPost(
            ManagementPath + "/{server}/disconnect",
            async (HttpContext context, string server) =>
            {
                try
                {
                    _ = await BodyAsync(context.Request, service);
                    _ = client.AuthorizationServer(server);
                    service.Disconnect(server);
                    return Results.Ok(new { success = true });
                }
                catch (Exception error)
                {
                    return Failure(error);
                }
            }
        );
        app.MapPost(
            "/api/mcp/oauth/complete",
            async (HttpContext context) =>
            {
                context.Response.Headers.CacheControl = "no-store";
                try
                {
                    var query = await BodyAsync(context.Request, service);
                    await service.FinishAsync(query, context.RequestAborted);
                    return Results.Ok(new { success = true });
                }
                catch (Exception error)
                {
                    return Failure(error);
                }
            }
        );
        app.MapGet(
            McpOAuthService.ClientPath,
            (HttpContext context) =>
            {
                try
                {
                    context.Response.Headers.CacheControl = "public, max-age=300";
                    return Results.Json(service.ClientMetadata());
                }
                catch (Exception error)
                {
                    return Failure(error);
                }
            }
        );
        app.MapGet(
            McpOAuthService.CallbackPath,
            (HttpContext context) =>
            {
                context.Response.Headers.CacheControl = "no-store";
                context.Response.Headers["Referrer-Policy"] = "no-referrer";
                context.Response.Headers.ContentSecurityPolicy =
                    "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
                try
                {
                    var complete = JsonSerializer.Serialize(
                        service.PublicUrl("/api/mcp/oauth/complete")
                    );
                    var home = JsonSerializer.Serialize(service.PublicUrl(""));
                    // No request/query value enters this document; the authenticated first-party POST exchanges the code.
                    return Results.Content(
                        CallbackDocument(complete, home),
                        "text/html; charset=utf-8"
                    );
                }
                catch
                {
                    return Results.Text(
                        "Authorization settings changed. Open Authorizations and start again.",
                        statusCode: 400
                    );
                }
            }
        );
    }

    private static string CallbackDocument(string complete, string home) =>
        $$$"""
            <!doctype html><html lang="en"><meta charset="utf-8"><title>Completing authorization</title>
            <body><h1 id="status">Completing authorization…</h1><p id="detail"></p><a id="home">Return to Foxwarm</a><script>(async()=>{
            const query=new URLSearchParams(window.location.search);const keys=[...query.keys()];
            window.history.replaceState(null,'',window.location.pathname);
            let success=false;if(new Set(keys).size===keys.length){try{
            const response=await fetch({{{complete}}},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(query))});success=response.ok;
            }catch{}}
            document.title=success?'Authorization complete':'Authorization not completed';
            document.getElementById('status').textContent=document.title;
            document.getElementById('detail').textContent=success?'You can close this window and return to Authorizations.':'Review the server settings in Authorizations and start again.';
            document.getElementById('home').href={{{home}}};
            if(window.opener)window.opener.postMessage({type:'foxwarm-mcp-oauth',success},window.location.origin);
            })()</script></body></html>
            """;
}
