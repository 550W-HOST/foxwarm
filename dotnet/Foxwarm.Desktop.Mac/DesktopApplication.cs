using System.Net.Http.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using AppKit;
using CoreGraphics;
using Foundation;
using Foxwarm.Models;
using WebKit;

namespace Foxwarm.Desktop;

[Register("FoxwarmDesktopApplication")]
internal sealed partial class DesktopApplication : NSApplicationDelegate
{
    private MainHost? host;
    private NSWindow? window;
    private WKWebView? view;
    private Navigation? navigation;
    private BrowserUi? browserUi;
    private Uri? endpoint;
    private Task startup = Task.CompletedTask;
    private bool exiting;
    private readonly NSTextField status = NSTextField.CreateLabel("Starting Foxwarm…");

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
        status.Frame = new CGRect(24, 24, 1000, 80);
        status.AutoresizingMask = NSViewResizingMask.WidthSizable;
        window.ContentView!.AddSubview(status);
        window.Center();
        OpenWindow();
        startup = StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            var data = Path.GetFullPath(
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
            var configuration = new ModelConfiguration(HostPaths.ForDataRoot(data));
            var dist = Path.Combine(configuration.Paths.ResourceRoot, "webui-dist");
            if (!File.Exists(Path.Combine(dist, "index.html")))
                throw new InvalidDataException(
                    "The WebUI is missing from the Foxwarm application."
                );
            var http = await HttpServerSettings.CaptureDesktopAsync(data);
            host = await Task.Run(async () =>
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
            _ = ObserveHostAsync();
            endpoint = new Uri(http.Address.BaseUrl);
            await File.WriteAllTextAsync(
                Path.Combine(data, "state", "desktop-port"),
                endpoint.Port.ToString(System.Globalization.CultureInfo.InvariantCulture)
            );
            if (exiting)
                return;
            var webConfiguration = new WKWebViewConfiguration
            {
                WebsiteDataStore = WKWebsiteDataStore.DefaultDataStore,
            };
            var rulesDirectory = Path.Combine(data, "webkit-content-rules");
            Directory.CreateDirectory(rulesDirectory);
            using var rulesStore = WKContentRuleListStore.FromUrl(
                NSUrl.FromFilename(rulesDirectory)
            );
            var rules = new JsonArray(
                new JsonObject
                {
                    ["trigger"] = new JsonObject { ["url-filter"] = "^https?://" },
                    ["action"] = new JsonObject { ["type"] = "block" },
                },
                new JsonObject
                {
                    ["trigger"] = new JsonObject
                    {
                        ["url-filter"] =
                            "^" + Regex.Escape(endpoint.GetLeftPart(UriPartial.Authority)) + "/",
                    },
                    ["action"] = new JsonObject { ["type"] = "ignore-previous-rules" },
                }
            );
            var ruleList = await rulesStore.CompileContentRuleListAsync(
                "FoxwarmLocalResources",
                rules.ToJsonString()
            );
            if (exiting)
                return;
            webConfiguration.UserContentController.AddContentRuleList(ruleList);
            navigation = new Navigation(this);
            browserUi = new BrowserUi();
            view = new WKWebView(window!.ContentView!.Bounds, webConfiguration)
            {
                AutoresizingMask =
                    NSViewResizingMask.WidthSizable | NSViewResizingMask.HeightSizable,
                NavigationDelegate = navigation,
                UIDelegate = browserUi,
            };
            await AuthenticateAsync(http.Token);
            if (exiting)
                return;
            window.ContentView.AddSubview(view);
            // Hidden beneath the web view, the startup label would otherwise remain in the
            // accessibility tree.
            status.RemoveFromSuperview();
            view.LoadRequest(new NSUrlRequest(new NSUrl(endpoint.AbsoluteUri)));
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            status.StringValue = "Foxwarm could not start.\n\n" + error.Message;
            if (host is not null)
            {
                var failedHost = host;
                host = null;
                await failedHost.DisposeAsync();
            }
        }
    }

    private async Task AuthenticateAsync(string token)
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
            MainJsonContext.Default.JsonObject
        );
        response.EnsureSuccessStatusCode();
        using var properties = new NSMutableDictionary
        {
            [NSHttpCookie.KeyName] = new NSString("foxwarm_token"),
            [NSHttpCookie.KeyValue] = new NSString(Uri.EscapeDataString(token)),
            [NSHttpCookie.KeyDomain] = new NSString(endpoint!.Host),
            [NSHttpCookie.KeyPath] = new NSString(endpoint.AbsolutePath),
            [NSHttpCookie.KeyExpires] = NSDate.FromTimeIntervalSinceNow(365 * 24 * 60 * 60),
            [NSHttpCookie.KeySameSitePolicy] = NSHttpCookie.KeySameSiteStrict,
            [new NSString("HttpOnly")] = new NSString("TRUE"),
        };
        using var cookie = new NSHttpCookie(properties);
        await view!.Configuration.WebsiteDataStore.HttpCookieStore.SetCookieAsync(cookie);
    }

    private bool IsAppUri(string? text) =>
        Uri.TryCreate(text, UriKind.Absolute, out var uri)
        && endpoint is not null
        && uri.Scheme == endpoint.Scheme
        && uri.Host == endpoint.Host
        && uri.Port == endpoint.Port;

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

    private async Task ObserveHostAsync()
    {
        await host!.WaitForShutdownAsync();
        NSApplication.SharedApplication.BeginInvokeOnMainThread(() =>
        {
            if (!exiting && host is not null)
                NSApplication.SharedApplication.Terminate(null);
        });
    }

    public override NSApplicationTerminateReply ApplicationShouldTerminate(NSApplication sender)
    {
        if (!exiting)
        {
            exiting = true;
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
            if (host is not null)
                await host.DisposeAsync();
        }
        finally
        {
            sender.ReplyToApplicationShouldTerminate(true);
        }
    }

    private sealed class Navigation(DesktopApplication owner) : WKNavigationDelegate
    {
        public override void DecidePolicy(
            WKWebView webView,
            WKNavigationAction action,
            Action<WKNavigationActionPolicy> decisionHandler
        )
        {
            if (owner.IsAppUri(action.Request.Url?.AbsoluteString))
            {
                decisionHandler(WKNavigationActionPolicy.Allow);
                return;
            }
            decisionHandler(WKNavigationActionPolicy.Cancel);
            if (action.TargetFrame?.MainFrame != false)
                OpenExternal(action.Request.Url);
        }
    }

    private sealed class BrowserUi : WKUIDelegate
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
            OpenExternal(action.Request.Url);
            return null;
        }

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
