namespace Foxwarm.Tests;

public sealed class DesktopNavigationTests
{
    private static readonly Uri Origin = new("http://127.0.0.1:49152/");

    // DesktopTarget is internal, so the theory names its members.
    [Theory]
    [InlineData("http://127.0.0.1:49152/", "App")]
    [InlineData("http://127.0.0.1:49152/?foxwarmPopup=tasks&foxwarmPopupVersion=1", "App")]
    [InlineData("http://127.0.0.1:49152/vscode-web/?nodeId=master", "App")]
    [InlineData("http://127.0.0.1:49152/api/mcp/oauth/callback?code=x&state=y", "App")]
    [InlineData("about:blank", "Blank")]
    [InlineData("About:Blank#top", "Blank")]
    [InlineData("", "Blank")]
    [InlineData(null, "Blank")]
    [InlineData("https://example.com/", "Browser")]
    [InlineData("http://example.com:49152/", "Browser")]
    [InlineData("https://127.0.0.1:49152/", "Browser")]
    [InlineData("http://127.0.0.1:49153/", "Browser")]
    [InlineData("http://localhost:49152/", "Browser")]
    [InlineData("about:srcdoc", "Ignore")]
    [InlineData("javascript:alert(1)", "Ignore")]
    [InlineData("file:///C:/Windows/win.ini", "Ignore")]
    [InlineData("mailto:someone@example.com", "Ignore")]
    [InlineData("data:text/html,hi", "Ignore")]
    [InlineData("relative/path", "Ignore")]
    public void Classifies_navigation_and_new_window_targets(string? uri, string expected) =>
        Assert.Equal(expected, DesktopNavigation.Classify(Origin, uri).ToString());

    [Theory]
    [InlineData("http://127.0.0.1:49152/", "WebUi")]
    [InlineData("http://127.0.0.1:49152/?foxwarmPopup=chat&sessionId=a%2Fb#tab", "WebUi")]
    [InlineData("http://127.0.0.1:49152/vscode-web", "Code")]
    [InlineData("http://127.0.0.1:49152/vscode-web/?nodeId=master#tab", "Code")]
    [InlineData("http://127.0.0.1:49152/VSCODE-WEB", "Code")]
    [InlineData("http://127.0.0.1:49152/vscode-web//", "System")]
    [InlineData("http://127.0.0.1:49152/vscode-web/static/index.html", "System")]
    [InlineData("http://127.0.0.1:49152/vscode-web/callback", "System")]
    [InlineData("http://127.0.0.1:49152/vscode-web-preview", "System")]
    [InlineData("http://127.0.0.1:49152/login.html", "System")]
    [InlineData("http://127.0.0.1:49152/api/files/x.png", "System")]
    [InlineData("about:blank", "System")]
    [InlineData(null, "System")]
    [InlineData("http://127.0.0.1:49153/vscode-web", "System")]
    [InlineData("https://example.com/vscode-web", "System")]
    public void Only_the_app_root_and_Code_documents_get_custom_frames(string? uri, string expected) =>
        Assert.Equal(expected, DesktopNavigation.FrameFor(Origin, uri).ToString());

    private static readonly Uri Remote = new("https://lab.example/foxwarm/");

    [Theory]
    [InlineData("https://lab.example/foxwarm/", "App")]
    [InlineData("https://lab.example/foxwarm", "App")]
    [InlineData("https://lab.example/foxwarm/?foxwarmPopup=tasks", "App")]
    [InlineData("https://lab.example/foxwarm/vscode-web/?nodeId=master", "App")]
    [InlineData("https://LAB.example/foxwarm/api/auth/session", "App")]
    [InlineData("https://lab.example/", "Browser")]
    [InlineData("https://lab.example/foxwarm-other/", "Browser")]
    [InlineData("https://lab.example/Foxwarm/", "Browser")]
    [InlineData("https://lab.example/other/foxwarm/", "Browser")]
    [InlineData("http://lab.example/foxwarm/", "Browser")]
    [InlineData("https://lab.example:8443/foxwarm/", "Browser")]
    [InlineData("about:blank", "Blank")]
    public void A_remote_scope_is_its_origin_and_base_path(string? uri, string expected) =>
        Assert.Equal(expected, DesktopNavigation.Classify(Remote, uri).ToString());

    [Theory]
    [InlineData("https://lab.example/foxwarm/", "WebUi")]
    [InlineData("https://lab.example/foxwarm", "WebUi")]
    [InlineData("https://lab.example/foxwarm/?foxwarmPopup=chat&sessionId=a", "WebUi")]
    [InlineData("https://lab.example/foxwarm/vscode-web/", "Code")]
    [InlineData("https://lab.example/vscode-web/", "System")]
    [InlineData("https://lab.example/", "System")]
    [InlineData("https://lab.example/foxwarm/login.html", "System")]
    public void A_remote_scope_frames_its_own_root_and_Code(string? uri, string expected) =>
        Assert.Equal(expected, DesktopNavigation.FrameFor(Remote, uri).ToString());

    [Fact]
    public void The_document_condition_names_the_origin_and_base_path()
    {
        Assert.Equal(
            "window === window.top && location.origin === \"http://127.0.0.1:49152\"",
            DesktopNavigation.ScopeCondition(Origin)
        );
        Assert.Equal(
            "window === window.top && location.origin === \"https://lab.example\""
                + " && (location.pathname.startsWith(\"/foxwarm/\") || location.pathname === \"/foxwarm\")",
            DesktopNavigation.ScopeCondition(Remote)
        );
        // Quotes and script terminators in a path stay inside the string literal.
        var odd = DesktopNavigation.ScopeCondition(new Uri("https://lab.example/a%22b%3C/script%3E/"));
        Assert.DoesNotContain("</script>", odd, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("\"/a%22b%3C/script%3E/\"", odd);
    }

    [Fact]
    public void Window_size_honours_requests_within_the_minimum_and_the_work_area()
    {
        Assert.Equal((1100d, 760d), DesktopNavigation.WindowSize(null, null, 1920, 1040));
        Assert.Equal((720d, 800d), DesktopNavigation.WindowSize(720, 800, 1920, 1040));
        Assert.Equal((480d, 360d), DesktopNavigation.WindowSize(100, 50, 1920, 1040));
        Assert.Equal((1366d, 728d), DesktopNavigation.WindowSize(4000, 3000, 1366, 728));
        Assert.Equal((1100d, 300d), DesktopNavigation.WindowSize(0, 900, 1920, 300));
    }

    [Fact]
    public void Window_position_cascades_from_the_opener_inside_the_work_area()
    {
        Assert.Equal((132d, 82d), DesktopNavigation.WindowPosition(100, 50, 800, 600, 0, 0, 1920, 1040));
        // Too close to the bottom-right corner: pulled back inside.
        Assert.Equal((1120d, 440d), DesktopNavigation.WindowPosition(1500, 900, 800, 600, 0, 0, 1920, 1040));
        // Larger than the work area: pinned to its top-left.
        Assert.Equal((-1920d, 0d), DesktopNavigation.WindowPosition(-1900, 10, 2400, 1200, -1920, 0, 1920, 1040));
    }
}
