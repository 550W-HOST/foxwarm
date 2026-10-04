using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.FileProviders;
using Foxwarm.Sessions;
namespace Foxwarm;

internal sealed class HttpServer
{
    public WebApplication App { get; }
    public HttpServer(string[] args, int port, string apiToken, string? distRoot, SessionManager sessions)
    {
        var browserCookie = Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(apiToken), Encoding.UTF8.GetBytes("foxwarm-experiment-cookie-v1"))).ToLowerInvariant();
        var builder = WebApplication.CreateBuilder(args);
        builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(server => server.Limits.MaxRequestBodySize = 2 * 1024 * 1024);
        builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.Converters.Add(new Foxwarm.Images.ImageTransportConverterFactory()));
        builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(options => options.MultipartBodyLengthLimit = 51L * 1024 * 1024);
        var app = builder.Build();
        var code = new Foxwarm.Code.CodeWorkbench(sessions);
        app.Lifetime.ApplicationStopping.Register(sessions.BeginShutdown);
        if (distRoot is not null)
        {
            app.UseStaticFiles(new StaticFileOptions
            {
                FileProvider = new PhysicalFileProvider(Path.Combine(distRoot, "assets")),
                RequestPath = "/assets"
            });
            var indexPath = Path.Combine(distRoot, "index.html");
            app.Use(async (context, next) =>
            {
                if (context.Request.Method == "GET" && context.Request.Path == "/")
                {
                    context.Response.ContentType = "text/html; charset=utf-8";
                    await context.Response.SendFileAsync(indexPath);
                    return;
                }
                await next();
            });
        }
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });
        app.Use(async (context, next) =>
        {
            if (code.IsCapabilityRequest(context)) { await next(); return; }
            var origin = context.Request.Headers.Origin.ToString();
            if (origin.Length > 0 && origin != $"http://127.0.0.1:{port}")
            {
                context.Response.StatusCode = 403;
                return;
            }
            if (context.Request.Path == "/api/auth" && context.Request.Method == "POST")
            {
                await next();
                return;
            }
            var candidate = context.Request.Headers.Authorization.ToString();
            var expected = "Bearer " + apiToken;
            var cookie = context.Request.Cookies["foxwarm_token"] ?? "";
            if (!Equal(candidate, expected) && !Equal(cookie, browserCookie))
            {
                context.Response.StatusCode = 401;
                await context.Response.WriteAsJsonAsync(new { error = "Unauthorized" });
                return;
            }
            await next();
        });
        app.MapPost("/api/auth", async (HttpContext context) =>
        {
            JsonObject? body;
            try { body = await JsonNode.ParseAsync(context.Request.Body) as JsonObject; }
            catch (JsonException) { return Results.BadRequest(new { error = "Invalid JSON" }); }
            if (body is null || body.Count != 1 || body["token"] is not JsonValue value
                || !value.TryGetValue<string>(out var submitted) || !Equal(submitted, apiToken))
                return Results.Unauthorized();
            context.Response.Cookies.Append("foxwarm_token", browserCookie, new CookieOptions
            {
                HttpOnly = true,
                SameSite = SameSiteMode.Strict,
                Secure = false,
                Path = "/",
                MaxAge = TimeSpan.FromHours(8)
            });
            return Results.Ok(new { success = true });
        });

        code.Register(app);
        App = app;
    }
    static bool Equal(string left, string right) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(left), Encoding.UTF8.GetBytes(right));

}
