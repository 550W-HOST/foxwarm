using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Channels.WebUi;

// Endpoint metadata limits resource capabilities to these GET/HEAD handlers, never issuance.
internal sealed record WebUiDownloadResource(string Kind);

internal sealed class WebUiDownloadSignatures(string token, Func<long>? now = null)
{
    private readonly byte[] key = HMACSHA256.HashData(
        Encoding.UTF8.GetBytes(token),
        Encoding.UTF8.GetBytes("foxwarm/webui-download-key/v1")
    );

    private long Now => now?.Invoke() ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    internal static string? Text(JsonObject input, string key) =>
        input[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    internal static string? Text(IQueryCollection input, string key) =>
        input.TryGetValue(key, out var values) && values.Count == 1 ? values[0] : null;

    private byte[] Mac(
        string kind,
        string resource,
        string? filename,
        string? preview,
        string expires
    )
    {
        var input = new StringBuilder("[");
        foreach (
            var value in new[] { "download-v1", kind, resource, null, filename, preview, expires }
        )
        {
            if (input.Length > 1)
                input.Append(',');
            if (value is null)
                input.Append("null");
            else
                JsonStringQuoting.Append(input, value);
        }
        input.Append(']');
        return HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(input.ToString()));
    }

    internal (string Query, long ExpiresAt) Issue(string kind, string resource, JsonObject input)
    {
        var filename = Text(input, "filename");
        var preview = Text(input, "preview");
        var expiresAt = Now + 15 * 60;
        var expires = expiresAt.ToString(CultureInfo.InvariantCulture);
        var values = new List<KeyValuePair<string, string?>>();
        if (filename is not null)
            values.Add(new("filename", filename));
        if (preview is not null)
            values.Add(new("preview", preview));
        values.Add(new("expires", expires));
        values.Add(
            new(
                "signature",
                Convert.ToHexStringLower(Mac(kind, resource, filename, preview, expires))
            )
        );
        if (kind == "path")
            values.Add(new("path", resource));
        return (QueryString.Create(values).Value!, expiresAt);
    }

    internal bool Verify(string kind, string resource, IQueryCollection query)
    {
        var expires = Text(query, "expires");
        var signature = Text(query, "signature");
        if (
            expires is null
            || !Regex.IsMatch(expires, "^[1-9][0-9]{0,12}$", RegexOptions.CultureInvariant)
            || !long.TryParse(
                expires,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out var seconds
            )
            || seconds <= Now
            || signature is null
            || !Regex.IsMatch(signature, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)
        )
            return false;
        return CryptographicOperations.FixedTimeEquals(
            Mac(kind, resource, Text(query, "filename"), Text(query, "preview"), expires),
            Convert.FromHexString(signature)
        );
    }

    internal bool Authorizes(HttpContext context)
    {
        if (context.Request.Method is not ("GET" or "HEAD"))
            return false;
        var kind = context.GetEndpoint()?.Metadata.GetMetadata<WebUiDownloadResource>()?.Kind;
        var resource = kind switch
        {
            "path" => Text(context.Request.Query, "path"),
            "blob" => context.Request.RouteValues["blobId"] as string,
            _ => null,
        };
        return resource is not null && Verify(kind!, resource, context.Request.Query);
    }

    internal static string FileName(string? requested, string fallback)
    {
        if (requested is null)
            return fallback;
        var safe = Regex.Replace(requested, @"[\\/\x00-\x1f]", "_");
        safe = safe[..Math.Min(255, safe.Length)];
        return safe.Length == 0 ? fallback : safe;
    }

    internal static string? RasterMime(string path) =>
        Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            _ => null,
        };
}
