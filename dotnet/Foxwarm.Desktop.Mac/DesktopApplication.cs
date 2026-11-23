using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using AppKit;
using CoreGraphics;
using Foundation;
using WebKit;

namespace Foxwarm.Desktop;

/// <summary>
/// The application: the main window shows the selected instance ([D-desktop-instances]),
/// either the local instance, whose Main runs in this process and starts on demand, or a
/// remote instance the app only browses. A native message with actions replaces the page
/// while an instance starts, is stopped or can't be reached.
/// </summary>
[Register("FoxwarmDesktopApplication")]
internal sealed partial class DesktopApplication : NSApplicationDelegate
{
    private NSWindow? window;
    private DesktopFrame? frame;
    private WKWebView? view;
    private Navigation? navigation;
    private BrowserUi? browserUi;
    private WKContentRuleList? ruleList;
    private WKContentRuleListStore? rulesStore;
    private readonly List<DesktopPopupWindow> popups = [];
    private Task startup = Task.CompletedTask;
    private bool exiting;
    private string data = "";
    private DesktopInstances? instances;
    // The instance the web view shows: its origin and base path.
    private Uri? scope;
    // Incremented by every switch, so that a slower earlier one doesn't navigate afterwards.
    private int generation;
    private readonly SemaphoreSlim switching = new(1, 1);
    private readonly NSStackView placeholder = new()
    {
        Orientation = NSUserInterfaceLayoutOrientation.Vertical,
        Spacing = 16,
        Alignment = NSLayoutAttribute.CenterX,
    };
    private readonly NSTextField status = NSTextField.CreateWrappingLabel("Starting Foxwarm…");
    private readonly NSStackView actions = new()
    {
        Orientation = NSUserInterfaceLayoutOrientation.Horizontal,
        Spacing = 8,
    };
    private readonly List<NSButton> actionButtons = [];

    public override void DidFinishLaunching(NSNotification notification)
    {
        var appMenu = new NSMenu();
        appMenu.AddItem(new NSMenuItem("Open Foxwarm", (_, _) => OpenWindow()));
        appMenu.AddItem(NSMenuItem.SeparatorItem);
        appMenu.AddItem(
            new NSMenuItem(
                "Quit Foxwarm",
                "q",
                (_, _) => NSApplication.SharedApplication.Terminate(null)
            )
        );
        var menu = new NSMenu();
        menu.AddItem(new NSMenuItem { Submenu = appMenu });
        var edit = new NSMenu("Edit");
        edit.AddItem(new NSMenuItem("Undo", new ObjCRuntime.Selector("undo:"), "z"));
        edit.AddItem(new NSMenuItem("Cut", new ObjCRuntime.Selector("cut:"), "x"));
        edit.AddItem(new NSMenuItem("Copy", new ObjCRuntime.Selector("copy:"), "c"));
        edit.AddItem(new NSMenuItem("Paste", new ObjCRuntime.Selector("paste:"), "v"));
        edit.AddItem(new NSMenuItem("Select All", new ObjCRuntime.Selector("selectAll:"), "a"));
        menu.AddItem(new NSMenuItem("Edit") { Submenu = edit });
        // The fallback entry, also for a page without the brand row (an older WebUI, an error page).
        var instancesMenu = new NSMenu("Instances") { Delegate = new InstancesMenuUpdater(this) };
        menu.AddItem(new NSMenuItem("Instances") { Submenu = instancesMenu });
        NSApplication.SharedApplication.MainMenu = menu;
        window = new NSWindow(
            new CGRect(0, 0, 1100, 760),
            NSWindowStyle.Titled
                | NSWindowStyle.Closable
                | NSWindowStyle.Resizable
                | NSWindowStyle.Miniaturizable,
            NSBackingStore.Buffered,
            false
        )
        {
            Title = "Foxwarm",
            MinSize = new CGSize(640, 440),
        };
        window.ReleaseWhenClosed(false);
        frame = new DesktopFrame(window, DesktopWindowFrame.WebUi, (webView, anchor) => ShowInstanceMenu(webView, anchor));
        status.Alignment = NSTextAlignment.Center;
        status.PreferredMaxLayoutWidth = 520;
        placeholder.AddArrangedSubview(status);
        placeholder.AddArrangedSubview(actions);
        placeholder.TranslatesAutoresizingMaskIntoConstraints = false;
        var content = window.ContentView!;
        content.AddSubview(placeholder);
        NSLayoutConstraint.ActivateConstraints([
            placeholder.CenterXAnchor.ConstraintEqualTo(content.CenterXAnchor),
            placeholder.CenterYAnchor.ConstraintEqualTo(content.CenterYAnchor),
            placeholder.WidthAnchor.ConstraintLessThanOrEqualTo(content.WidthAnchor, 1, -48),
        ]);
        actions.Hidden = true;
        window.Center();
        OpenWindow();
        startup = StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            data = Path.GetFullPath(
                Environment.GetEnvironmentVariable("FOXWARM_DATA_DIR")
                    ?? Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                        "Library",
                        "Application Support",
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
            var webConfiguration = new WKWebViewConfiguration
            {
                WebsiteDataStore = WKWebsiteDataStore.DefaultDataStore,
            };
            var rulesDirectory = Path.Combine(data, "webkit-content-rules");
            Directory.CreateDirectory(rulesDirectory);
            rulesStore = WKContentRuleListStore.FromUrl(NSUrl.FromFilename(rulesDirectory));
            // The first switch sets the real scope, with its rules, before the first navigation.
            scope = new Uri("http://127.0.0.1/");
            // The frame's one-way script message is the only page-to-host channel.
            frame!.Configure(webConfiguration, scope);
            navigation = new Navigation(this, frame, null);
            browserUi = new BrowserUi(this);
            view = new WKWebView(window!.ContentView!.Bounds, webConfiguration)
            {
                AutoresizingMask =
                    NSViewResizingMask.WidthSizable | NSViewResizingMask.HeightSizable,
                NavigationDelegate = navigation,
                UIDelegate = browserUi,
                Hidden = true,
            };
            window.ContentView.AddSubview(view, NSWindowOrderingMode.Below, placeholder);
            frame.Attach(view);
            await SwitchAsync(instances.Selected, retry: false);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            if (!exiting)
                ShowMessage("Foxwarm could not start.\n\n" + error.Message);
            await StopLocalHostAsync();
        }
    }

    /// <summary>
    /// Shows the selected instance: starts local Main on demand, closes the previous
    /// instance's app windows and moves the scope and its resource rules before navigating.
    /// </summary>
    private async Task SwitchAsync(Uri? remote, bool retry = true)
    {
        if (exiting || view is null || frame is null || instances is null || rulesStore is null)
            return;
        var current = ++generation;
        await switching.WaitAsync();
        try
        {
            if (current != generation || exiting)
                return;
            instances.Select(remote);
            CloseAppWindows();
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
                        ("Try Again", () => _ = SwitchAsync(null)),
                        ("Switch Instance", null)
                    );
                    return;
                }
                target = endpoint;
            }
            else
                target = remote;
            if (scope != target || view.Hidden)
                ShowMessage(IsLocal(target) ? "Opening Foxwarm…" : "Opening " + DesktopInstances.Label(target) + "…");
            if (scope != target || ruleList is null)
            {
                var rules = await CompileRulesAsync(target);
                if (current != generation || exiting)
                    return;
                var controller = view.Configuration.UserContentController;
                controller.RemoveAllContentRuleLists();
                controller.AddContentRuleList(rules);
                ruleList = rules;
            }
            scope = target;
            frame.SetScope(target);
            view.LoadRequest(new NSUrlRequest(new NSUrl(target.AbsoluteUri)));
        }
        catch (Exception error) when (error is HttpRequestException or IOException or InvalidOperationException or NSErrorException)
        {
            if (current == generation && !exiting)
                ShowMessage(
                    "Foxwarm could not open.\n\n" + error.Message,
                    ("Try Again", () => _ = SwitchAsync(instances.Selected)),
                    ("Switch Instance", null)
                );
        }
        finally
        {
            switching.Release();
        }
    }

    /// <summary>Blocks HTTP(S) loads outside the scope, in every window of the app.</summary>
    private async Task<WKContentRuleList> CompileRulesAsync(Uri target)
    {
        var prefix = target.GetLeftPart(UriPartial.Authority) + target.AbsolutePath;
        var rules = new JsonArray(
            new JsonObject
            {
                ["trigger"] = new JsonObject { ["url-filter"] = "^https?://" },
                ["action"] = new JsonObject { ["type"] = "block" },
            },
            Allow("^" + Regex.Escape(prefix))
        );
        // A base path without its trailing slash is the instance's root too. Content-rule
        // filters have no alternation, so each form is its own rule.
        if (target.AbsolutePath != "/")
        {
            var bare = Regex.Escape(prefix.TrimEnd('/'));
            rules.Add((JsonNode)Allow("^" + bare + "$"));
            rules.Add((JsonNode)Allow("^" + bare + "\\?"));
        }
        return await rulesStore!.CompileContentRuleListAsync("FoxwarmInstanceResources", rules.ToJsonText());

        static JsonObject Allow(string filter) =>
            new()
            {
                ["trigger"] = new JsonObject { ["url-filter"] = filter },
                ["action"] = new JsonObject { ["type"] = "ignore-previous-rules" },
            };
    }

    /// <summary>Replaces the page with a message and optional actions; an action without a callback opens the instance menu.</summary>
    private void ShowMessage(string text, params (string Label, Action? Action)[] buttons)
    {
        if (view is not null)
            view.Hidden = true;
        frame?.ResetRegions();
        status.StringValue = text;
        foreach (var button in actionButtons)
        {
            actions.RemoveView(button);
            button.Dispose();
        }
        actionButtons.Clear();
        foreach (var (label, action) in buttons)
        {
            NSButton? created = null;
            created = NSButton.CreateButton(label, () =>
            {
                if (action is not null)
                    action();
                else
                    ShowInstanceMenu(created!);
            });
            actionButtons.Add(created);
            actions.AddArrangedSubview(created);
        }
        actions.Hidden = buttons.Length == 0;
        placeholder.Hidden = false;
    }

    private void ShowPage()
    {
        placeholder.Hidden = true;
        if (view is not null)
            view.Hidden = false;
    }

    private void CloseAppWindows()
    {
        foreach (var popup in popups.ToArray())
            popup.Window.Close();
    }

    /// <summary>
    /// Opens a new-window request in the scope as an app window. Its web view must be built
    /// from WebKit's configuration, which keeps the opener relationship.
    /// </summary>
    private WKWebView OpenWindow(
        WKWebView opener,
        WKWebViewConfiguration configuration,
        string? url,
        DesktopTarget target,
        WKWindowFeatures features
    )
    {
        var popup = new DesktopPopupWindow(
            opener.Window,
            configuration,
            ruleList!,
            scope!,
            DesktopNavigation.FrameFor(scope!, url),
            target == DesktopTarget.Blank,
            features,
            closed => popups.Remove(closed),
            (webView, anchor) => ShowInstanceMenu(webView, anchor)
        );
        var policy = new Navigation(this, popup.Frame, popup);
        popup.Navigation = policy;
        popup.View.NavigationDelegate = policy;
        popup.View.UIDelegate = browserUi!;
        popups.Add(popup);
        popup.Show();
        return popup.View;
    }

    private static void OpenExternal(NSUrl? url)
    {
        if (url?.Scheme is "http" or "https")
            NSWorkspace.SharedWorkspace.OpenUrl(url);
    }

    private void OpenWindow()
    {
        if (exiting || window is null)
            return;
        window.Deminiaturize(null);
        window.MakeKeyAndOrderFront(null);
        NSApplication.SharedApplication.Activate();
    }

    public override bool ApplicationShouldHandleReopen(NSApplication sender, bool hasVisibleWindows)
    {
        OpenWindow();
        return true;
    }

    public override bool ApplicationShouldTerminateAfterLastWindowClosed(NSApplication sender) =>
        false;

    public override NSApplicationTerminateReply ApplicationShouldTerminate(NSApplication sender)
    {
        if (!exiting)
        {
            exiting = true;
            CloseAppWindows();
            _ = StopAsync(sender);
        }
        return NSApplicationTerminateReply.Later;
    }

    private async Task StopAsync(NSApplication sender)
    {
        try
        {
            await startup;
            view?.StopLoading();
            await StopLocalHostAsync();
        }
        finally
        {
            sender.ReplyToApplicationShouldTerminate(true);
        }
    }

    private sealed class Navigation(
        DesktopApplication owner,
        DesktopFrame? frame,
        DesktopPopupWindow? popup
    ) : WKNavigationDelegate
    {
        public override void DidStartProvisionalNavigation(WKWebView webView, WKNavigation navigation) =>
            frame?.ResetRegions();

        public override void DidFinishNavigation(WKWebView webView, WKNavigation navigation)
        {
            if (popup is null && !owner.exiting && !DesktopNavigation.IsBlank(webView.Url?.AbsoluteString))
                owner.ShowPage();
        }

        public override void DidFailProvisionalNavigation(WKWebView webView, WKNavigation navigation, NSError error) =>
            Failed(error);

        public override void DidFailNavigation(WKWebView webView, WKNavigation navigation, NSError error) =>
            Failed(error);

        // The main window's document could not load: the instance isn't reachable.
        private void Failed(NSError error)
        {
            if (popup is not null || owner.exiting || owner.scope is not { } scope)
                return;
            // A navigation replaced by another one, or refused by the navigation policy.
            if (
                (error.Domain == NSError.NSUrlErrorDomain.ToString() && error.Code == (long)NSUrlError.Cancelled)
                || (error.Domain == "WebKitErrorDomain" && error.Code == 102)
            )
                return;
            owner.ShowMessage(
                owner.IsLocal(scope) ? "Foxwarm could not open." : DesktopInstances.Label(scope) + " could not be reached.",
                ("Try Again", () => _ = owner.SwitchAsync(owner.instances?.Selected)),
                ("Switch Instance", null)
            );
        }

        public override void DecidePolicy(
            WKWebView webView,
            WKNavigationAction action,
            Action<WKNavigationActionPolicy> decisionHandler
        )
        {
            var target = DesktopNavigation.Classify(owner.scope!, action.Request.Url?.AbsoluteString);
            var mainFrame = action.TargetFrame?.MainFrame != false;
            if (target is DesktopTarget.App or DesktopTarget.Blank)
            {
                if (mainFrame && target == DesktopTarget.App)
                    popup?.ShowsPage();
                decisionHandler(WKNavigationActionPolicy.Allow);
                return;
            }
            decisionHandler(WKNavigationActionPolicy.Cancel);
            if (!mainFrame)
                return;
            if (target == DesktopTarget.Browser)
                OpenExternal(action.Request.Url);
            popup?.LeftApp();
        }
    }

    private sealed class BrowserUi(DesktopApplication owner) : WKUIDelegate
    {
        public override async void RunJavaScriptAlertPanel(
            WKWebView webView,
            string message,
            WKFrameInfo frame,
            Action completionHandler
        )
        {
            using var alert = new NSAlert { MessageText = "Foxwarm", InformativeText = message };
            alert.AddButton("OK");
            await alert.BeginSheetAsync(webView.Window!);
            completionHandler();
        }

        public override async void RunJavaScriptConfirmPanel(
            WKWebView webView,
            string message,
            WKFrameInfo frame,
            Action<bool> completionHandler
        )
        {
            using var alert = new NSAlert { MessageText = "Foxwarm", InformativeText = message };
            alert.AddButton("OK");
            alert.AddButton("Cancel");
            var result = await alert.BeginSheetAsync(webView.Window!);
            completionHandler((long)result == 1000);
        }

        public override void RunOpenPanel(
            WKWebView webView,
            WKOpenPanelParameters parameters,
            WKFrameInfo frame,
            Action<NSUrl[]> completionHandler
        )
        {
            var panel = NSOpenPanel.OpenPanel;
            panel.CanChooseFiles = true;
            panel.CanChooseDirectories = parameters.AllowsDirectories;
            panel.AllowsMultipleSelection = parameters.AllowsMultipleSelection;
            panel.BeginSheet(
                webView.Window!,
                result =>
                {
                    try
                    {
                        completionHandler(
                            (long)result == (long)NSModalResponse.OK ? panel.Urls : []
                        );
                    }
                    finally
                    {
                        panel.Dispose();
                    }
                }
            );
        }

        public override WKWebView? CreateWebView(
            WKWebView webView,
            WKWebViewConfiguration configuration,
            WKNavigationAction action,
            WKWindowFeatures windowFeatures
        )
        {
            var url = action.Request.Url?.AbsoluteString;
            var target = DesktopNavigation.Classify(owner.scope!, url);
            if (owner.exiting || target is DesktopTarget.Browser or DesktopTarget.Ignore)
            {
                // Returning no web view makes window.open return null.
                if (!owner.exiting && target == DesktopTarget.Browser)
                    OpenExternal(action.Request.Url);
                return null;
            }
            return owner.OpenWindow(webView, configuration, url, target, windowFeatures);
        }

        // window.close() from the page, including the opener closing its popup.
        public override void DidClose(WKWebView webView) =>
            owner.popups.FirstOrDefault(popup => popup.View == webView)?.CloseLater();

        public override void RequestMediaCapturePermission(
            WKWebView webView,
            WKSecurityOrigin origin,
            WKFrameInfo frame,
            WKMediaCaptureType type,
            Action<WKPermissionDecision> decisionHandler
        )
        {
            decisionHandler(WKPermissionDecision.Deny);
        }
    }
}
