using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Terminal;

namespace Foxwarm;

// The console and desktop own the same in-process host and shutdown order.
internal sealed class MainHost : IAsyncDisposable
{
    private readonly SessionManager sessions;
    private readonly TerminalRegistry? terminals;
    private readonly McpInboundHttp? inboundMcp;
    private readonly IHost host;
    private readonly MainLog? log;
    private readonly LogRotation rotation;
    internal WebApplication App =>
        host as WebApplication
        ?? throw new InvalidOperationException("HTTP is disabled for this host.");
    internal IHostApplicationLifetime Lifetime =>
        host.Services.GetRequiredService<IHostApplicationLifetime>();
    internal bool HttpEnabled => host is WebApplication;
    internal SessionManager Sessions => sessions;

    /// <summary>Main-local Sessions with a running turn (the Desktop's stop confirmation).</summary>
    internal int RunningSessionCount() =>
        sessions.LocalProjections().Count(row => SessionCatalog.Flag(row["busy"]));

    internal async Task StartAsync()
    {
        try
        {
            await StartCoreAsync();
        }
        catch (Exception error)
        {
            MainLog.Fatal("host start", error);
            throw;
        }
    }

    private async Task StartCoreAsync()
    {
        log?.UseFor();
        await host.StartAsync();
        if (sessions.ManagedChannels is { } channels)
        {
            if (Lifetime.ApplicationStopping.IsCancellationRequested)
                await channels.StopIngressAsync();
            else
                // ManagedChannels retains these initializers and retries through stop/drain.
                _ = channels.StartInitialAsync();
        }
        rotation.Start();
    }

    private readonly CancellationTokenRegistration channelStopping;
    private readonly object lifecycle = new();
    private Task? disposal;

    private MainHost(
        SessionManager sessions,
        TerminalRegistry? terminals,
        IHost host,
        McpInboundHttp? inboundMcp,
        MainLog? log,
        string dataRoot
    )
    {
        this.sessions = sessions;
        this.terminals = terminals;
        this.inboundMcp = inboundMcp;
        this.host = host;
        this.log = log;
        if (sessions.ManagedChannels is { } channels)
            channelStopping = Lifetime.ApplicationStopping.Register(() =>
            {
                // Close publication synchronously; the managed owner retains and joins cleanup.
                _ = channels.StopIngressAsync();
            });
        rotation = new LogRotation(Path.Combine(dataRoot, "state", "logs"), sessions.ExecLogRoots);
        if (log is not null)
            Lifetime.ApplicationStarted.Register(() =>
                Console.WriteLine(
                    HttpEnabled
                        ? "Main HTTP listening: " + string.Join(", ", App.Urls)
                        : "Main started without HTTP."
                )
            );
    }

    internal static Task<MainHost> CreateAsync(
        string[] args,
        ModelConfiguration configuration,
        HttpServerSettings http,
        string? distRoot = null,
        bool captureDiagnostics = false,
        Foxwarm.Storage.IStorageContext? storage = null,
        RuntimeCapabilities? capabilities = null,
        // Hosted mode: log lines also go to stdout as JSON lines (MainLog).
        bool jsonStdoutLog = false,
        // Hosted mode: the tenant this runtime's log lines carry.
        string? logTenant = null
    ) =>
        CreateAsync(
            args,
            configuration.Paths.DataRoot,
            configuration.Paths.AgentsRoot,
            configuration,
            http,
            distRoot,
            configuration.Paths,
            captureDiagnostics: captureDiagnostics,
            storage: storage,
            capabilities: capabilities,
            jsonStdoutLog: jsonStdoutLog,
            logTenant: logTenant
        );

    internal static async Task<MainHost> CreateAsync(
        string[] args,
        string dataRoot,
        string workspaceRoot,
        ModelConfiguration configuration,
        HttpServerSettings http,
        string? distRoot,
        HostPaths? paths = null,
        Foxwarm.Channels.ChannelTransportDependencies? channelDependencies = null,
        bool captureDiagnostics = false,
        // The runtime's stores; null builds today's file stores under dataRoot.
        Foxwarm.Storage.IStorageContext? storage = null,
        // The runtime's features; null is file mode's full profile.
        RuntimeCapabilities? capabilities = null,
        bool jsonStdoutLog = false,
        string? logTenant = null
    )
    {
        capabilities ??= RuntimeCapabilities.File;
        if (http.HttpEnabled)
            configuration.Access.ReserveInstanceToken(http.Token);
        configuration.Secrets.Open();
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1/v1"),
            "",
            "",
            "",
            "",
            configuration.MaxOutput
        );
        // The process has one Console capture; this runtime's log is a sink of it, and work
        // started from here records into this sink.
        var log = captureDiagnostics ? new MainLog(configuration, jsonStdoutLog, logTenant) : null;
        log?.UseFor();
        SessionManager sessions;
        try
        {
            sessions = new SessionManager(
                dataRoot,
                workspaceRoot,
                options,
                configuration.Models,
                paths?.SkillsRoot,
                paths,
                storage: storage,
                capabilities: capabilities,
                memoryProfile: configuration.PromptProfile
            );
        }
        catch (Exception error)
        {
            MainLog.Fatal("Session construction", error);
            log?.Dispose();
            throw;
        }
        if (
            log is not null
            && configuration
                .AppConfiguration["bot"]
                ?["enableTUI"]?.ToString()
                .Equals("true", StringComparison.OrdinalIgnoreCase) == true
        )
            Console.Error.WriteLine(
                "Configured bot.enableTUI is ignored: Main TUI is not implemented by the managed host."
            );
        TerminalRegistry? terminals = null;
        HttpServer? server = null;
        IHost? headless = null;
        try
        {
            await sessions.LoadMainHostAsync();
            if (capabilities.MainTerminalsAndCode)
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
                return new MainHost(sessions, terminals, headless, null, log, dataRoot);
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
                http.ListenSocket,
                http.ShutdownTimeout,
                http.Server,
                http.ShutdownAvailable,
                http.ReservedOperatorHost
            );
            if (server.WebUiEnabled)
            {
                new WebUIChannel(sessions, runtime, router, terminals, server.Downloads).Register(
                    server.App
                );
                Console.WriteLine("WebUI transport registered.");
            }
            return new MainHost(sessions, terminals, server.App, server.InboundMcp, log, dataRoot);
        }
        catch (Exception error)
        {
            MainLog.Fatal("host composition", error);
            // Every step runs even when an earlier one fails; a failed step leaves services that
            // may still run, which the caller must know (a hosted owner then releases nothing).
            List<Exception> failures = [];
            await Step(() =>
            {
                sessions.BeginShutdown();
                return Task.CompletedTask;
            });
            if (sessions.ManagedChannels is { } channels)
                await Step(() => channels.DisposeAsync().AsTask());
            await Step(sessions.ShutdownAsync);
            if (server is not null)
            {
                await Step(() => server.InboundMcp.DisposeAsync().AsTask());
                await Step(() => server.App.DisposeAsync().AsTask());
            }
            await Step(() =>
            {
                headless?.Dispose();
                return Task.CompletedTask;
            });
            if (terminals is not null)
                await Step(() => terminals.DisposeAsync().AsTask());
            await Step(() => sessions.DisposeAsync().AsTask());
            log?.Dispose();
            if (failures.Count > 0)
                throw new StartupCleanupFailedException(error, failures);
            throw;

            async Task Step(Func<Task> step)
            {
                try
                {
                    await step();
                }
                catch (Exception failure)
                {
                    failures.Add(failure);
                }
            }
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
        try
        {
            await StopServicesAsync();
        }
        finally
        {
            // Also when stopping ingress failed before Session shutdown was reached.
            sessions.DisposeAdmission();
        }
    }

    private async Task StopServicesAsync()
    {
        log?.UseFor();
        var stopping = System.Diagnostics.Stopwatch.StartNew();
        sessions.BeginShutdown();
        if (sessions.ManagedChannels is { } channels)
            await channels.StopIngressAsync();
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
        if (log is not null)
            Console.WriteLine($"Main stopping: Sessions settled after {stopping.ElapsedMilliseconds} ms.");
        if (sessions.ManagedChannels is { } managed)
            await managed.DisposeAsync();
        if (terminals is not null)
            await terminals.DisposeAsync().ConfigureAwait(false);
        await host.StopAsync().ConfigureAwait(false);
        if (log is not null)
            Console.WriteLine($"Main stopping: HTTP stopped after {stopping.ElapsedMilliseconds} ms.");
        if (host is IAsyncDisposable asyncHost)
            await asyncHost.DisposeAsync().ConfigureAwait(false);
        else
            host.Dispose();
        await rotation.DisposeAsync().ConfigureAwait(false);
        channelStopping.Dispose();
        await sessions.DisposeAsync().ConfigureAwait(false);
        sessions.Secrets?.Dispose();
        if (log is not null)
            Console.WriteLine("Main stopped.");
        log?.Dispose();
    }
}

/// <summary>
/// A start that failed and whose cleanup failed too: services it started may still run. The
/// inner exception is the start's failure. A caller that must know the start left nothing
/// running (a hosted owner before it releases its lease) treats this as an unconfirmed stop.
/// </summary>
internal sealed class StartupCleanupFailedException(Exception failure, IReadOnlyList<Exception> cleanup)
    : Exception(failure.Message, failure)
{
    internal IReadOnlyList<Exception> Cleanup { get; } = cleanup;
}
