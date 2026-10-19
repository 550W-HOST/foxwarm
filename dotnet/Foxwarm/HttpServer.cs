using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Server.Kestrel.Transport.Sockets;
using Microsoft.Extensions.FileProviders;

namespace Foxwarm;

internal sealed class HttpServer
{
    public WebApplication App { get; }
    internal McpInboundHttp InboundMcp { get; }
    internal bool WebUiEnabled { get; }
    internal Channels.WebUi.WebUiDownloadSignatures Downloads { get; }

    public HttpServer(
        string[] args,
        int port,
        string apiToken,
        string? distRoot,
        SessionManager sessions,
        Foxwarm.Terminal.TerminalRegistry terminals,
        PublicWebAddress? publicAddress = null,
        bool? webUiEnabled = null,
        string bindAddress = "127.0.0.1",
        bool desktop = false,
        bool triggerEnabled = true
    )
    {
        var address = publicAddress ?? PublicWebAddress.Capture(port);
        Downloads = new(apiToken);
        var accessConfiguration =
            sessions.Models.ConfigurationOwner?.Access ?? new AccessConfiguration(new JsonObject());
        accessConfiguration.ReserveInstanceToken(apiToken);
        var access = new WebUiAccess(new SessionRuntime(sessions), accessConfiguration);
        access.Start();
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
        var builder = WebApplication.CreateBuilder(
            new WebApplicationOptions
            {
                Args = args,
                ContentRootPath =
                    sessions.Models.ConfigurationOwner?.Paths.ApplicationRoot
                    ?? AppContext.BaseDirectory,
            }
        );
        // Node authentication uses Source-compatible query credentials. Do not log request URLs.
        builder.Logging.AddFilter("Microsoft.AspNetCore.Hosting.Diagnostics", LogLevel.Warning);
        builder.WebHost.UseUrls($"http://{bindAddress}:{port}");
        if (desktop)
            builder.WebHost.UseSockets(options =>
                options.CreateBoundListenSocket = endpoint =>
                {
                    try
                    {
                        return SocketTransportOptions.CreateDefaultBoundListenSocket(endpoint);
                    }
                    catch (SocketException error)
                        when (error.SocketErrorCode == SocketError.AddressAlreadyInUse)
                    {
                        // Retry only the socket bind, not host or Session initialization.
                        return SocketTransportOptions.CreateDefaultBoundListenSocket(
                            new IPEndPoint(IPAddress.Loopback, 0)
                        );
                    }
                }
            );
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
        InboundMcp = new(accessConfiguration, new McpInboundCatalog(sessions));
        builder.Services.AddSingleton<IHostedService>(InboundMcp);
        var app = builder.Build();
        app.Lifetime.ApplicationStopped.Register(access.Dispose);
        var code = WebUiEnabled
            ? new Foxwarm.Code.CodeWorkbench(
                sessions,
                address,
                true // The extension also serves advertised remote PTYs on non-PTY Main hosts.
            )
            : null;
        app.Lifetime.ApplicationStopping.Register(sessions.BeginShutdown);
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
        app.UseWebSockets(
            new WebSocketOptions
            {
                KeepAliveInterval = TimeSpan.FromSeconds(30),
                KeepAliveTimeout = TimeSpan.FromSeconds(10),
            }
        );
        var loginFile = Path.Combine(AppContext.BaseDirectory, "packages", "webui", "login.html");
        app.Use(
            async (context, next) =>
            {
                if (
                    context.Request.Path == "/mcp"
                    || context.Request.Path == "/node_ws"
                    || Foxwarm.Nodes.NodeConnectionHub.IsShellPath(context.Request.Path)
                    || Foxwarm.Nodes.NodeBootstrap.IsPublicPath(context.Request.Path)
                    || McpOAuthRoutes.IsPublic(context.Request)
                    || code?.IsCapabilityRequest(context) == true
                )
                {
                    await next();
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
                var admin = Authorized(context.Request, apiToken, browserCookie);
                var scoped = !admin && WebUiEnabled ? access.Authenticate(context) : null;
                var valid = admin || scoped is not null;
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
                var resource = WebUiEnabled && Downloads.Authorizes(context);
                if (!valid && !resource)
                {
                    context.Response.StatusCode = 401;
                    await context.Response.WriteAsJsonAsync(new { error = "Unauthorized" });
                    return;
                }
                if (scoped is not null && !resource)
                {
                    if (!WebUiAccess.BrowserRoute(context))
                    {
                        context.Response.StatusCode = 403;
                        await context.Response.WriteAsJsonAsync(new { error = "Forbidden" });
                        return;
                    }
                    try
                    {
                        if (WebUIChannel.RouteIdentity(context.Request) is { } requested)
                            scoped.Bind(requested);
                        using var tracked = access.Track(context, scoped);
                        scoped.Require();
                        await next();
                    }
                    catch (WebUiAccessException) when (!context.Response.HasStarted)
                    {
                        context.Response.StatusCode = 403;
                        await context.Response.WriteAsJsonAsync(
                            new
                            {
                                error = "WebUI identity session binding changed.",
                                code = "WEBUI_SESSION_NOT_ALLOWED",
                            }
                        );
                    }
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
                        || (
                            !Equal(submitted, apiToken)
                            && accessConfiguration.Authenticate(submitted) is null
                        )
                    )
                        return Results.Unauthorized();
                    return Results.Ok(new { success = true });
                }
            );
            app.MapGet(
                "/api/auth/session",
                (HttpContext context) =>
                    Results.Ok(
                        WebUiAccess.Request(context)?.AuthPayload()
                            ?? new JsonObject
                            {
                                ["role"] = "admin",
                                ["features"] = WebUiAccess.Features(true),
                            }
                    )
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
        if (triggerEnabled)
            TriggerHttp.Register(app, new SessionRuntime(sessions));
        Foxwarm.Nodes.NodeRoutes.Register(app, sessions, address);
        McpOAuthRoutes.Register(app, sessions.OutboundMcp);
        InboundMcp.Register(app);
        if (port == 0 || desktop)
            app.Lifetime.ApplicationStarted.Register(() =>
                address.Origin = app.Urls.Single().TrimEnd('/')
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
