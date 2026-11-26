using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Blobs;

internal enum BlobBackend
{
    Postgres,
    S3,
}

/// <summary>
/// The deployment's <c>blobs</c> block: where the tenant's image and artifact blobs live.
/// <c>blobs.backend</c> is required (<c>s3</c> or <c>postgres</c>) and has no default. The S3
/// backend names its endpoint, region, bucket and addressing style, and the mounted files that
/// hold its credentials; the credentials themselves never appear in the YAML.
/// </summary>
internal sealed record BlobSettings(BlobBackend Backend, S3BlobSettings? S3)
{
    internal static BlobSettings Parse(JsonNode? node)
    {
        if (node is null)
            throw new InvalidDataException("`blobs.backend` is required (`s3` or `postgres`).");
        if (node is not JsonObject blobs)
            throw new InvalidDataException("`blobs` must be a mapping.");
        foreach (var (key, _) in blobs)
            if (key is not ("backend" or "s3"))
                throw new InvalidDataException($"`blobs.{key}` isn't a setting.");
        if (blobs["backend"] is null)
            throw new InvalidDataException("`blobs.backend` is required (`s3` or `postgres`).");
        var backend = SessionWait.Text(blobs["backend"]) switch
        {
            "postgres" => BlobBackend.Postgres,
            "s3" => BlobBackend.S3,
            _ => throw new InvalidDataException("`blobs.backend` must be `s3` or `postgres`."),
        };
        if (backend == BlobBackend.Postgres)
            return blobs.ContainsKey("s3")
                ? throw new InvalidDataException(
                    "`blobs.s3` applies only with `blobs.backend: s3`."
                )
                : new(backend, null);
        return new(backend, S3BlobSettings.Parse(blobs["s3"]));
    }
}

/// <summary>The S3 connection of <see cref="BlobSettings"/>; every field is required.</summary>
internal sealed partial record S3BlobSettings(
    Uri Endpoint,
    string Region,
    string Bucket,
    bool PathStyle,
    string AccessKeyIdFile,
    string SecretAccessKeyFile
)
{
    private static readonly string[] Keys =
    [
        "endpoint",
        "region",
        "bucket",
        "pathStyle",
        "accessKeyIdFile",
        "secretAccessKeyFile",
    ];

    internal static S3BlobSettings Parse(JsonNode? node)
    {
        if (node is not JsonObject s3)
            throw new InvalidDataException(
                node is null
                    ? "`blobs.s3` is required with `blobs.backend: s3`."
                    : "`blobs.s3` must be a mapping."
            );
        foreach (var (key, _) in s3)
            if (!Keys.Contains(key))
                throw new InvalidDataException($"`blobs.s3.{key}` isn't a setting.");
        foreach (var key in Keys)
            if (s3[key] is null)
                throw new InvalidDataException($"`blobs.s3.{key}` is required.");
        var endpointText = Text(s3, "endpoint");
        if (
            !Uri.TryCreate(endpointText, UriKind.Absolute, out var endpoint)
            || endpoint.Scheme is not ("http" or "https")
            || endpoint.AbsolutePath != "/"
            || endpoint.Query.Length > 0
            || endpoint.Fragment.Length > 0
            || endpoint.UserInfo.Length > 0
        )
            throw new InvalidDataException(
                "`blobs.s3.endpoint` must be an http or https URL without a path."
            );
        var bucket = Text(s3, "bucket");
        if (!BucketName().IsMatch(bucket))
            throw new InvalidDataException("`blobs.s3.bucket` must be an S3 bucket name.");
        if (s3["pathStyle"] is not JsonValue style || !style.TryGetValue<bool>(out var pathStyle))
            throw new InvalidDataException("`blobs.s3.pathStyle` must be true or false.");
        return new(
            endpoint,
            Text(s3, "region"),
            bucket,
            pathStyle,
            AbsolutePath(s3, "accessKeyIdFile"),
            AbsolutePath(s3, "secretAccessKeyFile")
        );
    }

    /// <summary>
    /// Reads the mounted credential files. Surrounding whitespace, such as a trailing newline,
    /// isn't part of a value. Fails naming the setting whose file is unreadable or empty.
    /// </summary>
    internal (string AccessKeyId, string SecretAccessKey) ReadCredentials() =>
        (
            ReadSecret(AccessKeyIdFile, "accessKeyIdFile"),
            ReadSecret(SecretAccessKeyFile, "secretAccessKeyFile")
        );

    private static string ReadSecret(string path, string key)
    {
        string text;
        try
        {
            text = File.ReadAllText(path, new UTF8Encoding(false, true)).Trim();
        }
        catch (Exception error)
            when (error is IOException or UnauthorizedAccessException or DecoderFallbackException)
        {
            throw new HostedBootstrapException(
                $"Deployment configuration: the file named by `blobs.s3.{key}` can't be read: {error.Message}"
            );
        }
        return text.Length > 0
            ? text
            : throw new HostedBootstrapException(
                $"Deployment configuration: the file named by `blobs.s3.{key}` is empty."
            );
    }

    private static string Text(JsonObject s3, string key) =>
        SessionWait.Text(s3[key]) is { Length: > 0 } text && text.Trim() == text
            ? text
            : throw new InvalidDataException($"`blobs.s3.{key}` must be a nonempty string.");

    private static string AbsolutePath(JsonObject s3, string key)
    {
        var path = Text(s3, key);
        return Path.IsPathFullyQualified(path)
            ? path
            : throw new InvalidDataException($"`blobs.s3.{key}` must be an absolute path.");
    }

    // S3's general-purpose bucket naming rules.
    [GeneratedRegex("^(?!xn--)(?!.*\\.\\.)(?!\\d+\\.\\d+\\.\\d+\\.\\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")]
    private static partial Regex BucketName();
}
