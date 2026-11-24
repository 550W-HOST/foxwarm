using System.Text;

namespace Foxwarm;

/// <summary>
/// Download rules shared by the Desktop hosts (D-desktop-downloads): which requests may
/// become downloads, and the file name a download is offered under. The macOS host applies
/// them to WebKit's downloads, the Windows host to WebView2's.
/// </summary>
internal static class DesktopDownloadPolicy
{
    /// <summary>The name offered when a download suggests none that is usable.</summary>
    internal const string FallbackName = "download";

    // APFS and most other file systems limit a name to 255 bytes of UTF-8.
    private const int MaximumNameBytes = 255;

    /// <summary>
    /// Whether a download may start. An HTTP(S) download must be in the scope. A <c>blob:</c>
    /// or <c>data:</c> download is created by a page, so <paramref name="page"/>, the URL of
    /// the requesting window's document, must be in the scope (or the blank document of an
    /// app window, which only a page of the scope opens), and a <c>blob:</c> URL must also
    /// belong to the scope's origin.
    /// </summary>
    internal static bool Allows(Uri scope, string? url, string? page)
    {
        if (string.IsNullOrEmpty(url))
            return false;
        // A data: URL can be far longer than Uri accepts, so it is recognized by its prefix.
        if (url.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            return FromApp(scope, page);
        if (url.StartsWith("blob:", StringComparison.OrdinalIgnoreCase))
            return FromApp(scope, page)
                && Uri.TryCreate(url["blob:".Length..], UriKind.Absolute, out var origin)
                && origin.Scheme == scope.Scheme
                && string.Equals(origin.Host, scope.Host, StringComparison.OrdinalIgnoreCase)
                && origin.Port == scope.Port;
        return Uri.TryCreate(url, UriKind.Absolute, out var uri)
            && uri.Scheme is "http" or "https"
            && DesktopNavigation.IsApp(scope, url);
    }

    private static bool FromApp(Uri scope, string? page) =>
        !string.IsNullOrEmpty(page) && (DesktopNavigation.IsApp(scope, page) || DesktopNavigation.IsBlank(page));

    /// <summary>Whether a <c>Content-Disposition</c> header asks for an attachment (RFC 6266).</summary>
    internal static bool IsAttachment(string? contentDisposition)
    {
        if (string.IsNullOrWhiteSpace(contentDisposition))
            return false;
        var separator = contentDisposition.IndexOf(';', StringComparison.Ordinal);
        var type = separator < 0 ? contentDisposition : contentDisposition[..separator];
        return type.Trim().Equals("attachment", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// A file name for a suggested download name: path separators, colons and control
    /// characters become <c>_</c>, leading dots and surrounding spaces are dropped (a
    /// download never arrives hidden), and the name keeps its extension within 255 bytes.
    /// </summary>
    internal static string FileName(string? suggested)
    {
        var builder = new StringBuilder();
        foreach (var character in suggested ?? "")
            builder.Append(character is '/' or '\\' or ':' || char.IsControl(character) ? '_' : character);
        var name = builder.ToString().Trim().TrimStart('.').Trim();
        if (name.Length == 0)
            return FallbackName;
        if (Encoding.UTF8.GetByteCount(name) <= MaximumNameBytes)
            return name;
        var (stem, extension) = Split(name);
        if (Encoding.UTF8.GetByteCount(extension) > MaximumNameBytes / 2)
            (stem, extension) = (name, "");
        var budget = MaximumNameBytes - Encoding.UTF8.GetByteCount(extension);
        return Truncate(stem, budget).TrimEnd() + extension;
    }

    /// <summary>
    /// <paramref name="name"/> if nothing in <paramref name="directory"/> has it, otherwise
    /// the first free "name 2.ext", "name 3.ext", …, the way Finder names copies.
    /// </summary>
    internal static string UniqueName(string directory, string name, Func<string, bool> exists)
    {
        if (!exists(Path.Combine(directory, name)))
            return name;
        var (stem, extension) = Split(name);
        for (var number = 2; ; number++)
        {
            var suffix = " " + number + extension;
            var candidate = Truncate(stem, MaximumNameBytes - Encoding.UTF8.GetByteCount(suffix)) + suffix;
            if (!exists(Path.Combine(directory, candidate)))
                return candidate;
        }
    }

    // "archive.tar.gz" keeps ".tar.gz" together; a name that is only an extension has none.
    private static (string Stem, string Extension) Split(string name)
    {
        var dot = name.LastIndexOf('.');
        if (dot <= 0)
            return (name, "");
        var inner = name.LastIndexOf('.', dot - 1);
        if (inner > 0 && name[inner..dot].Equals(".tar", StringComparison.OrdinalIgnoreCase))
            dot = inner;
        return (name[..dot], name[dot..]);
    }

    private static string Truncate(string text, int bytes)
    {
        if (Encoding.UTF8.GetByteCount(text) <= bytes)
            return text;
        var length = text.Length;
        while (length > 0 && Encoding.UTF8.GetByteCount(text.AsSpan(0, length)) > bytes)
            length--;
        // Don't split a surrogate pair.
        if (length > 0 && char.IsHighSurrogate(text[length - 1]))
            length--;
        return text[..length];
    }
}
