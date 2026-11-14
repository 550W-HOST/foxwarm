using AppKit;
using CoreGraphics;
using Foundation;
using WebKit;

namespace Foxwarm.Desktop;

/// <summary>
/// An app window opened by a page (window.open or a link with a target). Its web view is
/// built from the configuration WebKit supplies, so it shares the opener's process and
/// data store and keeps <c>window.opener</c>. The WebUI's own document gets the main
/// window's custom frame; other same-origin documents keep the standard title bar.
/// Closing it closes it; only the main window stays alive when closed.
/// </summary>
internal sealed class DesktopPopupWindow
{
    private readonly List<NSObject> observers = [];
    private readonly IDisposable? titleObserver;
    private readonly Action<DesktopPopupWindow> closed;
    // A blank window that its opener sends elsewhere before it shows a page of the app is
    // handed to the default browser and closed.
    private bool hasPage;

    internal NSWindow Window { get; }

    internal WKWebView View { get; }

    internal DesktopFrame? Frame { get; }

    /// <summary>Kept here because WebKit holds its delegates weakly.</summary>
    internal WKNavigationDelegate? Navigation { get; set; }

    internal DesktopPopupWindow(
        NSWindow? opener,
        WKWebViewConfiguration configuration,
        WKContentRuleList rules,
        Uri endpoint,
        bool framed,
        bool blank,
        WKWindowFeatures features,
        Action<DesktopPopupWindow> closed
    )
    {
        this.closed = closed;
        hasPage = !blank;
        var screen = opener?.Screen ?? NSScreen.MainScreen;
        var visible = screen?.VisibleFrame ?? new CGRect(0, 0, 1440, 900);
        var (width, height) = DesktopNavigation.WindowSize(
            features.Width is { } requestedWidth ? (double)requestedWidth : null,
            features.Height is { } requestedHeight ? (double)requestedHeight : null,
            visible.Width,
            visible.Height
        );
        Window = new NSWindow(
            new CGRect(0, 0, width, height),
            NSWindowStyle.Titled
                | NSWindowStyle.Closable
                | NSWindowStyle.Resizable
                | NSWindowStyle.Miniaturizable,
            NSBackingStore.Buffered,
            false
        )
        {
            Title = "Foxwarm",
            ContentMinSize = new CGSize(DesktopNavigation.MinimumWidth, DesktopNavigation.MinimumHeight),
        };
        Window.ReleaseWhenClosed(false);
        Place(opener, visible);
        // WebKit's configuration copies the opener's user content controller. Each window
        // gets its own, so the frame's script and messages stay with their window, and the
        // same off-origin resource rules.
        var controller = new WKUserContentController();
        controller.AddContentRuleList(rules);
        configuration.UserContentController = controller;
        if (framed)
        {
            Frame = new DesktopFrame(Window);
            Frame.Configure(configuration, endpoint);
        }
        View = new WKWebView(Window.ContentView!.Bounds, configuration)
        {
            AutoresizingMask = NSViewResizingMask.WidthSizable | NSViewResizingMask.HeightSizable,
        };
        Window.ContentView.AddSubview(View);
        if (Frame is not null)
            Frame.Attach(View);
        else
            titleObserver = View.AddObserver(
                "title",
                NSKeyValueObservingOptions.New,
                _ => Window.Title = string.IsNullOrWhiteSpace(View.Title) ? "Foxwarm" : View.Title
            );
        observers.Add(
            NSNotificationCenter.DefaultCenter.AddObserver(
                NSWindow.WillCloseNotification,
                _ => Closed(),
                Window
            )
        );
    }

    internal void Show() => Window.MakeKeyAndOrderFront(null);

    /// <summary>Records that a top-level navigation to the app was allowed.</summary>
    internal void ShowsPage() => hasPage = true;

    /// <summary>A top-level navigation was refused or sent to the default browser.</summary>
    internal void LeftApp()
    {
        if (!hasPage)
            CloseLater();
    }

    // Never close the window inside one of its web view's own delegate calls.
    internal void CloseLater() =>
        NSApplication.SharedApplication.BeginInvokeOnMainThread(() => Window.Close());

    /// <summary>Cascades from the opener's top-left corner, inside the visible screen area.</summary>
    private void Place(NSWindow? opener, CGRect visible)
    {
        if (opener is null)
        {
            Window.Center();
            return;
        }
        // DesktopNavigation works downwards from the top of the visible area.
        var top = visible.GetMaxY();
        var size = Window.Frame.Size;
        var (x, y) = DesktopNavigation.WindowPosition(
            opener.Frame.X,
            top - opener.Frame.GetMaxY(),
            size.Width,
            size.Height,
            visible.X,
            0,
            visible.Width,
            visible.Height
        );
        Window.SetFrameTopLeftPoint(new CGPoint(x, top - y));
    }

    private void Closed()
    {
        foreach (var observer in observers)
            NSNotificationCenter.DefaultCenter.RemoveObserver(observer);
        observers.Clear();
        titleObserver?.Dispose();
        View.StopLoading();
        if (Frame is not null)
        {
            View.Configuration.UserContentController.RemoveScriptMessageHandler(DesktopFrame.HandlerName);
            Frame.Dispose();
        }
        closed(this);
    }
}
