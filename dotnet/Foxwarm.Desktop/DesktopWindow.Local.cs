using Foxwarm.Models;

namespace Foxwarm.Desktop;

// The local instance: Main in this process, started on demand and stopped from the menu.
internal sealed partial class DesktopWindow
{
    private MainHost? host;
    // The current start of local Main: its endpoint, or null after a failed start. Null while stopped.
    private Task<Uri?>? local;
    private string localError = "";
    private string localToken = "";
    private bool localAuthenticated;
    private bool stoppingLocal;
    // The local endpoint of the last start; Main keeps its port across restarts.
    private Uri? localEndpoint;

    private bool IsLocal(Uri scope) => scope == localEndpoint;

    /// <summary>Starts local Main unless it runs or is starting; a failed start is kept until <paramref name="retry"/>.</summary>
    private async Task<Uri?> EnsureLocalAsync(bool retry = false)
    {
        if (retry && local is { IsCompleted: true } previous && await previous is null)
            local = null;
        var endpoint = await (local ??= StartLocalAsync());
        if (endpoint is not null && !localAuthenticated && core is not null)
        {
            await AuthenticateAsync(endpoint, localToken);
            localAuthenticated = true;
        }
        return endpoint;
    }

    private async Task<Uri?> StartLocalAsync()
    {
        try
        {
            var configuration = new ModelConfiguration(HostPaths.ForDataRoot(data));
            var dist = HttpAssets.WebUiDirectory(configuration.Paths);
            if (dist is null)
                throw new InvalidDataException(
                    "The WebUI is missing. Extract the complete Foxwarm ZIP and try again."
                );
            var http = await HttpServerSettings.CaptureDesktopAsync(data);
            var started = await Task.Run(async () =>
            {
                var embedded = await MainHost.CreateAsync(
                    [],
                    configuration,
                    http,
                    dist,
                    captureDiagnostics: true
                );
                try
                {
                    await embedded.StartAsync();
                    return embedded;
                }
                catch
                {
                    await embedded.DisposeAsync();
                    throw;
                }
            });
            host = started;
            localToken = http.Token;
            localAuthenticated = false;
            _ = ObserveHostAsync(started);
            var endpoint = new Uri(http.Address.BaseUrl);
            localEndpoint = endpoint;
            await File.WriteAllTextAsync(
                Path.Combine(data, "state", "desktop-port"),
                endpoint.Port.ToString(System.Globalization.CultureInfo.InvariantCulture)
            );
            return endpoint;
        }
        catch (Exception error)
        {
            localError = error.Message;
            if (host is { } failed)
            {
                host = null;
                await failed.DisposeAsync();
            }
            return null;
        }
    }

    // Main stopping on its own (an administrative shutdown) still ends the app.
    private async Task ObserveHostAsync(MainHost running)
    {
        await running.WaitForShutdownAsync();
        if (!exiting && !stoppingLocal && ReferenceEquals(host, running))
            ExitApplication();
    }

    /// <summary>Stops local Main after the confirmation; selecting the local instance starts it again.</summary>
    private async Task StopLocalAsync()
    {
        if (host is not { } running || stoppingLocal || exiting || instances is null)
            return;
        if (!await ConfirmStopAsync(running.RunningSessionCount()) || !ReferenceEquals(host, running) || exiting)
            return;
        stoppingLocal = true;
        var current = ++generation;
        await switching.WaitAsync();
        try
        {
            var showing = instances.Selected is null;
            if (showing)
            {
                webViews?.CloseWindows();
                ShowMessage("Stopping the local instance…");
                core?.Navigate("about:blank");
            }
            await StopLocalHostAsync();
            if (showing && current == generation && !exiting)
                ShowMessage(
                    "The local instance is stopped.",
                    ("Start", () => _ = SwitchAsync(null)),
                    ("Switch instance", null)
                );
        }
        finally
        {
            stoppingLocal = false;
            switching.Release();
        }
    }

    private async Task StopLocalHostAsync()
    {
        // A start in progress (Quit during a switch) finishes first, so its Main is drained too.
        if (local is { IsCompleted: false } pending)
            await pending;
        var running = host;
        host = null;
        local = null;
        localAuthenticated = false;
        if (running is not null)
            await running.DisposeAsync();
    }
}
