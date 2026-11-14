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
    [InlineData("http://127.0.0.1:49152/", true)]
    [InlineData("http://127.0.0.1:49152/?foxwarmPopup=chat&sessionId=a%2Fb#tab", true)]
    [InlineData("http://127.0.0.1:49152/vscode-web/?nodeId=master", false)]
    [InlineData("http://127.0.0.1:49152/login.html", false)]
    [InlineData("http://127.0.0.1:49152/api/files/x.png", false)]
    [InlineData("about:blank", false)]
    [InlineData("https://example.com/", false)]
    public void Only_the_app_root_document_gets_the_custom_frame(string uri, bool expected) =>
        Assert.Equal(expected, DesktopNavigation.IsFramed(Origin, uri));

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
