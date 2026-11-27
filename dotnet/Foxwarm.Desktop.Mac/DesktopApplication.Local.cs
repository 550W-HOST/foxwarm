using System.Net.Http.Json;
using System.Text.Json.Nodes;
using AppKit;
using Foundation;
using Foxwarm.Models;
using WebKit;

namespace Foxwarm.Desktop;

// The local instance: Main in this process, started on demand and stopped from the menu.
internal sealed partial class DesktopApplication
{
    private MainHost? host;
    // Held while local Main runs in this process; released after it is disposed, so a later start can take it.
    private InstallationLock? localLock;
    // The current start of local Main: its endpoint, or null after a failed start. Null while stopped.
    private Task<Uri?>? local;
    private string localError = "";
    private bool stoppingLocal;
    // The local endpoint of the last start; Main keeps its port across restarts.
    private Uri? localEndpoint;

    private bool IsLocal(Uri target) => target == localEndpoint;

    /// <summary>Starts local Main unless it runs or is starting; a failed start is kept until <paramref name="retry"/>.</summary>
    private async Task<Uri?> EnsureLocalAsync(bool retry = false)
    {
        if (retry && local is { IsCompleted: true } previous && await previous is null)
            local = null;
        return await (local ??= StartLocalAsync());
    }

    private async Task<Uri?> StartLocalAsync()
    {
        try
        {
            var paths = HostPaths.ForDataRoot(data);
            localLock ??= InstallationLock.Acquire(paths.DataRoot);
            var configuration = new ModelConfiguration(paths);
            var dist = HttpAssets.WebUiDirectory(configuration.Paths);
            if (dist is null)
                throw new InvalidDataException("The WebUI is missing from the Foxwarm application.");
            var http = await HttpServerSettings.CaptureDesktopAsync(data);
            var started = await Task.Run(async () =>
            {
                var result = await MainHost.CreateAsync(
                    [],
                    configuration,
                    http,
                    dist,
                    captureDiagnostics: true
                );
                try
                {
                    await result.StartAsync();
                    return result;
                }
                catch
                {
                    await result.DisposeAsync();
                    throw;
                }
            });
            host = started;
            _ = ObserveHostAsync(started);
            var endpoint = new Uri(http.Address.BaseUrl);
            localEndpoint = endpoint;
            await File.WriteAllTextAsync(
                Path.Combine(data, "state", "desktop-port"),
                endpoint.Port.ToString(System.Globalization.CultureInfo.InvariantCulture)
            );
            await AuthenticateAsync(endpoint, http.Token);
            return endpoint;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            localError = error.Message;
            if (host is { } failed)
            {
                host = null;
                await failed.DisposeAsync();
            }
            ReleaseLocalLock();
            return null;
        }
    }

    private static async Task AuthenticateAsync(Uri endpoint, string token)
    {
        using var handler = new HttpClientHandler
        {
            UseCookies = false,
            AllowAutoRedirect = false,
            UseProxy = false,
        };
        using var client = new HttpClient(handler) { BaseAddress = endpoint };
        using var response = await client.PostAsJsonAsync(
            "api/auth",
            new JsonObject { ["token"] = token },
            MainJsonContext.Text.JsonObject
        );
        response.EnsureSuccessStatusCode();
        var auth = DesktopAuthCookie.For(endpoint, token, DateTimeOffset.UtcNow);
        using var properties = new NSMutableDictionary
        {
            [NSHttpCookie.KeyName] = new NSString(DesktopAuthCookie.Name),
            [NSHttpCookie.KeyValue] = new NSString(auth.Value),
            [NSHttpCookie.KeyDomain] = new NSString(auth.Domain),
            [NSHttpCookie.KeyPath] = new NSString(auth.Path),
            [NSHttpCookie.KeyExpires] = (NSDate)auth.Expires.UtcDateTime,
            // NSHTTPCookieSameSiteLax is "lax".
            [NSHttpCookie.KeySameSitePolicy] = new NSString(DesktopAuthCookie.SameSite.ToLowerInvariant()),
            [new NSString("HttpOnly")] = new NSString("TRUE"),
        };
        if (auth.Secure)
            properties[NSHttpCookie.KeySecure] = new NSString("TRUE");
        using var cookie = new NSHttpCookie(properties);
        await WKWebsiteDataStore.DefaultDataStore.HttpCookieStore.SetCookieAsync(cookie);
    }

    // Main stopping on its own (an administrative shutdown) still ends the app.
    private async Task ObserveHostAsync(MainHost running)
    {
        await running.WaitForShutdownAsync();
        NSApplication.SharedApplication.BeginInvokeOnMainThread(() =>
        {
            if (!exiting && !stoppingLocal && ReferenceEquals(host, running))
                NSApplication.SharedApplication.Terminate(null);
        });
    }

    /// <summary>Stops local Main after the confirmation; selecting the local instance starts it again.</summary>
    private async Task StopLocalAsync()
    {
        if (host is not { } running || stoppingLocal || exiting || instances is null || window is null)
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
                CloseAppWindows();
                ShowMessage("Stopping the local instance…");
                view?.LoadRequest(new NSUrlRequest(new NSUrl("about:blank")));
            }
            await StopLocalHostAsync();
            if (showing && current == generation && !exiting)
                ShowMessage(
                    "The local instance is stopped.",
                    ("Start", () => _ = SwitchAsync(null)),
                    ("Switch Instance", null)
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
        if (running is not null)
            await running.DisposeAsync();
        ReleaseLocalLock();
    }

    private void ReleaseLocalLock()
    {
        localLock?.Dispose();
        localLock = null;
    }
}
