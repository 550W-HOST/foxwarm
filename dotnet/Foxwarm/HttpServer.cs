using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Extensions.FileProviders;

namespace Foxwarm;

internal sealed class HttpServer
{
    public WebApplication App { get; }
    internal bool WebUiEnabled { get; }

    public HttpServer(
        string[] args,
        int port,
        string apiToken,
        string? distRoot,
        SessionManager sessions,
        Foxwarm.Terminal.TerminalRegistry terminals,
        PublicWebAddress? publicAddress = null,
        bool? webUiEnabled = null,
        string bindAddress = "127.0.0.1"
    )
    {
        var address = publicAddress ?? PublicWebAddress.Capture(port);
        WebUiEnabled =
            webUiEnabled ?? HttpServerSettings.Enabled(sessions.Models.ConfigurationOwner);
        var browserCookie = Convert
            .ToHexString(
                HMACSHA256.HashData(
                    Encoding.UTF8.GetBytes(apiToken),
                    Encoding.UTF8.GetBytes("foxwarm-experiment-cookie-v1")
                )
            )
            .ToLowerInvariant();
        var builder = WebApplication.CreateBuilder(args);
        builder.WebHost.UseUrls($"http://{bindAddress}:{port}");
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(server =>
            server.Limits.MaxRequestBodySize = 2 * 1024 * 1024
        );
        builder.Services.ConfigureHttpJsonOptions(options =>
            options.SerializerOptions.Converters.Add(
                new Foxwarm.Images.ImageTransportConverterFactory()
            )
        );
        builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(options =>
            options.MultipartBodyLengthLimit = 51L * 1024 * 1024
        );
        var app = builder.Build();
        var code = WebUiEnabled
            ? new Foxwarm.Code.CodeWorkbench(
                sessions,
                address,
                Foxwarm.Terminal.TerminalRegistry.IsSupported
            )
            : null;
        app.Lifetime.ApplicationStopping.Register(sessions.BeginShutdown);
        app.Lifetime.ApplicationStopping.Register(() => _ = terminals.ShutdownAsync());
        app.Use(
            async (context, next) =>
            {
                var path = context.Request.Path;
                var pathBase = context.Request.PathBase;
                if (
                    address.Prefix.HasValue
                    && path.StartsWithSegments(
                        address.Prefix,
                        StringComparison.Ordinal,
                        out var rest
                    )
                )
                {
                    context.Request.PathBase = pathBase + address.Prefix;
                    context.Request.Path = rest;
                }
                try
                {
                    await next();
                }
                finally
                {
                    context.Request.Path = path;
                    context.Request.PathBase = pathBase;
                }
            }
        );
        app.UseRouting();
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });
        var loginFile = Path.Combine(AppContext.BaseDirectory, "packages", "webui", "login.html");
        app.Use(
            async (context, next) =>
            {
                if (code?.IsCapabilityRequest(context) == true)
                {
                    await next();
                    return;
                }
                var origins = context.Request.Headers.Origin;
                if (
                    origins.Count > 1
                    || (origins.ToString().Length > 0 && origins.ToString() != address.Origin)
                )
                {
                    context.Response.StatusCode = 403;
                    return;
                }
                if (
                    WebUiEnabled
                    && distRoot is not null
                    && !context.Request.Path.HasValue
                    && context.Request.PathBase.HasValue
                    && context.Request.Method == "GET"
                )
                {
                    context.Response.Redirect(address.CookiePath + context.Request.QueryString);
                    return;
                }
                if (
                    WebUiEnabled
                    && context.Request.Path == "/api/auth"
                    && context.Request.Method == "POST"
                )
                {
                    await next();
                    return;
                }
                var valid = Authorized(context.Request, apiToken, browserCookie);
                var staticEntry =
                    WebUiEnabled
                    && distRoot is not null
                    && context.Request.Method == "GET"
                    && (
                        context.Request.Path == "/"
                        || context.Request.Path == "/login.html"
                        || context.Request.Path.StartsWithSegments("/assets")
                    );
                if (staticEntry && (!valid || context.Request.Path == "/login.html"))
                {
                    context.Response.ContentType = "text/html; charset=utf-8";
                    context.Response.Headers.CacheControl = "no-store";
                    await context.Response.SendFileAsync(loginFile, context.RequestAborted);
                    return;
                }
                if (!valid)
                {
                    context.Response.StatusCode = 401;
                    await context.Response.WriteAsJsonAsync(new { error = "Unauthorized" });
                    return;
                }
                await next();
            }
        );
        if (WebUiEnabled && distRoot is not null)
        {
            app.UseStaticFiles(
                new StaticFileOptions
                {
                    FileProvider = new PhysicalFileProvider(Path.Combine(distRoot, "assets")),
                    RequestPath = "/assets",
                }
            );
            var indexPath = Path.Combine(distRoot, "index.html");
            app.Use(
                async (context, next) =>
                {
                    if (context.Request.Method == "GET" && context.Request.Path == "/")
                    {
                        var html = await File.ReadAllTextAsync(indexPath, context.RequestAborted);
                        const string marker = "<meta name=\"foxwarm-host\" content=\"dotnet\">";
                        html = html.Contains("<head>", StringComparison.Ordinal)
                            ? html.Replace("<head>", "<head>" + marker)
                            : marker + html;
                        context.Response.ContentType = "text/html; charset=utf-8";
                        context.Response.Headers.CacheControl = "no-store";
                        await context.Response.WriteAsync(html, context.RequestAborted);
                        return;
                    }
                    await next();
                }
            );
        }
        if (WebUiEnabled)
        {
            app.MapPost(
                "/api/auth",
                async (HttpContext context) =>
                {
                    JsonObject? body;
                    try
                    {
                        body = await JsonNode.ParseAsync(context.Request.Body) as JsonObject;
                    }
                    catch (JsonException)
                    {
                        return Results.BadRequest(new { error = "Invalid JSON" });
                    }
                    if (
                        body is null
                        || body.Count != 1
                        || body["token"] is not JsonValue value
                        || !value.TryGetValue<string>(out var submitted)
                        || !Equal(submitted, apiToken)
                    )
                        return Results.Unauthorized();
                    context.Response.Cookies.Append(
                        "foxwarm_token",
                        browserCookie,
                        new CookieOptions
                        {
                            HttpOnly = true,
                            SameSite = SameSiteMode.Strict,
                            Secure = address.Secure,
                            Path = address.CookiePath,
                            MaxAge = TimeSpan.FromHours(8),
                        }
                    );
                    return Results.Ok(new { success = true });
                }
            );
            code!.Register(app);
        }
        app.MapGet("/health", () => Results.Ok(new { status = "ready" }));
        app.MapPost(
            "/admin/shutdown",
            (IHostApplicationLifetime lifetime) =>
            {
                sessions.BeginShutdown();
                lifetime.StopApplication();
                return Results.Accepted();
            }
        );
        App = app;
    }

    private static bool Authorized(HttpRequest request, string token, string derived)
    {
        if (
            request.Headers.Authorization.Count == 1
            && Equal(request.Headers.Authorization.ToString(), "Bearer " + token)
        )
            return true;
        foreach (var header in request.Headers.Cookie)
        foreach (var entry in (header ?? "").Split(';'))
        {
            var separator = entry.IndexOf('=');
            if (separator < 0 || entry[..separator].Trim() != "foxwarm_token")
                continue;
            string candidate;
            try
            {
                candidate = Uri.UnescapeDataString(entry[(separator + 1)..].Trim());
            }
            catch (UriFormatException)
            {
                continue;
            }
            if (Equal(candidate, token) || Equal(candidate, derived))
                return true;
        }
        return false;
    }

    static bool Equal(string left, string right) =>
        CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(left),
            Encoding.UTF8.GetBytes(right)
        );
}
