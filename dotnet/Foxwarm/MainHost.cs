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
            if (server is not null)
                await server.App.DisposeAsync();
            if (terminals is not null)
                await terminals.DisposeAsync();
            await sessions.DisposeAsync();
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        sessions.BeginShutdown();
        try
        {
            await App.StopAsync();
            await sessions.ShutdownAsync();
        }
        finally
        {
            await App.DisposeAsync();
            await terminals.DisposeAsync();
            await sessions.DisposeAsync();
        }
    }
}
