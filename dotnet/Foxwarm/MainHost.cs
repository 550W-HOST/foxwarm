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
    internal WebApplication App { get; }
    private readonly object lifecycle = new();
    private Task? disposal;

    private MainHost(SessionManager sessions, TerminalRegistry terminals, HttpServer server)
    {
        this.sessions = sessions;
        this.terminals = terminals;
        App = server.App;
    }

    internal static async Task<MainHost> CreateAsync(
        string[] args,
        string dataRoot,
        string workspaceRoot,
        ModelConfiguration configuration,
        HttpServerSettings http,
        string? distRoot
    )
    {
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
            Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_SKILLS_ROOT")
        );
        TerminalRegistry? terminals = null;
        HttpServer? server = null;
        try
        {
            await sessions.LoadMainHostAsync();
            terminals = new TerminalRegistry(dataRoot, CancellationToken.None);
            var runtime = new SessionRuntime(sessions);
            var router = new MessageRouter(runtime);
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
                http.Desktop
            );
            if (server.WebUiEnabled)
                new WebUIChannel(sessions, runtime, router, terminals, server.Downloads).Register(
                    server.App
                );
            return new MainHost(sessions, terminals, server);
        }
        catch
        {
            sessions.BeginShutdown();
            await sessions.ShutdownAsync();
            if (server is not null)
                await server.App.DisposeAsync();
            if (terminals is not null)
                await terminals.DisposeAsync();
            await sessions.DisposeAsync();
            throw;
        }
    }

    internal async Task WaitForShutdownAsync()
    {
        var stopping = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = App.Lifetime.ApplicationStopping.Register(() =>
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
        await terminals.DisposeAsync().ConfigureAwait(false);
        await App.StopAsync().ConfigureAwait(false);
        await App.DisposeAsync().ConfigureAwait(false);
        await sessions.DisposeAsync().ConfigureAwait(false);
    }
}
