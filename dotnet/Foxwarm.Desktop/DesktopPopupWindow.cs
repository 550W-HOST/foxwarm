using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Windows.Graphics;

namespace Foxwarm.Desktop;

/// <summary>
/// An app window opened by a page (window.open or a link with a target). It hosts the
/// opener's new web contents, so <c>window.opener</c> and postMessage keep working. The
/// WebUI's own document gets the main window's custom frame; other same-origin documents
/// keep the system title bar. Closing it closes it; only the main window hides to the tray.
/// </summary>
internal sealed partial class DesktopPopupWindow : Window
{
    private readonly WebView2 view = new();
    private readonly DesktopWebViews webViews;
    private readonly DesktopFrame? frame;
    // A blank window that its opener sends elsewhere before it shows a page of the app is
    // handed to the default browser and closed.
    private bool hasPage;
    private bool closed;

    internal DesktopPopupWindow(
        DesktopWebViews webViews,
        Window opener,
        bool framed,
        bool blank,
        double? width,
        double? height
    )
    {
        this.webViews = webViews;
        hasPage = !blank;
        Title = "Foxwarm";
        var content = new Grid();
        content.Children.Add(view);
        Content = content;
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Foxwarm.ico"));
        if (framed)
            frame = new DesktopFrame(this, view, webViews.IsAppUri);
        Place(opener, width, height);
        Closed += (_, _) =>
        {
            closed = true;
            view.Close();
        };
    }

    /// <summary>Shows the window and prepares its web view for the opener's new contents.</summary>
    internal async Task<CoreWebView2> InitializeAsync()
    {
        Activate();
        await view.EnsureCoreWebView2Async(webViews.Environment);
        var core = view.CoreWebView2;
        webViews.Configure(core, this, LeftApp);
        core.NavigationStarting += (_, e) =>
        {
            if (!e.Cancel && webViews.IsAppUri(e.Uri))
                hasPage = true;
        };
        // window.close() from the page, including the opener closing its popup.
        core.WindowCloseRequested += (_, _) => CloseLater();
        if (frame is not null)
            await frame.InstallAsync(core, webViews.Endpoint);
        else
        {
            // Without the frame there is no page-to-host channel at all.
            core.Settings.IsWebMessageEnabled = false;
            core.DocumentTitleChanged += (_, _) =>
                Title = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "Foxwarm" : core.DocumentTitle;
        }
        return core;
    }

    private void LeftApp()
    {
        if (!hasPage)
            CloseLater();
    }

    // Never close the window inside one of its web view's own events.
    private void CloseLater() =>
        DispatcherQueue.TryEnqueue(() =>
        {
            if (!closed)
                Close();
        });

    /// <summary>The requested content size (or the default) in the opener's scale, cascaded from the opener.</summary>
    private void Place(Window opener, double? width, double? height)
    {
        var work = DisplayArea
            .GetFromWindowId(opener.AppWindow.Id, DisplayAreaFallback.Nearest)
            .WorkArea;
        var scale = opener.Content?.XamlRoot?.RasterizationScale ?? 1;
        var (contentWidth, contentHeight) = DesktopNavigation.WindowSize(
            width,
            height,
            work.Width / scale,
            work.Height / scale
        );
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = (int)Math.Round(DesktopNavigation.MinimumWidth * scale);
            presenter.PreferredMinimumHeight = (int)Math.Round(DesktopNavigation.MinimumHeight * scale);
        }
        AppWindow.ResizeClient(
            new SizeInt32(
                (int)Math.Round(contentWidth * scale),
                (int)Math.Round(contentHeight * scale)
            )
        );
        var size = AppWindow.Size;
        var (x, y) = DesktopNavigation.WindowPosition(
            opener.AppWindow.Position.X,
            opener.AppWindow.Position.Y,
            size.Width,
            size.Height,
            work.X,
            work.Y,
            work.Width,
            work.Height,
            Math.Round(DesktopNavigation.Cascade * scale)
        );
        AppWindow.Move(new PointInt32((int)x, (int)y));
    }
}
