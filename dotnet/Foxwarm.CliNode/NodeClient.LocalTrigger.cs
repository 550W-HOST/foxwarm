using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.Timeouts;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Foxwarm.CliNode;

internal sealed partial class NodeClient
{
    private WebApplication? triggerServer;
    private string? triggerToken;
    private string? triggerState;
    private int triggerPort;

    private async Task StartLocalTriggerServer()
    {
        if (!options.LocalTrigger || triggerServer is not null)
            return;
        triggerState = options.CredentialsFile is not null
            ? Path.GetDirectoryName(Path.GetFullPath(options.CredentialsFile))!
            : Path.Combine(paths.StartupDirectory, "state");
        Directory.CreateDirectory(triggerState);
        var tokenFile = Path.Combine(triggerState, "node_local_trigger_token");
        if (File.Exists(tokenFile))
            triggerToken = NodePaths.TrimSpace(await File.ReadAllTextAsync(tokenFile));
        else
        {
            triggerToken = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            await WriteTriggerFile(
                tokenFile,
                triggerToken + "\n",
                UnixFileMode.UserRead | UnixFileMode.UserWrite
            );
        }
        // No environment, appsettings, URL configuration, hosting startup or ConsoleLifetime.
        // The CLI owns its signals and this one IPv4 HTTP listener, including port zero.
        var builder = WebApplication.CreateEmptyBuilder(new WebApplicationOptions());
        builder.WebHost.UseSockets();
        builder.WebHost.UseKestrelCore();
        builder.WebHost.ConfigureKestrel(server =>
        {
            var port = double.IsFinite(options.LocalTriggerPort) ? options.LocalTriggerPort : 0;
            if (port < 0 || port >= 65536 || port != Math.Truncate(port))
                throw new InvalidDataException("Local trigger port must be >= 0 and < 65536");
            server.Listen(
                IPAddress.Loopback,
                (int)port,
                listen => listen.Protocols = HttpProtocols.Http1
            );
            server.AddServerHeader = false;
            // Node's HTTP server has no application body cap or minimum transfer rate.
            server.Limits.MaxRequestBodySize = null;
            server.Limits.MinRequestBodyDataRate = null;
            server.Limits.MinResponseDataRate = null;
            server.Limits.KeepAliveTimeout = TimeSpan.FromSeconds(5);
            server.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(60);
            server.Limits.MaxRequestHeadersTotalSize = 16384;
            server.Limits.MaxRequestHeaderCount = 2000;
            server.Limits.MaxRequestLineSize = 16384;
        });
        builder.Services.Configure<HostOptions>(host =>
            host.ShutdownTimeout = Timeout.InfiniteTimeSpan
        );
        builder.Services.AddRequestTimeouts(timeouts =>
            timeouts.DefaultPolicy = new RequestTimeoutPolicy
            {
                Timeout = TimeSpan.FromMinutes(5),
                TimeoutStatusCode = StatusCodes.Status408RequestTimeout,
            }
        );
        var app = builder.Build();
        triggerServer = app;
        app.UseRequestTimeouts();
        app.Run(HandleLocalTrigger);
        await app.StartAsync();
        var address = app
            .Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!
            .Addresses.Single();
        triggerPort = new Uri(address).Port;
        await WriteLocalTriggerArtifacts();
        Log("local_trigger_ready", "host=127.0.0.1 port=" + triggerPort);
    }

    private async Task WriteLocalTriggerArtifacts()
    {
        if (triggerState is null || triggerPort == 0)
            return;
        var metaFile = Path.Combine(triggerState, "node_local_trigger.json");
        var tokenFile = Path.Combine(triggerState, "node_local_trigger_token");
        var scriptFile = Path.Combine(triggerState, "trigger-session-event.sh");
        await File.WriteAllTextAsync(
            metaFile,
            new JsonObject
            {
                ["host"] = "127.0.0.1",
                ["port"] = triggerPort,
                ["tokenFile"] = tokenFile,
                ["scriptFile"] = scriptFile,
                ["nodeId"] = nodeId,
            }.ToJsonString(new() { WriteIndented = true })
        );
        var script =
            "#!/bin/sh\nset -eu\n"
            + "if [ \"$#\" -lt 2 ]; then\n  echo \"Usage: $0 <session-id> <message> [event-type]\" >&2\n  exit 1\nfi\n"
            + "exec "
            + ExecNative.SelfCommand
            + " --local-trigger-helper "
            + ExecNative.Quote(metaFile)
            + " "
            + ExecNative.Quote(tokenFile)
            + " \"$1\" \"$2\" \"${3:-trigger}\"\n";
        await WriteTriggerFile(
            scriptFile,
            script,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        );
    }

    private static async Task WriteTriggerFile(string path, string text, UnixFileMode mode)
    {
        var fileOptions = new FileStreamOptions
        {
            Mode = FileMode.Create,
            Access = FileAccess.Write,
        };
        // Like Source's mode option, this applies only when creating, not chmod of read-old files.
        if (!OperatingSystem.IsWindows())
            fileOptions.UnixCreateMode = mode;
        await using var stream = new FileStream(path, fileOptions);
        await stream.WriteAsync(Encoding.UTF8.GetBytes(text));
    }

    private async Task HandleLocalTrigger(HttpContext context)
    {
        var response = context.Response;
        try
        {
            // Path.Value is decoded by Kestrel. Source compares the URL's escaped pathname.
            var rawTarget = context.Features.Get<IHttpRequestFeature>()!.RawTarget ?? "/";
            var escapedPath = rawTarget
                .Split('?', 2)[0]
                .Replace("%2e", ".", StringComparison.OrdinalIgnoreCase)
                // Preserve other escapes through Uri normalization, including invalid UTF-8.
                .Replace("%", "%25");
            var path = new Uri(new Uri("http://127.0.0.1"), escapedPath).AbsolutePath;
            if (path != "/trigger")
            {
                response.StatusCode = 404;
                await response.WriteAsync("Not found");
                return;
            }
            if (context.Request.Method != "POST")
            {
                response.StatusCode = 405;
                await response.WriteAsync("Method not allowed");
                return;
            }
            var auth = context.Request.Headers.Authorization.FirstOrDefault();
            var bearer =
                auth?.StartsWith("Bearer ", StringComparison.Ordinal) == true ? auth[7..] : null;
            var provided =
                !string.IsNullOrEmpty(bearer) ? bearer
                : context.Request.Headers.TryGetValue("x-node-trigger-token", out var tokens)
                    ? string.Join(", ", tokens.ToArray())
                : null;
            if (provided != triggerToken)
            {
                await TriggerJson(response, 401, new JsonObject { ["error"] = "Unauthorized" });
                return;
            }
            using var bytes = new MemoryStream();
            await context.Request.Body.CopyToAsync(bytes, context.RequestAborted);
            context.Features.Get<IHttpRequestTimeoutFeature>()?.DisableTimeout();
            using var body = JsonDocument.Parse(
                bytes.Length == 0
                    ? "{}"
                    : Encoding.UTF8.GetString(bytes.GetBuffer(), 0, (int)bytes.Length),
                new JsonDocumentOptions { MaxDepth = int.MaxValue }
            );
            var value = body.RootElement;
            if (value.ValueKind == JsonValueKind.Null)
                throw new InvalidDataException(
                    "Cannot read properties of null (reading 'sessionId')"
                );
            var sessionId = NodePaths.TrimSpace(TriggerText(value, "sessionId") ?? "");
            var message = TriggerText(value, "message") ?? "";
            var eventType = TriggerText(value, "eventType");
            if (sessionId.Length == 0 || NodePaths.TrimSpace(message).Length == 0)
            {
                await TriggerJson(
                    response,
                    400,
                    new JsonObject { ["error"] = "sessionId and message are required" }
                );
                return;
            }
            await SendSessionEvent(
                sessionId,
                message,
                eventType is "background" or "onboot" ? eventType : "trigger"
            );
            await TriggerJson(response, 200, new JsonObject { ["success"] = true });
        }
        catch (OperationCanceledException)
            when (context
                    .Features.Get<IHttpRequestTimeoutFeature>()
                    ?.RequestTimeoutToken.IsCancellationRequested == true
            )
        {
            throw;
        }
        catch (Exception error)
        {
            Log("local_trigger_failed", error.GetType().Name);
            await TriggerJson(response, 500, new JsonObject { ["error"] = error.Message });
        }
    }

    private static string? TriggerText(JsonElement body, string key) =>
        body.ValueKind == JsonValueKind.Object
        && body.TryGetProperty(key, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static async Task TriggerJson(HttpResponse response, int status, JsonObject body)
    {
        response.StatusCode = status;
        response.ContentType = "application/json";
        await response.WriteAsync(body.ToJsonString());
    }

    private async Task StopLocalTriggerServer()
    {
        if (triggerServer is not { } server)
            return;
        triggerServer = null;
        await server.StopAsync();
        await server.DisposeAsync();
    }
}
