using System.Diagnostics;
using System.Net.Http.Json;
using Foxwarm.Models;
using Microsoft.Extensions.Hosting;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Foxwarm.Desktop;

internal sealed class DesktopWindow : Form
{
    private readonly Label status = new()
    {
        Dock = DockStyle.Fill,
        Text = "Starting Foxwarm…",
        TextAlign = ContentAlignment.MiddleCenter,
        Padding = new Padding(32),
    };
    private readonly WebView2 view = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly NotifyIcon tray;
    private readonly ContextMenuStrip trayMenu = new();
    private MainHost? host;
    private Task startup = Task.CompletedTask;
    private bool exiting;
    private bool closed;
    private Uri? endpoint;

    internal DesktopWindow()
    {
        Text = "Foxwarm";
        MinimumSize = new Size(800, 600);
        Size = new Size(
            Math.Min(1280, SystemInformation.WorkingArea.Width),
            Math.Min(860, SystemInformation.WorkingArea.Height)
        );
        StartPosition = FormStartPosition.CenterScreen;
        using var iconStream = typeof(DesktopWindow).Assembly.GetManifestResourceStream(
            "Foxwarm.Desktop.Foxwarm.ico"
        )!;
        Icon = new Icon(iconStream);
        Controls.Add(status);
        Controls.Add(view);
        trayMenu.Items.Add("Open", null, (_, _) => OpenWindow());
        trayMenu.Items.Add("Exit", null, (_, _) => ExitApplication());
        tray = new NotifyIcon
        {
            Text = "Foxwarm",
            Icon = Icon,
            ContextMenuStrip = trayMenu,
            Visible = true,
        };
        tray.DoubleClick += (_, _) => OpenWindow();
        Shown += (_, _) => startup = StartAsync();
    }

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
            var environment = await CoreWebView2Environment.CreateAsync(
                userDataFolder: Path.Combine(data, "webview2")
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
                    status.Visible = false;
                    view.Visible = true;
                }
                else
                {
                    view.Visible = false;
                    status.Visible = true;
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
                view.Visible = false;
                status.Visible = true;
                status.Text =
                    error is WebView2RuntimeNotFoundException
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
        using var response = await client.PostAsJsonAsync("api/auth", new { token });
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
        cookie.Expires = DateTime.UtcNow.AddDays(365);
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
            MessageBox.Show(
                "The link could not be opened in your browser.",
                "Foxwarm",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
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
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void ExitApplication()
    {
        if (exiting)
            return;
        exiting = true;
        Close();
    }

    protected override async void OnFormClosing(FormClosingEventArgs e)
    {
        if (!exiting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        if (e.CloseReason == CloseReason.WindowsShutDown)
        {
            exiting = true;
            // Do not veto Windows sign-out/shutdown or wait for UI-thread startup.
            // Drain an already-created backend on a worker without a UI-context deadlock.
            if (host is not null)
                Task.Run(async () => await host.DisposeAsync()).GetAwaiter().GetResult();
            tray.Visible = false;
            tray.Dispose();
            view.Dispose();
            base.OnFormClosing(e);
            return;
        }
        if (closed)
        {
            base.OnFormClosing(e);
            return;
        }
        exiting = true;
        e.Cancel = true;
        Enabled = false;
        status.Text = "Closing Foxwarm…";
        view.Visible = false;
        status.Visible = true;
        try
        {
            await startup;
            view.Dispose();
            if (host is not null)
                await host.DisposeAsync();
        }
        finally
        {
            tray.Visible = false;
            tray.Dispose();
            trayMenu.Dispose();
            closed = true;
            Close();
        }
    }
}
