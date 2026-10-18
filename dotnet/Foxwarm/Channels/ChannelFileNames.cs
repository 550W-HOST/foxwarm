using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal static class ChannelFileNames
{
    // Source's POSIX basename/extname and ASCII-only unique storage segments.
    internal static string Extension(string filename)
    {
        var name = filename[(filename.LastIndexOf('/') + 1)..];
        var index = name.LastIndexOf('.');
        return index <= 0 || name is "." or ".." ? "" : name[index..];
    }

    internal static string StorageName(string filename, string mime, string timestamp, string nonce)
    {
        var name = filename[(filename.LastIndexOf('/') + 1)..];
        var extension = Extension(name);
        var original =
            name.Length == 0 ? "upload"
            : extension.Length > 0 ? name[..^extension.Length]
            : name;
        var safe = Regex
            .Replace(SessionGoal.Trim(original), "[^a-zA-Z0-9._-]+", "_")
            .TrimStart('.');
        if (safe.Length == 0)
            safe = "file";
        if (safe.Length > 80)
            safe = safe[..80];
        if (extension.Length > 0)
            extension = extension[..Math.Min(16, extension.Length)];
        else
            extension = mime switch
            {
                "image/jpeg" => ".jpg",
                "image/png" => ".png",
                "image/gif" => ".gif",
                "image/webp" => ".webp",
                "image/bmp" => ".bmp",
                "image/svg+xml" => ".svg",
                "application/pdf" => ".pdf",
                "text/plain" => ".txt",
                "text/markdown" => ".md",
                "application/json" => ".json",
                "application/zip" => ".zip",
                "application/gzip" => ".gz",
                "application/x-tar" => ".tar",
                _ => "",
            };
        return timestamp + "-" + nonce + "-" + safe + extension;
    }

    internal static string Escape(string value)
    {
        var normalized = Regex.Replace(
            value.Replace("\r\n", "\n").Replace('\r', '\n'),
            "[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]",
            " "
        );
        normalized = SessionGoal.Trim(
            Regex.Replace(
                normalized,
                "[\\x09-\\x0D\\x20\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+",
                " "
            )
        );
        return normalized
            .Replace("&", "&amp;")
            .Replace("<", "&lt;")
            .Replace(">", "&gt;")
            .Replace("\"", "&quot;")
            .Replace("'", "&apos;");
    }

    internal static string Descriptor(
        string filename,
        string path,
        string mime,
        string node = "master"
    ) =>
        mime.StartsWith("image/", StringComparison.Ordinal)
            ? $"<foxwarm-image name=\"{Escape(filename)}\" node=\"{Escape(node)}\" path=\"{Escape(path)}\" />"
            : $"<foxwarm-file name=\"{Escape(filename)}\" node=\"{Escape(node)}\" path=\"{Escape(path)}\" mime=\"{Escape(mime)}\" />";
}
