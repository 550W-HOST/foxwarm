namespace Foxwarm.Tests;

public sealed class DesktopAuthCookieTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 24, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Scopes_the_local_endpoint_like_the_WebUI_sign_in_cookie()
    {
        var cookie = DesktopAuthCookie.For(new Uri("http://127.0.0.1:54684/"), "a b+c/=", Now);

        Assert.Equal("foxwarm_token", DesktopAuthCookie.Name);
        Assert.Equal("a%20b%2Bc%2F%3D", cookie.Value);
        Assert.Equal("a b+c/=", Uri.UnescapeDataString(cookie.Value));
        Assert.Equal("127.0.0.1", cookie.Domain);
        Assert.Equal("/", cookie.Path);
        Assert.Equal(Now.AddDays(365), cookie.Expires);
        Assert.False(cookie.Secure);
    }

    [Fact]
    public void Is_secure_only_over_https_and_keeps_a_base_path()
    {
        var cookie = DesktopAuthCookie.For(new Uri("https://lab.example/foxwarm/"), "token", Now);

        Assert.Equal("lab.example", cookie.Domain);
        Assert.Equal("/foxwarm/", cookie.Path);
        Assert.True(cookie.Secure);
    }

    // A Strict cookie is withheld on macOS 26 when the app navigates back from another site.
    [Fact]
    public void Is_same_site_lax() => Assert.Equal("Lax", DesktopAuthCookie.SameSite);
}
