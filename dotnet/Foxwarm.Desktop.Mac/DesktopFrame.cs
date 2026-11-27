using System.Text.Json.Nodes;
using AppKit;
using CoreGraphics;
using Foundation;
using WebKit;

namespace Foxwarm.Desktop;

/// <summary>
/// Custom window frame: the WebUI extends under a transparent, compact title bar. The page
/// learns the traffic lights' zone through <c>window.foxwarmFrame</c> and reports its drag
/// surfaces through the one-way <c>foxwarmFrame</c> script message, which also carries the
/// brand row's one-way request for the host's instance menu. A transparent view above
/// the web view turns presses inside those surfaces into native window drags, because
/// WKWebView has no app-region and <c>performDrag</c> must run inside the native mouse-down.
/// </summary>
internal sealed class DesktopFrame : NSObject, IWKScriptMessageHandler
{
    internal const string HandlerName = "foxwarmFrame";
    private readonly NSWindow window;
    private readonly bool codeWindow;
    private readonly Action<WKWebView, FrameRect>? instanceMenu;
    private readonly NSToolbar toolbar = new("FoxwarmFrame") { ShowsBaselineSeparator = false };
    private readonly List<NSObject> observers = [];
    private WKWebView? view;
    private FrameDragView? dragView;
    private Uri? scope;
    private string state = "";
    private DesktopFrameRegions? regions;
    private bool fullScreen;

    internal DesktopFrame(
        NSWindow window,
        DesktopWindowFrame frameKind = DesktopWindowFrame.WebUi,
        Action<WKWebView, FrameRect>? instanceMenu = null
    )
    {
        this.window = window;
        this.instanceMenu = instanceMenu;
        codeWindow = frameKind == DesktopWindowFrame.Code;
        window.StyleMask |= NSWindowStyle.FullSizeContentView;
        window.TitlebarAppearsTransparent = true;
        window.TitleVisibility = NSWindowTitleVisibility.Hidden;
        // An empty toolbar in the compact unified style gives the taller title area.
        window.Toolbar = toolbar;
        window.ToolbarStyle = NSWindowToolbarStyle.UnifiedCompact;
        Observe(NSWindow.DidResizeNotification, Update);
        Observe(NSWindow.DidBecomeKeyNotification, Update);
        Observe(NSWindow.DidResignKeyNotification, Update);
        Observe(NSWindow.DidChangeBackingPropertiesNotification, Update);
        Observe(
            NSWindow.WillEnterFullScreenNotification,
            () =>
            {
                // The lights move to the auto-hiding menu-bar reveal; the page uses all of the screen.
                fullScreen = true;
                toolbar.Visible = false;
                Update();
            }
        );
        Observe(
            NSWindow.DidExitFullScreenNotification,
            () =>
            {
                fullScreen = false;
                toolbar.Visible = true;
                Update();
            }
        );
    }

    private void Observe(NSString name, Action action) =>
        observers.Add(NSNotificationCenter.DefaultCenter.AddObserver(name, _ => action(), window));

    /// <summary>Adds the document-start state and the message handler to a configuration.</summary>
    internal void Configure(WKWebViewConfiguration configuration, Uri scope)
    {
        this.scope = scope;
        state = StateJson();
        configuration.UserContentController.AddUserScript(DocumentScript(state));
        configuration.UserContentController.AddScriptMessageHandler(this, HandlerName);
    }

    /// <summary>Places the drag view above the web view and keeps the window title in sync.</summary>
    internal void Attach(WKWebView webView)
    {
        view = webView;
        dragView = new FrameDragView(webView)
        {
            Frame = webView.Frame,
            AutoresizingMask = NSViewResizingMask.WidthSizable | NSViewResizingMask.HeightSizable,
        };
        webView.Superview!.AddSubview(dragView, NSWindowOrderingMode.Above, webView);
        webView.AddObserver(
            "title",
            NSKeyValueObservingOptions.New,
            _ => window.Title = string.IsNullOrWhiteSpace(webView.Title) ? "Foxwarm" : webView.Title
        );
        ApplyRegions();
    }

    /// <summary>Moves the document-start state to another instance's scope before navigating there.</summary>
    internal void SetScope(Uri next)
    {
        if (view is null || scope == next)
            return;
        scope = next;
        var controller = view.Configuration.UserContentController;
        controller.RemoveAllUserScripts();
        controller.AddUserScript(DocumentScript(state));
    }

    /// <summary>Whether the page last reported a dark color scheme; native menus and dialogs follow it.</summary>
    internal bool Dark { get; private set; }

    /// <summary>Forgets the previous document's surfaces when a new one starts loading.</summary>
    internal void ResetRegions()
    {
        regions = null;
        ApplyRegions();
    }

    [Export("userContentController:didReceiveScriptMessage:")]
    public void DidReceiveScriptMessage(WKUserContentController controller, WKScriptMessage message)
    {
        if (
            message.Name != HandlerName
            || message.FrameInfo is not { MainFrame: true } frame
            || scope is null
            || !DesktopNavigation.IsApp(scope, frame.Request?.Url?.AbsoluteString)
            || !IsOwnOrigin(frame.SecurityOrigin)
        )
            return;
        var body = message.Body;
        if (body is not NSDictionary)
            return;
        var data = NSJsonSerialization.Serialize(body, 0, out var error);
        if (error is not null || data is null)
            return;
        var json = NSString.FromData(data, NSStringEncoding.UTF8)?.ToString();
        var parsed = DesktopFrameRegions.Parse(json);
        if (parsed is null)
        {
            // Only while the window is key, so a page in the background can't pop it up.
            if (
                window.IsKeyWindow
                && instanceMenu is not null
                && message.WebView is { } webView
                && DesktopInstanceMenuRequest.Parse(json) is { } request
            )
                instanceMenu(webView, request.Anchor);
            return;
        }
        regions = parsed;
        Dark = parsed.Dark;
        window.Appearance = NSAppearance.GetAppearance(parsed.Dark ? NSAppearance.NameDarkAqua : NSAppearance.NameAqua);
        ApplyRegions();
    }

    private bool IsOwnOrigin(WKSecurityOrigin? security) =>
        scope is not null
        && security is not null
        && security.Protocol == scope.Scheme
        && string.Equals(security.Host, scope.Host, StringComparison.OrdinalIgnoreCase)
        && (security.Port == scope.Port || (security.Port == 0 && scope.IsDefaultPort));

    /// <summary>The traffic lights' zone in window points, top-left origin; empty in full screen.</summary>
    private (double Left, double Top) ControlZone()
    {
        if (fullScreen || window.StyleMask.HasFlag(NSWindowStyle.FullScreenWindow))
            return (0, 0);
        var content = window.ContentView!.Bounds;
        var top = content.Height - window.ContentLayoutRect.GetMaxY();
        var zoom = window.StandardWindowButton(NSWindowButton.ZoomButton);
        var left = zoom is null ? 0 : zoom.ConvertRectToView(zoom.Bounds, null).GetMaxX() + 12;
        return (Math.Max(0, Math.Round(left)), Math.Max(0, Math.Round(top)));
    }

    private string StateJson()
    {
        var (left, top) = ControlZone();
        var tokens = new JsonArray();
        if (!window.IsKeyWindow)
            tokens.Add((JsonNode)"inactive");
        if (fullScreen)
            tokens.Add((JsonNode)"fullscreen");
        return new JsonObject
        {
            ["platform"] = "macos",
            ["left"] = left,
            ["right"] = 0,
            ["top"] = top,
            ["state"] = tokens,
        }.ToJsonText();
    }

    // Top-level documents of the selected instance only; frames and other pages see nothing.
    private string Script(string json) =>
        "if (" + DesktopNavigation.ScopeCondition(scope!) + ") window.foxwarmFrame = " + json + ";";

    private WKUserScript DocumentScript(string json) =>
        new(new NSString(Script(json)), WKUserScriptInjectionTime.AtDocumentStart, true);

    private void Update()
    {
        ApplyRegions();
        if (view is null || scope is null)
            return;
        var next = StateJson();
        if (next == state)
            return;
        state = next;
        var controller = view.Configuration.UserContentController;
        controller.RemoveAllUserScripts();
        controller.AddUserScript(DocumentScript(next));
        view.EvaluateJavaScript(Script(next) + " window.dispatchEvent(new Event('foxwarm-frame'));", null);
    }

    private void ApplyRegions()
    {
        if (dragView is null)
            return;
        var (left, top) = ControlZone();
        if (codeWindow && view?.Superview is { } content)
        {
            // The native strip remains above setup/error responses without a frame report.
            var frame = content.Bounds;
            if (regions is null)
                frame = new CGRect(frame.X, frame.Y, frame.Width, Math.Max(0, frame.Height - top));
            if (view.Frame != frame)
                view.Frame = frame;
            if (regions is null)
            {
                var width = dragView.Bounds.Width - left;
                dragView.Regions = width > 0 && top > 0 ? [new FrameRect(left, 0, width, top)] : [];
                dragView.Lights = new CGRect(0, 0, left, top);
                return;
            }
        }
        var bounds = dragView.Bounds;
        dragView.Regions =
            regions?.Clip(1, new FrameRect(0, 0, bounds.Width, bounds.Height), [new FrameRect(0, 0, left, top)])
            ?? [];
        dragView.Lights = new CGRect(0, 0, left, top);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
            foreach (var observer in observers)
                NSNotificationCenter.DefaultCenter.RemoveObserver(observer);
        base.Dispose(disposing);
    }
}

/// <summary>
/// Transparent view above the web view. It takes a press only inside a reported drag surface
/// and never over the traffic lights; everything else falls through to the page.
/// </summary>
internal sealed class FrameDragView(WKWebView webView) : NSView
{
    internal IReadOnlyList<FrameRect> Regions { get; set; } = [];
    internal CGRect Lights { get; set; }

    public override bool IsFlipped => true;

    public override bool AcceptsFirstMouse(NSEvent? theEvent) => true;

    public override NSView? HitTest(CGPoint point)
    {
        if (Superview is null || Hidden)
            return null;
        var local = ConvertPointFromView(point, Superview);
        if (Lights.Contains(local))
            return null;
        foreach (var region in Regions)
            if (local.X >= region.X && local.X < region.Right && local.Y >= region.Y && local.Y < region.Bottom)
                return this;
        return null;
    }

    public override void MouseDown(NSEvent theEvent)
    {
        if (Window is null)
            return;
        if (theEvent.ClickCount == 2)
        {
            DoubleClick(Window);
            return;
        }
        Window.PerformWindowDrag(theEvent);
    }

    // Wheel and secondary clicks keep reaching the page beneath.
    public override void ScrollWheel(NSEvent theEvent) => webView.ScrollWheel(theEvent);

    public override void RightMouseDown(NSEvent theEvent) => webView.RightMouseDown(theEvent);

    /// <summary>The user's title-bar double-click preference: zoom (default), minimize or nothing.</summary>
    private static void DoubleClick(NSWindow window)
    {
        var defaults = NSUserDefaults.StandardUserDefaults;
        var action = defaults.StringForKey("AppleActionOnDoubleClick");
        if (action is null && defaults.BoolForKey("AppleMiniaturizeOnDoubleClick"))
            action = "Minimize";
        switch (action)
        {
            case "None":
                break;
            case "Minimize":
                window.PerformMiniaturize(null);
                break;
            default:
                window.PerformZoom(null);
                break;
        }
    }
}
