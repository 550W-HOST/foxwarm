using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.AspNetCore;
using ModelContextProtocol.Protocol;

namespace Foxwarm.Tests;

internal sealed class OutboundMcpFixture : IAsyncDisposable
{
    internal readonly TempDirectory Temp = new();
    internal string Data => Path.Combine(Temp.Path, "data");
    internal string Work => Path.Combine(Temp.Path, "work");
    internal SessionManager Manager = null!;
    internal SessionOwner First = null!;
    internal SessionOwner Second = null!;
    internal Foxwarm.McpClient Mcp => Manager.OutboundMcp;
    internal ToolRegistry Registry = null!;

    internal static async Task<OutboundMcpFixture> CreateAsync()
    {
        var f = new OutboundMcpFixture();
        try
        {
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "a",
                "",
                "",
                713
            );
            f.Manager = new(f.Data, f.Work, options, HostModels.ForTest(options));
            await f.Manager.LoadMainHostAsync();
            f.First = await f.Manager.CreateNamedAsync("main", "first", null, null);
            f.Second = await f.Manager.CreateNamedAsync("main", "second", null, null);
            f.First.Registry.TriggerOverride = _ => Task.CompletedTask;
            f.Second.Registry.TriggerOverride = _ => Task.CompletedTask;
            var definitions = WorkspaceTools.Definitions();
            foreach (var definition in UnifiedToolDefinitions.All())
                definitions.Add(definition?.DeepClone());
            foreach (var definition in ToolScriptToolDefinitions.Definitions())
                definitions.Add(definition?.DeepClone());
            f.Registry = SessionToolExecutor.CreateRegistry(
                definitions,
                f.Mcp,
                owner => f.Manager.IdentityWorkspace(owner).ToolDirectory
            );
            return f;
        }
        catch
        {
            await f.DisposeAsync();
            throw;
        }
    }

    internal SessionToolExecutor Tools(SessionOwner owner) =>
        new(
            new WorkspaceTools(Manager.IdentityWorkspace(owner).ToolDirectory),
            owner,
            Manager,
            Registry
        );

    internal Task<JsonNode?> CallAsync(
        SessionOwner owner,
        string name,
        JsonObject? args = null,
        CancellationToken token = default
    ) => Tools(owner).ExecuteAsync(Call(name, args), token);

    internal static JsonObject Call(string name, JsonObject? args = null) =>
        new()
        {
            ["id"] = Guid.NewGuid().ToString("N"),
            ["name"] = "call_tool",
            ["args"] = new JsonObject
            {
                ["toolId"] = "mcp:peer/" + name,
                ["args"] = args?.DeepClone() ?? new JsonObject(),
            },
        };

    internal Task<JsonObject> ConfigureAsync(
        string url,
        string transport = "streamable-http",
        JsonObject? extra = null
    )
    {
        var args = extra is null ? new JsonObject() : (JsonObject)extra.DeepClone();
        args["name"] = "peer";
        args["url"] = url;
        args["transport"] = transport;
        return Mcp.ConfigureAsync(args, default);
    }

    internal Task<JsonNode?> ScriptAsync(string code, SessionOwner? owner = null) =>
        Tools(owner ?? First)
            .ExecuteAsync(
                new JsonObject
                {
                    ["id"] = "native-script",
                    ["name"] = "run_script",
                    ["args"] = new JsonObject { ["code"] = code },
                },
                default
            );

    private bool disposed;

    public async ValueTask DisposeAsync()
    {
        if (disposed)
            return;
        disposed = true;
        if (Manager is not null)
        {
            Manager.BeginShutdown();
            await Manager.ShutdownAsync();
            await Manager.DisposeAsync();
        }
        Temp.Dispose();
    }
}

internal sealed class OutboundSdkPeer : IAsyncDisposable
{
    private readonly Process process;
    private readonly Task<string> stderr;
    private readonly HttpClient http = new();
    internal string Url { get; }

    private OutboundSdkPeer(Process process, Task<string> stderr, string url)
    {
        this.process = process;
        this.stderr = stderr;
        Url = url;
    }

    internal static string Script =>
        Path.Combine(AppContext.BaseDirectory, "Mcp", "Fixtures", "outbound-peer.mjs");

    internal static async Task<OutboundSdkPeer> StartAsync(string root)
    {
        var info = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        info.ArgumentList.Add(Script);
        info.ArgumentList.Add("http");
        info.ArgumentList.Add(root);
        var process = Process.Start(info)!;
        var stderr = process.StandardError.ReadToEndAsync();
        try
        {
            var line = await process
                .StandardOutput.ReadLineAsync()
                .WaitAsync(TimeSpan.FromSeconds(10));
            var url = JsonNode.Parse(
                line ?? throw new IOException("Official peer exited before listening.")
            )!["url"]!.GetValue<string>();
            return new(process, stderr, url);
        }
        catch
        {
            if (!process.HasExited)
                process.Kill(true);
            await process.WaitForExitAsync();
            process.Dispose();
            throw;
        }
    }

    internal async Task<JsonObject[]> EventsAsync() =>
        JsonNode
            .Parse(await http.GetStringAsync(Url + "/events"))!
            .AsArray()
            .OfType<JsonObject>()
            .ToArray();

    internal async Task<JsonObject[]> WaitAsync(string kind, string? tag = null, int count = 1)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (true)
        {
            var events = (await EventsAsync())
                .Where(row =>
                    row["kind"]?.GetValue<string>() == kind
                    && (tag is null || row["tag"]?.GetValue<string>() == tag)
                )
                .ToArray();
            if (events.Length >= count)
                return events;
            await Task.Delay(20, deadline.Token);
        }
    }

    internal Task ReleaseAsync(string tag) =>
        http.GetStringAsync(Url + "/release?tag=" + Uri.EscapeDataString(tag));

    public async ValueTask DisposeAsync()
    {
        http.Dispose();
        if (!process.HasExited)
            process.Kill(true);
        await process.WaitForExitAsync();
        var diagnostic = await stderr;
        process.Dispose();
        Assert.True(string.IsNullOrEmpty(diagnostic), "The official SDK fixture emitted stderr.");
    }
}

// Official C# 2.2.0 ASP.NET peer: no hand-written MCP protocol responses.
internal sealed class StatelessSdkPeer : IAsyncDisposable
{
    private readonly WebApplication app;
    internal readonly ConcurrentQueue<JsonObject> Requests = new();
    internal string Url { get; private set; } = "";
    internal string? ExpectedAuthorization;
    internal string? ExpectedHeader;

    internal StatelessSdkPeer(WebApplication app) => this.app = app;

    internal static async Task<StatelessSdkPeer> StartAsync(bool minimalResults = false)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder
            .Services.AddMcpServer(options =>
            {
                options.ServerInfo = new() { Name = "stateless-qualification", Version = "1" };
                if (minimalResults)
                    options.Filters.Message.OutgoingFilters.Add(next =>
                        (message, token) =>
                        {
                            // Exercise a metadata-free 2026 structured result using the SDK's
                            // application filter. Default SDK metadata is qualified separately.
                            if (
                                message.JsonRpcMessage
                                    is JsonRpcResponse { Result: JsonObject result }
                                && result.ContainsKey("structuredContent")
                            )
                            {
                                result.Remove("_meta");
                                result.Remove("resultType");
                            }
                            return next(message, token);
                        }
                    );
            })
            .WithHttpTransport(options => options.SessionMode = HttpServerSessionMode.Stateless)
            .WithListToolsHandler(
                (_, _) =>
                    ValueTask.FromResult(
                        new ListToolsResult
                        {
                            Tools =
                            [
                                new Tool
                                {
                                    Name = "value",
                                    InputSchema = JsonSerializer.SerializeToElement(
                                        new { type = "object" }
                                    ),
                                },
                            ],
                        }
                    )
            )
            .WithCallToolHandler(
                (context, _) =>
                {
                    var kind = context.Params!.Arguments!["kind"].GetString();
                    var json = kind switch
                    {
                        "null" => "null",
                        "scalar" => "false",
                        "array" => "[1,null,false]",
                        _ => "{\"value\":1}",
                    };
                    return ValueTask.FromResult(
                        new CallToolResult
                        {
                            StructuredContent = JsonDocument.Parse(json).RootElement.Clone(),
                        }
                    );
                }
            );
        var app = builder.Build();
        var peer = new StatelessSdkPeer(app);
        app.Use(
            async (context, next) =>
            {
                context.Request.EnableBuffering();
                JsonNode? body = null;
                if (context.Request.Method == "POST")
                {
                    using var reader = new StreamReader(context.Request.Body, leaveOpen: true);
                    body = JsonNode.Parse(await reader.ReadToEndAsync());
                    context.Request.Body.Position = 0;
                }
                peer.Requests.Enqueue(
                    new JsonObject
                    {
                        ["method"] =
                            body?["method"]?.DeepClone()
                            ?? JsonValue.Create(context.Request.Method),
                        ["protocol"] = context.Request.Headers["Mcp-Protocol-Version"].ToString(),
                        ["session"] = context.Request.Headers["Mcp-Session-Id"].ToString(),
                        ["authorizationMatched"] =
                            peer.ExpectedAuthorization is null
                            || context.Request.Headers.Authorization.ToString()
                                == peer.ExpectedAuthorization,
                        ["headerMatched"] =
                            peer.ExpectedHeader is null
                            || context.Request.Headers["X-Qualification"].ToString()
                                == peer.ExpectedHeader,
                    }
                );
                await next(context);
            }
        );
        app.MapMcp("/mcp");
        await app.StartAsync();
        peer.Url =
            app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!
                .Addresses.Single() + "/mcp";
        return peer;
    }

    public async ValueTask DisposeAsync()
    {
        await app.StopAsync();
        await app.DisposeAsync();
    }
}
