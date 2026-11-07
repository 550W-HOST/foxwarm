using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Microsoft.Extensions.Hosting;
using Microsoft.Web.WebView2.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Windowing;

namespace Foxwarm.Desktop;

internal sealed partial class DesktopWindow : Window
{
    private readonly TextBlock status = new()
    {
        Text = "Starting Foxwarm…",
        HorizontalAlignment = HorizontalAlignment.Center,
        VerticalAlignment = VerticalAlignment.Center,
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(32),
    };
    private readonly WebView2 view = new() { Visibility = Visibility.Collapsed };
    private readonly DesktopNative native;
    private MainHost? host;
    private Task startup = Task.CompletedTask;
    private bool exiting;
    private Uri? endpoint;

    internal DesktopWindow()
    {
        Title = "Foxwarm";
        var content = new Grid();
        content.Children.Add(view);
        content.Children.Add(status);
        Content = content;
        native = new DesktopNative(this, OpenWindow, ExitApplication, Shutdown);
        AppWindow.Closing += (_, e) =>
        {
            e.Cancel = true;
            if (!exiting)
                AppWindow.Hide();
        };
    }

    internal void Start() => startup = StartAsync();

    private async Task StartAsync()
    {
        try
        {
            var data = Path.GetFullPath(
                Environment.GetEnvironmentVariable("FOXWARM_DATA_DIR")
                    ?? Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Foxwarm",
                        "Desktop",
                        "data"
                    )
            );
            var work = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(data)!, "workspace"));
            var dist = Path.Combine(AppContext.BaseDirectory, "webui-dist");
            if (
                !File.Exists(Path.Combine(dist, "index.html"))
                || !Directory.Exists(Path.Combine(dist, "assets"))
            )
                throw new InvalidDataException(
                    "The WebUI is missing. Extract the complete Foxwarm ZIP and try again."
                );
            Directory.CreateDirectory(work);
            var http = await HttpServerSettings.CaptureDesktopAsync(data);
            host = await Task.Run(async () =>
            {
                var embedded = await MainHost.CreateAsync(
                    [],
                    data,
                    work,
                    new ModelConfiguration(data),
                    http,
                    dist,
                    captureDiagnostics: true
                );
                try
                {
                    await embedded.App.StartAsync();
                    return embedded;
                }
                catch
                {
                    await embedded.DisposeAsync();
                    throw;
                }
            });
            endpoint = new Uri(http.Address.BaseUrl);
            await File.WriteAllTextAsync(
                Path.Combine(data, "state", "desktop-port"),
                endpoint.Port.ToString(System.Globalization.CultureInfo.InvariantCulture)
            );
            if (exiting)
                return;
            status.Text = "Opening Foxwarm…";
            var environment = await CoreWebView2Environment.CreateWithOptionsAsync(
                null, Path.Combine(data, "webview2"), null
            );
            if (exiting)
                return;
            await view.EnsureCoreWebView2Async(environment);
            if (exiting)
                return;
            var core = view.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsWebMessageEnabled = false;
            core.NavigationStarting += (_, e) =>
            {
                if (!IsAppUri(e.Uri))
                {
                    e.Cancel = true;
                    OpenExternal(e.Uri);
                }
            };
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                OpenExternal(e.Uri);
            };
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) =>
            {
                if (
                    Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var uri)
                    && uri.Scheme is "http" or "https"
                    && !IsAppUri(e.Request.Uri)
                )
                    e.Response = environment.CreateWebResourceResponse(null, 403, "Forbidden", "");
            };
            core.NavigationCompleted += (_, e) =>
            {
                if (exiting)
                    return;
                if (e.IsSuccess)
                {
                    status.Visibility = Visibility.Collapsed;
                    view.Visibility = Visibility.Visible;
                }
                else
                {
                    view.Visibility = Visibility.Collapsed;
                    status.Visibility = Visibility.Visible;
                    status.Text = "Foxwarm could not open. Exit from the tray and try again.";
                }
            };
            await AuthenticateAsync(core, http.Token);
            if (!exiting)
                core.Navigate(endpoint.AbsoluteUri);
            _ = ObserveHostAsync();
        }
        catch (Exception error)
        {
            if (!exiting)
            {
                view.Visibility = Visibility.Collapsed;
                status.Visibility = Visibility.Visible;
                status.Text =
                    error.HResult == unchecked((int)0x80070002)
                        ? "Microsoft Edge WebView2 Runtime is required. Install the Evergreen x64 Runtime, then restart Foxwarm."
                        : "Foxwarm could not start.\n\n"
                            + error.Message
                            + "\n\nExit from the tray before trying again.";
            }
            if (host is not null)
            {
                await host.DisposeAsync();
                host = null;
            }
        }
    }

    private async Task AuthenticateAsync(CoreWebView2 core, string token)
    {
        using var handler = new HttpClientHandler
        {
            UseCookies = false,
            AllowAutoRedirect = false,
            UseProxy = false,
        };
        using var client = new HttpClient(handler) { BaseAddress = endpoint };
        using var response = await client.PostAsJsonAsync(
            "api/auth", new JsonObject { ["token"] = token }, MainJsonContext.Default.JsonObject
        );
        response.EnsureSuccessStatusCode();
        var cookie = core.CookieManager.CreateCookie(
            "foxwarm_token",
            Uri.EscapeDataString(token),
            endpoint!.Host,
            endpoint.AbsolutePath
        );
        cookie.IsHttpOnly = true;
        cookie.IsSecure = endpoint.Scheme == Uri.UriSchemeHttps;
        cookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
        cookie.Expires = DateTimeOffset.UtcNow.AddDays(365).ToUnixTimeSeconds();
        core.CookieManager.AddOrUpdateCookie(cookie);
    }

    private bool IsAppUri(string text) =>
        Uri.TryCreate(text, UriKind.Absolute, out var uri)
        && endpoint is not null
        && uri.Scheme == endpoint.Scheme
        && uri.Host == endpoint.Host
        && uri.Port == endpoint.Port;

    private static void OpenExternal(string text)
    {
        if (
            !Uri.TryCreate(text, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
        )
            return;
        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception error)
            when (error is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            DesktopNative.ShowMessage("The link could not be opened in your browser.");
        }
    }

    private async Task ObserveHostAsync()
    {
        if (host is null)
            return;
        await host.WaitForShutdownAsync();
        if (!exiting)
            ExitApplication();
    }

    private void OpenWindow()
    {
        if (exiting)
            return;
        AppWindow.Show();
        if (AppWindow.Presenter is OverlappedPresenter presenter)
            presenter.Restore();
        Activate();
        native.Foreground();
    }

    private async void ExitApplication()
    {
        if (exiting)
            return;
        exiting = true;
        status.Text = "Closing Foxwarm…";
        view.Visibility = Visibility.Collapsed;
        status.Visibility = Visibility.Visible;
        try
        {
            await startup;
            view.Close();
            if (host is not null)
                await host.DisposeAsync();
        }
        finally
        {
            native.Dispose();
            Application.Current.Exit();
        }
    }

    private void Shutdown()
    {
        exiting = true;
        // Windows shutdown must not wait on startup's UI continuation or veto sign-out.
        if (host is not null)
            Task.Run(async () => await host.DisposeAsync()).GetAwaiter().GetResult();
        view.Close();
        native.Dispose();
    }
}
