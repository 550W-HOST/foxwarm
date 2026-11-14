using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Windows.Graphics;
using Windows.UI;

namespace Foxwarm.Desktop;

/// <summary>
/// Custom window frame: the WebUI extends into the title bar. The page learns the caption
/// buttons' insets through <c>window.foxwarmFrame</c> and reports its drag surfaces through
/// the one-way <c>frame-regions</c> message, which become the window's caption regions.
/// WinUI's WebView2 control ignores CSS app-region, and the default caption band would
/// swallow clicks on the page's controls, so explicit caption rectangles are always set.
/// </summary>
internal sealed class DesktopFrame
{
    private readonly Window window;
    private readonly WebView2 view;
    private readonly Func<string, bool> isAppUri;
    private CoreWebView2? core;
    private string origin = "";
    private string? scriptId;
    private string state = "";
    private DesktopFrameRegions? regions;
    private bool active = true;

    internal DesktopFrame(Window window, WebView2 view, Func<string, bool> isAppUri)
    {
        this.window = window;
        this.view = view;
        this.isAppUri = isAppUri;
        var bar = window.AppWindow.TitleBar;
        bar.ExtendsContentIntoTitleBar = true;
        // Tall (48 epx) caption buttons: the page makes its title row (brand row and tab
        // strips) exactly as tall as the buttons and centres its controls on them.
        bar.PreferredHeightOption = TitleBarHeightOption.Tall;
        bar.ButtonBackgroundColor = Colors.Transparent;
        bar.ButtonInactiveBackgroundColor = Colors.Transparent;
        ApplyButtonColors(dark: false);
        window.AppWindow.Changed += (_, e) =>
        {
            if (e.DidSizeChange || e.DidPresenterChange)
                Update();
        };
        window.Activated += (_, e) =>
        {
            active = e.WindowActivationState != WindowActivationState.Deactivated;
            // High contrast can change while the window is in the background.
            ApplyButtonColors(regions?.Dark ?? false);
            Update();
        };
    }

    /// <summary>Installs the document-start state and the message handler before the first navigation.</summary>
    internal async Task InstallAsync(CoreWebView2 core, Uri origin)
    {
        this.core = core;
        core.Settings.IsWebMessageEnabled = true;
        core.WebMessageReceived += (_, e) =>
        {
            if (!isAppUri(e.Source))
                return;
            string? json;
            try
            {
                json = e.WebMessageAsJson;
            }
            catch (ArgumentException)
            {
                return;
            }
            var message = DesktopFrameRegions.Parse(json);
            if (message is null)
                return;
            regions = message;
            ApplyButtonColors(message.Dark);
            ApplyRegions();
        };
        core.DocumentTitleChanged += (_, _) =>
            window.Title = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "Foxwarm" : core.DocumentTitle;
        core.NavigationStarting += (_, _) =>
        {
            // A new document has no drag surfaces until it reports them.
            regions = null;
            ApplyRegions();
        };
        this.origin = origin.GetLeftPart(UriPartial.Authority);
        view.XamlRoot.Changed += (_, _) => Update();
        state = StateJson();
        scriptId = await core.AddScriptToExecuteOnDocumentCreatedAsync(DocumentScript(state));
    }

    /// <summary>
    /// Restores the system's default caption band, e.g. while a startup or error message
    /// replaces the page.
    /// </summary>
    internal void Reset()
    {
        regions = null;
        Source().ClearRegionRects(NonClientRegionKind.Caption);
    }

    private double Scale => view.XamlRoot?.RasterizationScale ?? 1;

    private string StateJson()
    {
        var bar = window.AppWindow.TitleBar;
        var scale = Scale;
        // JsonNode items: the generic Add<string> needs reflection metadata, which NativeAOT lacks.
        var tokens = new JsonArray();
        if (!active)
            tokens.Add((JsonNode)"inactive");
        if (window.AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Maximized })
            tokens.Add((JsonNode)"maximized");
        return new JsonObject
        {
            ["platform"] = "windows",
            ["left"] = Math.Round(bar.LeftInset / scale, 2),
            ["right"] = Math.Round(bar.RightInset / scale, 2),
            ["top"] = Math.Round(bar.Height / scale, 2),
            ["state"] = tokens,
        }.ToJsonString();
    }

    // Top-level documents of the owned origin only; frames and other origins see nothing.
    private string DocumentScript(string json) =>
        "if (window === window.top && location.origin === "
        + JsonValue.Create(origin)!.ToJsonString()
        + ") window.foxwarmFrame = "
        + json
        + ";";

    private async void Update()
    {
        if (core is null)
            return;
        ApplyRegions();
        var next = StateJson();
        if (next == state)
            return;
        state = next;
        try
        {
            if (scriptId is not null)
                core.RemoveScriptToExecuteOnDocumentCreated(scriptId);
            scriptId = await core.AddScriptToExecuteOnDocumentCreatedAsync(DocumentScript(next));
            await core.ExecuteScriptAsync(
                DocumentScript(next) + " window.dispatchEvent(new Event('foxwarm-frame'));"
            );
        }
        catch (Exception error) when (error is ObjectDisposedException or InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            // The web view is closing.
        }
    }

    private InputNonClientPointerSource Source() =>
        InputNonClientPointerSource.GetForWindowId(window.AppWindow.Id);

    private void ApplyRegions()
    {
        if (core is null)
            return;
        var bar = window.AppWindow.TitleBar;
        var size = window.AppWindow.ClientSize;
        var rects = regions?.Clip(
                Scale,
                new FrameRect(0, 0, size.Width, size.Height),
                [
                    new FrameRect(0, 0, bar.LeftInset, bar.Height),
                    new FrameRect(size.Width - bar.RightInset, 0, bar.RightInset, bar.Height),
                ]
            )
            .Select(rect =>
            {
                var x = (int)Math.Round(rect.X);
                var y = (int)Math.Round(rect.Y);
                return new RectInt32(x, y, (int)Math.Round(rect.Right) - x, (int)Math.Round(rect.Bottom) - y);
            })
            .Where(rect => rect.Width > 0 && rect.Height > 0)
            .ToArray();
        // An explicit list, even an empty one, replaces the default caption band.
        Source().SetRegionRects(NonClientRegionKind.Caption, rects ?? []);
    }

    private void ApplyButtonColors(bool dark)
    {
        var bar = window.AppWindow.TitleBar;
        if (HighContrast())
        {
            // System-drawn high-contrast colors.
            bar.ButtonForegroundColor = null;
            bar.ButtonHoverForegroundColor = null;
            bar.ButtonHoverBackgroundColor = null;
            bar.ButtonPressedForegroundColor = null;
            bar.ButtonPressedBackgroundColor = null;
            bar.ButtonInactiveForegroundColor = null;
            return;
        }
        var foreground = dark ? Color.FromArgb(255, 0xf3, 0xf4, 0xf6) : Color.FromArgb(255, 0x11, 0x18, 0x27);
        bar.ButtonForegroundColor = foreground;
        bar.ButtonHoverForegroundColor = foreground;
        bar.ButtonPressedForegroundColor = foreground;
        bar.ButtonHoverBackgroundColor = dark ? Color.FromArgb(0x1f, 0xff, 0xff, 0xff) : Color.FromArgb(0x14, 0x00, 0x00, 0x00);
        bar.ButtonPressedBackgroundColor = dark ? Color.FromArgb(0x33, 0xff, 0xff, 0xff) : Color.FromArgb(0x24, 0x00, 0x00, 0x00);
        bar.ButtonInactiveForegroundColor = dark ? Color.FromArgb(255, 0x9c, 0xa3, 0xaf) : Color.FromArgb(255, 0x6b, 0x72, 0x80);
    }

    // WinRT AccessibilitySettings needs a CoreWindow; desktop windows read the system parameter.
    [StructLayout(LayoutKind.Sequential)]
    private struct HighContrastInfo
    {
        public uint Size;
        public uint Flags;
        public IntPtr DefaultScheme;
    }

    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")]
    private static extern bool SystemParametersInfo(uint action, uint parameter, ref HighContrastInfo value, uint update);

    private static bool HighContrast()
    {
        var info = new HighContrastInfo { Size = (uint)Marshal.SizeOf<HighContrastInfo>() };
        return SystemParametersInfo(0x42, info.Size, ref info, 0) && (info.Flags & 1) != 0;
    }
}
