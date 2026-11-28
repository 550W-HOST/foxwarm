using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.AspNetCore.Server.Kestrel.Transport.Sockets;

namespace Foxwarm;

internal sealed class HttpServer
{
    internal static bool IsBrandAsset(PathString path) =>
        path.Value
            is "/favicon.svg"
                or "/favicon-32x32.png"
                or "/favicon-64x64.png"
                or "/favicon-128x128.png"
                or "/icon.svg"
                or "/icon-192.png"
                or "/icon-512.png"
                or "/icon-maskable-192.png"
                or "/icon-maskable-512.png"
                or "/apple-touch-icon.png"
                or "/manifest.json";

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
        Foxwarm.Terminal.TerminalRegistry? terminals,
        PublicWebAddress? publicAddress = null,
        bool? webUiEnabled = null,
        string bindAddress = "127.0.0.1",
        bool desktop = false,
        Socket? listenSocket = null,
        TimeSpan? shutdownTimeout = null,
        Microsoft.AspNetCore.Hosting.Server.IServer? server = null,
        bool shutdownAvailable = true,
        string? reservedOperatorHost = null
    )
    {
        var address = publicAddress ?? PublicWebAddress.Capture(port, bindAddress: bindAddress);
        string signingKey = apiToken;
        Func<string, bool> matches = candidate => apiToken.Length > 0 && Equal(candidate, apiToken);
        bool versioned = false;
#if FOXWARM_HOSTED
        if (sessions.Storage.Credentials is Hosted.Postgres.PgInstanceCredentials { DownloadKey: { } signed } owner)
        {
            matches = owner.Matches;
            signingKey = signed;
            versioned = true;
        }
#endif
        Downloads = new(signingKey);
        var accessConfiguration =
            sessions.Models.ConfigurationOwner?.Access ?? new AccessConfiguration(new JsonObject());
        if (versioned) accessConfiguration.ReserveInstanceVerifier(matches);
        else accessConfiguration.ReserveInstanceToken(apiToken);
        var access = new WebUiAccess(new SessionRuntime(sessions), accessConfiguration);
        access.Start();
        WebUiEnabled =
            webUiEnabled ?? HttpServerSettings.Enabled(sessions.Models.ConfigurationOwner);
        var browserCookie = versioned ? null : Convert
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
        builder.WebHost.UseUrls($"http://{HttpServerSettings.UrlHost(bindAddress)}:{port}");
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
        else if (listenSocket is not null)
        {
            var adopted = listenSocket;
            builder.WebHost.UseSockets(options =>
                options.CreateBoundListenSocket = endpoint =>
                    endpoint is IPEndPoint requested
                    && adopted?.LocalEndPoint is IPEndPoint bound
                    && requested.Port == bound.Port
                        // Adopted once; Kestrel calls Listen on it again, which keeps its queue.
                        ? Interlocked.Exchange(ref adopted, null)
                            ?? SocketTransportOptions.CreateDefaultBoundListenSocket(endpoint)
                        : SocketTransportOptions.CreateDefaultBoundListenSocket(endpoint)
            );
        }
        builder.Logging.ClearProviders();
        if (server is not null)
        {
            // A tenant runtime of a multi-tenant replica: no listener of its own, and the
            // replica alone owns the process signals.
            builder.Services.AddSingleton(server);
            builder.Services.AddSingleton<
                Microsoft.Extensions.Hosting.IHostLifetime,
                HostControlledLifetime
            >();
        }
        if (shutdownTimeout is { } timeout)
            builder.Services.Configure<Microsoft.Extensions.Hosting.HostOptions>(options =>
                options.ShutdownTimeout = timeout
            );
        builder.WebHost.ConfigureKestrel(server =>
            server.Limits.MaxRequestBodySize = 2 * 1024 * 1024
        );
        builder.Services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.Encoder = JsonText.Encoder;
            options.SerializerOptions.TypeInfoResolver = MainJsonContext.Default;
            options.SerializerOptions.Converters.Add(
                new Foxwarm.Images.ImageTransportConverterFactory()
            );
        });
        builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(options =>
            options.MultipartBodyLengthLimit = 51L * 1024 * 1024
        );
        builder.Services.AddSingleton<
            IResponseCompressionProvider,
            HttpResponseCompressionProvider
        >();
        builder.Services.AddResponseCompression(options =>
        {
            options.EnableForHttps = true;
            options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Append("image/svg+xml");
            options.ExcludedMimeTypes = ["text/event-stream"];
        });
        InboundMcp = new(accessConfiguration, new McpInboundCatalog(sessions));
        builder.Services.AddSingleton<IHostedService>(InboundMcp);
        var app = builder.Build();
        app.Lifetime.ApplicationStopped.Register(access.Dispose);
        // The Code workbench is a Main-local feature: its roots are master paths and its workspaces
        // are files under the data directory.
        var code = WebUiEnabled && sessions.Capabilities.MainTerminalsAndCode
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
#if FOXWARM_HOSTED
        if (sessions.Storage is Hosted.PostgresStorageContext)
            app.Use(async (context,next) =>
            {
                if (context.Request.Path.StartsWithSegments(Hosted.Operator.OperatorServer.Path)
                    || Hosted.Operator.OperatorListener.CanonicalHost(context.Request.Host.Host) == reservedOperatorHost)
                    context.Response.StatusCode=404;
                else await next();
            });
#endif
        app.UseRouting();
        app.UseWebSockets(
            new WebSocketOptions
            {
                KeepAliveInterval = TimeSpan.FromSeconds(30),
                KeepAliveTimeout = TimeSpan.FromSeconds(10),
            }
        );
        // The tenant's request rate and WebSocket limits (none in file mode).
        if (sessions.Admission is { } admission)
            app.Use((context, next) => Foxwarm.Limits.RequestLimits.InvokeAsync(context, admission, next));
        app.UseResponseCompression();
        var resources = new HttpAssets(sessions.Models.ConfigurationOwner?.Paths.ResourceRoot ?? AppContext.BaseDirectory);
        app.Use(
            async (context, next) =>
            {
                if (
                    context.Request.Path == "/runtime/mcp"
                    || context.Request.Path == "/mcp"
                    || context.Request.Path == "/node_ws"
                    || Foxwarm.Nodes.NodeConnectionHub.IsShellPath(context.Request.Path)
                    || context.Request.Path.StartsWithSegments("/node/transfer")
                    || Foxwarm.Nodes.NodeBootstrap.IsPublicPath(context.Request.Path)
                    || McpOAuthRoutes.IsPublic(context.Request)
                    || code?.IsCapabilityRequest(context) == true
                    || McpNodeFileDownload.IsRequest(context.Request)
                    || WebhookHttp.IsRequest(context.Request.Path)
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
                    (WebUiEnabled || versioned)
                    && context.Request.Path == "/api/auth"
                    && context.Request.Method == "POST"
                )
                {
                    await next();
                    return;
                }
                var admin = Authorized(context.Request, matches, browserCookie);
#if FOXWARM_HOSTED
                if (admin && sessions.Storage.Credentials is Hosted.Postgres.PgInstanceCredentials adminCredential)
                {
                    // The front can start a bodyless response after the tenant HttpContext
                    // has been disposed. Keep only features owned by the transport here.
                    var upgrade = context.WebSockets.IsWebSocketRequest;
                    var response = context.Features.GetRequiredFeature<IHttpResponseFeature>();
                    var lifetime = context.Features.GetRequiredFeature<IHttpRequestLifetimeFeature>();
                    context.Response.OnStarting(() =>
                    {
                        if (upgrade || response.Headers.ContentType.ToString().StartsWith("text/event-stream", StringComparison.OrdinalIgnoreCase))
                        {
                            var registration = adminCredential.Revoked.Register(lifetime.Abort);
                            response.OnCompleted(static state => ((CancellationTokenRegistration)state).DisposeAsync().AsTask(), registration);
                        }
                        return Task.CompletedTask;
                    });
                }
#endif
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
                    await resources.ServeAsync(context, "packages/webui/login.html");
                    return;
                }
                var resource = WebUiEnabled && Downloads.Authorizes(context);
                if (!valid && !resource)
                {
                    context.Response.StatusCode = 401;
                    await context.Response.WriteAsJsonAsync(
                        new JsonObject { ["error"] = "Unauthorized" }
                    );
                    return;
                }
                if (scoped is not null && !resource)
                {
                    if (!WebUiAccess.BrowserRoute(context))
                    {
                        context.Response.StatusCode = 403;
                        await context.Response.WriteAsJsonAsync(
                            new JsonObject { ["error"] = "Forbidden" }
                        );
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
                            new JsonObject
                            {
                                ["error"] = "WebUI identity session binding changed.",
                                ["code"] = "WEBUI_SESSION_NOT_ALLOWED",
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
            var dist = new HttpAssets(Path.GetDirectoryName(distRoot)!);
            var prefix = Path.GetFileName(distRoot) + "/";
            app.Use(async (context, next) =>
            {
                var path = context.Request.Path;
                if (context.Request.Method is not "GET" and not "HEAD")
                {
                    await next();
                    return;
                }
                if (path.StartsWithSegments("/assets") || path != "/manifest.json" && IsBrandAsset(path))
                {
                    if (IsBrandAsset(path))
                        context.Response.Headers.CacheControl = "private, no-cache";
                    await dist.ServeAsync(context, prefix + path.Value!.TrimStart('/'));
                    return;
                }
                if (context.Request.Method == "GET" && path == "/manifest.json" && dist.Exists(prefix + "manifest.json"))
                {
                    var manifest = JsonNode.Parse(await dist.ReadTextAsync(prefix + "manifest.json", context.RequestAborted))!.AsObject();
                    var color = context.Request.Cookies["foxwarm_canvas"];
                    if (color is not null && (color.Length == 6 || color.Length == 8) && color.All(Uri.IsHexDigit))
                    {
                        manifest["theme_color"] = "#" + color;
                        manifest["background_color"] = "#" + color;
                    }
                    context.Response.Headers.CacheControl = "private, no-store";
                    context.Response.Headers.Vary = "Cookie";
                    context.Response.ContentType = "application/manifest+json";
                    await context.Response.WriteAsync(manifest.ToJsonText(), context.RequestAborted);
                    return;
                }
                if (context.Request.Method == "GET" && path == "/")
                {
                    var html = await dist.ReadTextAsync(prefix + "index.html", context.RequestAborted);
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
            });
        }
        if (WebUiEnabled || versioned)
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
                        return Results.BadRequest(new JsonObject { ["error"] = "Invalid JSON" });
                    }
                    if (
                        body is null
                        || body.Count != 1
                        || body["token"] is not JsonValue value
                        || !value.TryGetValue<string>(out var submitted)
                    ) return Results.Unauthorized();
#if FOXWARM_HOSTED
                    if (submitted.StartsWith(Hosted.Operator.OperatorStore.SetupPrefix, StringComparison.Ordinal)
                        && versioned && accessConfiguration.Authenticate(submitted) is null
                        && sessions.Storage.Credentials is Hosted.Postgres.PgInstanceCredentials credentials)
                    {
                        context.Response.Headers.CacheControl = "no-store";
                        var (outcome, accessToken) = await credentials.RedeemAsync(submitted, context.RequestAborted);
                        return outcome == "redeemed"
                            ? Results.Ok(new JsonObject { ["success"] = true, ["instanceToken"] = accessToken })
                            : Results.Json(new JsonObject { ["code"] = "setup_" + outcome }, JsonData.WebOptions, statusCode: 401);
                    }
#endif
                    if (!matches(submitted) && (!WebUiEnabled || accessConfiguration.Authenticate(submitted) is null))
                        return Results.Unauthorized();
                    return Results.Ok(new JsonObject { ["success"] = true });
                }
            );
        }
        if (WebUiEnabled)
        {
            app.MapGet(
                "/api/auth/session",
                (HttpContext context) =>
                    Results.Ok(
                        JsonData.WebNode(
                            WebUiAccess.Request(context)?.AuthPayload()
                                ?? new JsonObject
                                {
                                    ["role"] = "admin",
                                    ["features"] = WebUiAccess.Features(true),
                                }
                        )
                    )
            );
            code?.Register(app);
        }
        McpNodeFileDownload.Register(
            app,
            sessions,
            accessConfiguration,
            request => Authorized(request, matches, browserCookie),
            context => Foxwarm.Code.CodeWorkbench.DownloadAsync(context, sessions.NodeProviders)
        );
        app.MapGet("/health", () => Results.Ok(new JsonObject { ["status"] = "ready" }));
        app.MapPost(
            "/admin/shutdown",
            (IHostApplicationLifetime lifetime) =>
            {
                if (!shutdownAvailable)
                    return Results.Json(
                        new JsonObject { ["error"] = "Shutting down isn't available in this deployment." },
                        statusCode: StatusCodes.Status403Forbidden
                    );
                sessions.BeginShutdown();
                lifetime.StopApplication();
                return Results.Accepted();
            }
        );
        new WebhookHttp(accessConfiguration, new SessionRuntime(sessions)).Register(app, address);
        Foxwarm.Nodes.NodeRoutes.Register(app, sessions, address, usePublicTemplateUrl: sessions.Models.ConfigurationOwner?.Hosted == true);
        McpOAuthRoutes.Register(app, sessions.OutboundMcp);
        InboundMcp.Register(app);
        new RuntimeMcpService(sessions.RuntimeCredentials).Register(app);
        app.Lifetime.ApplicationStarted.Register(() =>
        {
            var bound = new Uri(app.Urls.First());
            sessions.RuntimeMcpEndpoint = new UriBuilder(
                "http",
                HttpServerSettings.LocalHost(bindAddress),
                bound.Port,
                address.Prefix.ToString() + "/runtime/mcp"
            ).Uri;
        });
        if (port == 0 || desktop)
            app.Lifetime.ApplicationStarted.Register(() =>
                address.Origin = app.Urls.Single().TrimEnd('/')
            );
        App = app;
    }

    private static bool Authorized(HttpRequest request, Func<string, bool> matches, string? derived)
    {
        if (
            request.Headers.Authorization.Count == 1
            && request.Headers.Authorization.ToString() is { } authorization
            && authorization.StartsWith("Bearer ", StringComparison.Ordinal) && matches(authorization[7..])
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
            if (matches(candidate) || derived is not null && Equal(candidate, derived))
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
