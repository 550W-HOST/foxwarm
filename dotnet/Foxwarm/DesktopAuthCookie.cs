namespace Foxwarm;

/// <summary>
/// The local instance's sign-in cookie. After posting the token to local Main's
/// <c>/api/auth</c>, the Desktop hosts put it into their web view's cookie store with these
/// properties. It has the name, path and lifetime of the WebUI's own sign-in cookie
/// (<c>browserAuth.ts</c>) and its SameSite=Lax, and is HttpOnly because pages never need it.
/// </summary>
/// <remarks>
/// Lax rather than Strict: WebKit on macOS 26 withholds a Strict cookie from a client
/// <c>loadRequest</c> issued while the view shows another site's document, so switching back
/// from a remote instance would load the local sign-in page.
/// </remarks>
internal sealed record DesktopAuthCookie(
    string Value,
    string Domain,
    string Path,
    DateTimeOffset Expires,
    bool Secure
)
{
    internal const string Name = "foxwarm_token";

    /// <summary>"Lax", as the hosts' SameSite enumerations name it.</summary>
    internal const string SameSite = "Lax";

    internal static DesktopAuthCookie For(Uri endpoint, string token, DateTimeOffset now) =>
        new(
            Uri.EscapeDataString(token),
            endpoint.Host,
            endpoint.AbsolutePath,
            now.AddDays(365),
            endpoint.Scheme == Uri.UriSchemeHttps
        );
}
