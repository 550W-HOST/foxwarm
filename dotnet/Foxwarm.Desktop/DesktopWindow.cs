using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Microsoft.Web.WebView2.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Windowing;
using Windows.System;

namespace Foxwarm.Desktop;

/// <summary>
/// The main window. It shows the selected instance ([D-desktop-instances]): the local
/// instance, whose Main runs in this process and starts on demand, or a remote instance the
/// app only browses. A native message with actions replaces the page while an instance
/// starts, is stopped or can't be reached.
/// </summary>
internal sealed partial class DesktopWindow : Window
{
    private readonly Grid content = new();
    private readonly StackPanel placeholder = new()
    {
        HorizontalAlignment = HorizontalAlignment.Center,
        VerticalAlignment = VerticalAlignment.Center,
        Spacing = 16,
        MaxWidth = 560,
        Margin = new Thickness(32),
    };
    private readonly TextBlock status = new()
    {
        Text = "Starting Foxwarm…",
        HorizontalAlignment = HorizontalAlignment.Center,
        TextAlignment = TextAlignment.Center,
        TextWrapping = TextWrapping.Wrap,
    };
    private readonly StackPanel actions = new()
    {
        Orientation = Orientation.Horizontal,
        HorizontalAlignment = HorizontalAlignment.Center,
        Spacing = 8,
    };
    private readonly WebView2 view = new() { Visibility = Visibility.Collapsed };
    private readonly DesktopNative native;
    private readonly DesktopFrame frame;
    private readonly SemaphoreSlim switching = new(1, 1);
    private string data = "";
    private DesktopInstances? instances;
    private CoreWebView2? core;
    private DesktopWebViews? webViews;
    private Task startup = Task.CompletedTask;
    // WebView2 starts once the window is first shown; a sign-in start runs only Main until then.
    private readonly TaskCompletionSource shown = new();
    private bool exiting;
    // Incremented by every switch, so that a slower earlier one doesn't navigate afterwards.
    private int generation;
    // The instance the web view shows (its scope).
    private Uri? shownScope;

    internal DesktopWindow()
    {
        Title = "Foxwarm";
        placeholder.Children.Add(status);
        placeholder.Children.Add(actions);
        content.Children.Add(view);
        content.Children.Add(placeholder);
        Content = content;
        native = new DesktopNative(this, OpenWindow, ExitApplication, Shutdown, OpenInstanceMenuFromTray);
        frame = new DesktopFrame(this, view, IsAppUri, DesktopWindowFrame.WebUi, anchor => OpenInstanceMenu(this, anchor));
        // The fallback entry, also for a page without the brand row (an older WebUI, an error page).
        var shortcut = new KeyboardAccelerator
        {
            Key = VirtualKey.F1,
            Modifiers = VirtualKeyModifiers.Control | VirtualKeyModifiers.Shift,
        };
        shortcut.Invoked += (_, e) =>
        {
            e.Handled = true;
            OpenInstanceMenu(this, null);
        };
        content.KeyboardAccelerators.Add(shortcut);
        content.KeyboardAcceleratorPlacementMode = KeyboardAcceleratorPlacementMode.Hidden;
        AppWindow.Closing += (_, e) =>
        {
            e.Cancel = true;
            if (!exiting)
                AppWindow.Hide();
        };
    }

    internal void Start(bool tray)
    {
        if (!tray)
        {
            Activate();
            shown.TrySetResult();
        }
        startup = StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            data = Path.GetFullPath(
                Environment.GetEnvironmentVariable("FOXWARM_DATA_DIR")
                    ?? Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Foxwarm",
                        "Desktop",
                        "data"
                    )
            );
            instances = DesktopInstances.Load(data);
            // Local Main starts at launch only when the local instance is selected.
            if (instances.Selected is null)
                await EnsureLocalAsync();
            if (exiting)
                return;
            await shown.Task;
            if (exiting)
                return;
            var environment = await CoreWebView2Environment.CreateWithOptionsAsync(
                null, Path.Combine(data, "webview2"), null
            );
            if (exiting)
                return;
            await view.EnsureCoreWebView2Async(environment);
            if (exiting)
                return;
            core = view.CoreWebView2;
            // The scope is set for real by the first switch, before the first navigation.
            webViews = new DesktopWebViews(environment, new Uri("http://127.0.0.1/"))
            {
                InstanceMenu = (window, anchor) => OpenInstanceMenu(window, anchor),
            };
            webViews.Configure(core, this);
            // The frame's one-way messages are the only page-to-host channel.
            await frame.InstallAsync(core, webViews.Scope);
            if (exiting)
                return;
            core.NavigationCompleted += (_, e) => NavigationCompleted(e);
            await SwitchAsync(instances.Selected, retry: false);
        }
        catch (Exception error)
        {
            if (!exiting)
                ShowMessage(
                    error.HResult == unchecked((int)0x80070002)
                        ? "Microsoft Edge WebView2 Runtime is required. Install the Evergreen x64 Runtime, then restart Foxwarm."
                        : "Foxwarm could not start.\n\n" + error.Message + "\n\nExit from the tray before trying again."
                );
            await StopLocalHostAsync();
        }
    }

    private void NavigationCompleted(CoreWebView2NavigationCompletedEventArgs e)
    {
        if (exiting || shownScope is null || core is null)
            return;
        if (e.IsSuccess)
        {
            if (DesktopNavigation.IsBlank(core.Source))
                return;
            placeholder.Visibility = Visibility.Collapsed;
            view.Visibility = Visibility.Visible;
            return;
        }
        // A navigation replaced by another one, or refused by the navigation policy.
        if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled)
            return;
        var scope = shownScope;
        ShowMessage(
            IsLocal(scope) ? "Foxwarm could not open." : DesktopInstances.Label(scope) + " could not be reached.",
            ("Try again", () => _ = SwitchAsync(instances?.Selected)),
            ("Switch instance", null)
        );
    }

    /// <summary>
    /// Shows the selected instance: starts local Main on demand, closes the previous
    /// instance's app windows and moves the scope before navigating.
    /// </summary>
    private async Task SwitchAsync(Uri? remote, bool retry = true)
    {
        if (exiting || core is null || webViews is null || instances is null)
            return;
        var current = ++generation;
        await switching.WaitAsync();
        try
        {
            if (current != generation || exiting)
                return;
            instances.Select(remote);
            webViews.CloseWindows();
            Uri target;
            if (remote is null)
            {
                if (local is null)
                    ShowMessage("Starting Foxwarm…");
                var endpoint = await EnsureLocalAsync(retry);
                if (current != generation || exiting)
                    return;
                if (endpoint is null)
                {
                    ShowMessage(
                        "Foxwarm could not start.\n\n" + localError,
                        ("Try again", () => _ = SwitchAsync(null)),
                        ("Switch instance", null)
                    );
                    return;
                }
                target = endpoint;
            }
            else
                target = remote;
            if (shownScope != target || view.Visibility != Visibility.Visible)
                ShowMessage(IsLocal(target) ? "Opening Foxwarm…" : "Opening " + DesktopInstances.Label(target) + "…");
            shownScope = target;
            webViews.Scope = target;
            await frame.SetScopeAsync(target);
            if (current != generation || exiting)
                return;
            core.Navigate(target.AbsoluteUri);
        }
        catch (Exception error) when (error is HttpRequestException or IOException or InvalidOperationException)
        {
            if (current == generation && !exiting)
                ShowMessage(
                    "Foxwarm could not open.\n\n" + error.Message,
                    ("Try again", () => _ = SwitchAsync(instances.Selected)),
                    ("Switch instance", null)
                );
        }
        finally
        {
            switching.Release();
        }
    }

    private bool IsAppUri(string text) => webViews is not null && webViews.IsAppUri(text);

    /// <summary>
    /// Replaces the page with a message and optional actions; an action without a callback
    /// opens the instance menu below its button.
    /// </summary>
    private void ShowMessage(string text, params (string Label, Action? Action)[] buttons)
    {
        view.Visibility = Visibility.Collapsed;
        placeholder.Visibility = Visibility.Visible;
        status.Text = text;
        actions.Children.Clear();
        foreach (var (label, action) in buttons)
        {
            var button = new Button { Content = label };
            button.Click += (_, _) =>
            {
                if (action is not null)
                    action();
                else
                    OpenInstanceMenu(this, null, button);
            };
            actions.Children.Add(button);
        }
        actions.Visibility = buttons.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        frame.Reset();
    }

    private void OpenInstanceMenuFromTray()
    {
        OpenWindow();
        OpenInstanceMenu(this, null);
    }

    internal void OpenWindow()
    {
        if (exiting)
            return;
        AppWindow.Show();
        if (AppWindow.Presenter is OverlappedPresenter presenter)
            presenter.Restore();
        Activate();
        native.Foreground();
        shown.TrySetResult();
    }

    internal async void ExitApplication()
    {
        if (exiting)
            return;
        exiting = true;
        shown.TrySetResult();
        webViews?.CloseAll();
        ShowMessage("Closing Foxwarm…");
        try
        {
            await startup;
            view.Close();
            await StopLocalHostAsync();
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
        if (host is { } running)
            Task.Run(async () => await running.DisposeAsync()).GetAwaiter().GetResult();
        webViews?.CloseAll();
        view.Close();
        native.Dispose();
    }

    private async Task AuthenticateAsync(Uri endpoint, string token)
    {
        using var handler = new HttpClientHandler
        {
            UseCookies = false,
            AllowAutoRedirect = false,
            UseProxy = false,
        };
        using var client = new HttpClient(handler) { BaseAddress = endpoint };
        using var response = await client.PostAsJsonAsync(
            "api/auth", new JsonObject { ["token"] = token }, MainJsonContext.Text.JsonObject
        );
        response.EnsureSuccessStatusCode();
        var cookie = core!.CookieManager.CreateCookie(
            "foxwarm_token",
            Uri.EscapeDataString(token),
            endpoint.Host,
            endpoint.AbsolutePath
        );
        cookie.IsHttpOnly = true;
        cookie.IsSecure = endpoint.Scheme == Uri.UriSchemeHttps;
        cookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
        cookie.Expires = DateTimeOffset.UtcNow.AddDays(365).ToUnixTimeSeconds();
        core.CookieManager.AddOrUpdateCookie(cookie);
    }
}
