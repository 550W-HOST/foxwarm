namespace Foxwarm;

/// <summary>Where a Desktop host sends a top-level navigation or a new-window request.</summary>
internal enum DesktopTarget
{
    /// <summary>The app's own origin: stays in the app (a new window opens an app window).</summary>
    App,

    /// <summary>
    /// <c>about:blank</c>: an empty app window that its opener scripts. Its first navigation
    /// decides what it becomes.
    /// </summary>
    Blank,

    /// <summary>Another HTTP(S) origin: the default browser.</summary>
    Browser,

    /// <summary>Anything else: refused.</summary>
    Ignore,
}

/// <summary>
/// Navigation and window policy shared by the Windows and macOS hosts. Same-origin pages
/// stay in the app, including new windows; other web pages go to the default browser.
/// </summary>
internal static class DesktopNavigation
{
    /// <summary>Width and height, in DIPs, of an app window opened without a requested size.</summary>
    internal const double DefaultWidth = 1100;
    internal const double DefaultHeight = 760;

    /// <summary>Smallest app window, in DIPs; requested sizes are clamped to it.</summary>
    internal const double MinimumWidth = 480;
    internal const double MinimumHeight = 360;

    /// <summary>Offset of a new window from its opener's top-left corner, in DIPs.</summary>
    internal const double Cascade = 32;

    internal static bool IsApp(Uri origin, string? text) =>
        Uri.TryCreate(text, UriKind.Absolute, out var uri)
        && uri.Scheme == origin.Scheme
        && string.Equals(uri.Host, origin.Host, StringComparison.OrdinalIgnoreCase)
        && uri.Port == origin.Port;

    internal static bool IsBlank(string? text)
    {
        if (string.IsNullOrEmpty(text))
            return true;
        var hash = text.IndexOf('#', StringComparison.Ordinal);
        return string.Equals(hash < 0 ? text : text[..hash], "about:blank", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Classifies a top-level navigation or a new-window request.</summary>
    internal static DesktopTarget Classify(Uri origin, string? text)
    {
        if (IsBlank(text))
            return DesktopTarget.Blank;
        if (IsApp(origin, text))
            return DesktopTarget.App;
        return Uri.TryCreate(text, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
            ? DesktopTarget.Browser
            : DesktopTarget.Ignore;
    }

    /// <summary>
    /// Whether a new window gets the custom frame: only the WebUI's own document at the app
    /// root speaks the frame protocol. Code, files and other same-origin documents, and
    /// blank windows, keep the system title bar.
    /// </summary>
    internal static bool IsFramed(Uri origin, string? text) =>
        IsApp(origin, text)
        && Uri.TryCreate(text, UriKind.Absolute, out var uri)
        && uri.AbsolutePath == origin.AbsolutePath;

    /// <summary>
    /// Content size of a new app window in DIPs: the requested size (window.open's width and
    /// height, in CSS pixels) clamped between the minimum and the work area, or the default.
    /// </summary>
    internal static (double Width, double Height) WindowSize(
        double? width,
        double? height,
        double workWidth,
        double workHeight
    ) =>
        (Fit(width is > 0 ? width.Value : DefaultWidth, MinimumWidth, workWidth),
            Fit(height is > 0 ? height.Value : DefaultHeight, MinimumHeight, workHeight));

    /// <summary>
    /// Top-left corner of a new window: cascaded from its opener's, kept inside the work area.
    /// All values share one coordinate space with y growing downwards.
    /// </summary>
    internal static (double X, double Y) WindowPosition(
        double openerX,
        double openerY,
        double width,
        double height,
        double workX,
        double workY,
        double workWidth,
        double workHeight,
        double cascade = Cascade
    )
    {
        var x = openerX + cascade;
        var y = openerY + cascade;
        if (x + width > workX + workWidth)
            x = workX + workWidth - width;
        if (y + height > workY + workHeight)
            y = workY + workHeight - height;
        return (Math.Max(workX, x), Math.Max(workY, y));
    }

    private static double Fit(double value, double minimum, double available) =>
        Math.Round(Math.Max(Math.Min(minimum, available), Math.Min(value, available)));
}
