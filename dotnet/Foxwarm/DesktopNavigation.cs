namespace Foxwarm;

/// <summary>Where a Desktop host sends a top-level navigation or a new-window request.</summary>
internal enum DesktopTarget
{
    /// <summary>
    /// The selected instance (its origin and base path): stays in the app (a new window opens
    /// an app window).
    /// </summary>
    App,

    /// <summary>
    /// <c>about:blank</c>: an empty app window that its opener scripts. Its first navigation
    /// decides what it becomes.
    /// </summary>
    Blank,

    /// <summary>Another HTTP(S) page, outside the scope: the default browser.</summary>
    Browser,

    /// <summary>Anything else: refused.</summary>
    Ignore,
}

internal enum DesktopWindowFrame
{
    System,
    WebUi,
    Code,
}

/// <summary>
/// Navigation and window policy shared by the Windows and macOS hosts. The app's scope is
/// the selected instance: its origin plus its base path (<c>/</c> for the local instance, for
/// example <c>/foxwarm/</c> for a remote behind a path). Pages in the scope stay in the app,
/// including new windows; other web pages go to the default browser.
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

    /// <summary>Whether a URL is in the scope: same scheme, host and port, and within the base path.</summary>
    internal static bool IsApp(Uri scope, string? text) =>
        Uri.TryCreate(text, UriKind.Absolute, out var uri)
        && uri.Scheme == scope.Scheme
        && string.Equals(uri.Host, scope.Host, StringComparison.OrdinalIgnoreCase)
        && uri.Port == scope.Port
        && InBasePath(scope.AbsolutePath, uri.AbsolutePath);

    /// <summary>
    /// A base path <c>/a/</c> holds <c>/a</c> and everything below <c>/a/</c>, but not <c>/ab</c>.
    /// Paths are compared as escaped by <see cref="Uri"/>, case-sensitively.
    /// </summary>
    internal static bool InBasePath(string basePath, string path)
    {
        if (basePath == "/")
            return true;
        return path.StartsWith(basePath, StringComparison.Ordinal)
            || path == basePath.TrimEnd('/');
    }

    /// <summary>
    /// A JavaScript expression that is true only in a top-level document of the scope. The
    /// hosts guard their document-start frame state with it.
    /// </summary>
    internal static string ScopeCondition(Uri scope)
    {
        var origin = System.Text.Json.Nodes.JsonValue.Create(scope.GetLeftPart(UriPartial.Authority))!.ToJsonText();
        var condition = "window === window.top && location.origin === " + origin;
        var basePath = scope.AbsolutePath;
        if (basePath == "/")
            return condition;
        var prefix = System.Text.Json.Nodes.JsonValue.Create(basePath)!.ToJsonText();
        var exact = System.Text.Json.Nodes.JsonValue.Create(basePath.TrimEnd('/'))!.ToJsonText();
        return condition
            + " && (location.pathname.startsWith("
            + prefix
            + ") || location.pathname === "
            + exact
            + ")";
    }

    internal static bool IsBlank(string? text)
    {
        if (string.IsNullOrEmpty(text))
            return true;
        var hash = text.IndexOf('#', StringComparison.Ordinal);
        return string.Equals(hash < 0 ? text : text[..hash], "about:blank", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Classifies a top-level navigation or a new-window request.</summary>
    internal static DesktopTarget Classify(Uri scope, string? text)
    {
        if (IsBlank(text))
            return DesktopTarget.Blank;
        if (IsApp(scope, text))
            return DesktopTarget.App;
        return Uri.TryCreate(text, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
            ? DesktopTarget.Browser
            : DesktopTarget.Ignore;
    }

    /// <summary>The title area is selected once, from the requested URL of a new window.</summary>
    internal static DesktopWindowFrame FrameFor(Uri scope, string? text)
    {
        if (!IsApp(scope, text) || !Uri.TryCreate(text, UriKind.Absolute, out var uri))
            return DesktopWindowFrame.System;
        if (uri.AbsolutePath == scope.AbsolutePath || uri.AbsolutePath == scope.AbsolutePath.TrimEnd('/'))
            return DesktopWindowFrame.WebUi;
        var codePath = scope.AbsolutePath.TrimEnd('/') + Code.CodeWorkbench.RoutePath;
        return uri.AbsolutePath.Equals(codePath, StringComparison.OrdinalIgnoreCase)
            || uri.AbsolutePath.Equals(codePath + "/", StringComparison.OrdinalIgnoreCase)
            ? DesktopWindowFrame.Code
            : DesktopWindowFrame.System;
    }

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
