using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Terminal;

namespace Foxwarm;

// The console and desktop own the same in-process host and shutdown order.
internal sealed class MainHost : IAsyncDisposable
{
    private readonly SessionManager sessions;
    private readonly TerminalRegistry terminals;
    private readonly McpInboundHttp? inboundMcp;
    private readonly IHost host;
    internal WebApplication App =>
        host as WebApplication
        ?? throw new InvalidOperationException("HTTP is disabled for this host.");
    internal IHostApplicationLifetime Lifetime =>
        host.Services.GetRequiredService<IHostApplicationLifetime>();
    internal bool HttpEnabled => host is WebApplication;

    internal async Task StartAsync()
    {
        await host.StartAsync();
        if (sessions.ManagedChannels is { } channels) await channels.ReloadAsync();
    }

    private readonly object lifecycle = new();
    private Task? disposal;

    private MainHost(
        SessionManager sessions,
        TerminalRegistry terminals,
        IHost host,
        McpInboundHttp? inboundMcp
    )
    {
        this.sessions = sessions;
        this.terminals = terminals;
        this.inboundMcp = inboundMcp;
        this.host = host;
    }

    internal static Task<MainHost> CreateAsync(
        string[] args,
        ModelConfiguration configuration,
        HttpServerSettings http,
        string? distRoot = null
    ) =>
        CreateAsync(
            args,
            configuration.Paths.DataRoot,
            configuration.Paths.WorkspaceRoot,
            configuration,
            http,
            distRoot,
            configuration.Paths
        );

    internal static async Task<MainHost> CreateAsync(
        string[] args,
        string dataRoot,
        string workspaceRoot,
        ModelConfiguration configuration,
        HttpServerSettings http,
        string? distRoot,
        HostPaths? paths = null,
        Foxwarm.Channels.ChannelTransportDependencies? channelDependencies = null
    )
    {
        if (http.HttpEnabled)
            configuration.Access.ReserveInstanceToken(http.Token);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1/v1"),
            "",
            "",
            "",
            Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_INSTRUCTIONS") ?? "",
            configuration.MaxOutput
        );
        var sessions = new SessionManager(
            dataRoot,
            workspaceRoot,
            options,
            configuration.Models,
            paths?.SkillsRoot
                ?? Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_SKILLS_ROOT"),
            paths
        );
        TerminalRegistry? terminals = null;
        HttpServer? server = null;
        IHost? headless = null;
        try
        {
            await sessions.LoadMainHostAsync();
            terminals = new TerminalRegistry(dataRoot, CancellationToken.None);
            var runtime = new SessionRuntime(sessions);
            var router = new MessageRouter(runtime);
            sessions.InitializeChannels(router, configuration, channelDependencies);
            if (!http.HttpEnabled)
            {
                var builder = Host.CreateApplicationBuilder(
                    new HostApplicationBuilderSettings
                    {
                        Args = args,
                        ContentRootPath = paths?.ApplicationRoot ?? AppContext.BaseDirectory,
                    }
                );
                builder.Logging.ClearProviders();
                headless = builder.Build();
                headless
                    .Services.GetRequiredService<IHostApplicationLifetime>()
                    .ApplicationStopping.Register(sessions.BeginShutdown);
                return new MainHost(sessions, terminals, headless, null);
            }
            server = new HttpServer(
                args,
                http.Port,
                http.Token,
                distRoot,
                sessions,
                terminals,
                http.Address,
                http.WebUiEnabled,
                http.BindAddress,
                http.Desktop,
                http.TriggerEnabled
            );
            if (server.WebUiEnabled)
                new WebUIChannel(sessions, runtime, router, terminals, server.Downloads).Register(
                    server.App
                );
            return new MainHost(sessions, terminals, server.App, server.InboundMcp);
        }
        catch
        {
            sessions.BeginShutdown();
            if (sessions.ManagedChannels is { } channels) await channels.DisposeAsync();
            await sessions.ShutdownAsync();
            if (server is not null)
            {
                await server.InboundMcp.DisposeAsync();
                await server.App.DisposeAsync();
            }
            headless?.Dispose();
            if (terminals is not null)
                await terminals.DisposeAsync();
            await sessions.DisposeAsync();
            throw;
        }
    }

    internal async Task WaitForShutdownAsync()
    {
        var stopping = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = Lifetime.ApplicationStopping.Register(() =>
            stopping.TrySetResult()
        );
        await stopping.Task.ConfigureAwait(false);
    }

    public ValueTask DisposeAsync()
    {
        lock (lifecycle)
            return new(disposal ??= DisposeCoreAsync());
    }

    private async Task DisposeCoreAsync()
    {
        sessions.BeginShutdown();
        if (sessions.ManagedChannels is { } channels) await channels.StopIngressAsync();
        if (inboundMcp is not null)
            await inboundMcp.DisposeAsync().ConfigureAwait(false);
        try
        {
            // Do not let RunAsync dispose ASP.NET (including Node sockets) first.
            await sessions.ShutdownAsync().ConfigureAwait(false);
        }
        catch (SessionTurnDrainException error)
        {
            // Cross-platform, Main-only crash-like exit. No dependency teardown
            // or process-tree kill beneath cancellation-ignoring accepted work.
            Environment.FailFast("Accepted Session owners did not settle during shutdown.", error);
            throw;
        }
        if (sessions.ManagedChannels is { } managed) await managed.DisposeAsync();
        await terminals.DisposeAsync().ConfigureAwait(false);
        await host.StopAsync().ConfigureAwait(false);
        if (host is IAsyncDisposable asyncHost)
            await asyncHost.DisposeAsync().ConfigureAwait(false);
        else
            host.Dispose();
        await sessions.DisposeAsync().ConfigureAwait(false);
    }
}
