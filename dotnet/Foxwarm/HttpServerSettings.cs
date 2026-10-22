using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed record HttpServerSettings(
    int Port,
    string Token,
    string BindAddress,
    PublicWebAddress Address,
    bool WebUiEnabled,
    bool Desktop = false,
    bool TriggerEnabled = true,
    bool HttpEnabled = true
)
{
    internal static bool Enabled(ModelConfiguration? configuration) =>
        Feature(configuration, "enableWebUI");

    internal static bool Feature(ModelConfiguration? configuration, string name)
    {
        var value = configuration?.AppConfiguration["bot"]?[name];
        if (value is null)
            return true;
        return value is JsonValue scalar && scalar.TryGetValue<bool>(out var enabled)
            ? enabled
            : throw new InvalidDataException($"bot.{name} must be a boolean.");
    }

    internal static async Task<HttpServerSettings> CaptureAsync(
        ModelConfiguration configuration,
        string dataRoot
    )
    {
        var value = configuration.AppConfiguration["bot"]?["httpPort"];
        var port =
            value is null ? 3001
            : SessionWait.Number(value) is { } configured
            && configured >= 1
            && configured <= 65535
            && configured == Math.Truncate(configured)
                ? (int)configured
            : throw new InvalidDataException("bot.httpPort must be a port number.");
        const string bindAddress = "0.0.0.0";
        var configuredUrl = SessionWait.Text(configuration.AppConfiguration["url"]);
        var address = PublicWebAddress.Capture(port, configuredUrl);
        var enabled = Enabled(configuration);
        var trigger = Feature(configuration, "enableTrigger");
        var http =
            enabled
            || trigger
            || configuration.Access.Snapshot.Values.Any(identity => identity.Mcp);
        var token = http ? await LoadOrCreateTokenAsync(dataRoot) : "";
        if (http && string.IsNullOrWhiteSpace(token))
            throw new InvalidDataException("HTTP access token must not be blank.");
        return new(
            port,
            token,
            bindAddress,
            address,
            enabled,
            TriggerEnabled: trigger,
            HttpEnabled: http
        );
    }

    // Desktop deliberately ignores the server bind/port/public URL settings. Kestrel
    // owns the listener; its actual bound address is published after start.
    internal static async Task<HttpServerSettings> CaptureDesktopAsync(string dataRoot)
    {
        var token = await LoadOrCreateTokenAsync(dataRoot);
        if (string.IsNullOrWhiteSpace(token))
            throw new InvalidDataException("HTTP access token must not be blank.");
        var portPath = Path.Combine(dataRoot, "state", "desktop-port");
        var port =
            File.Exists(portPath)
            && int.TryParse(await File.ReadAllTextAsync(portPath), out var saved)
            && saved is > 0 and <= 65535
                ? saved
                : 0;
        return new(
            port,
            token,
            "127.0.0.1",
            new PublicWebAddress($"http://127.0.0.1:{port}", PathString.Empty, "/", false),
            true,
            true
        );
    }

    internal static async Task<string?> ReadExistingTokenAsync(string dataRoot)
    {
        var path = Path.Combine(dataRoot, "state", "token");
        try
        {
            return SessionGoal.Trim(
                new UTF8Encoding(false, true).GetString(await File.ReadAllBytesAsync(path))
            );
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    private static async Task<string> LoadOrCreateTokenAsync(string dataRoot)
    {
        if (await ReadExistingTokenAsync(dataRoot) is { } existing)
            return existing;
        var path = Path.Combine(dataRoot, "state", "token");
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
        };
        if (!OperatingSystem.IsWindows())
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        await using var stream = new FileStream(path, options);
        await stream.WriteAsync(Encoding.UTF8.GetBytes(token));
        return token;
    }
}

internal sealed record PublicWebAddress(
    string Origin,
    PathString Prefix,
    string CookiePath,
    bool Secure
)
{
    public string Origin { get; internal set; } = Origin;
    internal string BaseUrl => Origin + CookiePath;

    internal static PublicWebAddress Capture(int port, string? configured = null)
    {
        var input = configured;
        if (string.IsNullOrEmpty(input))
            return new($"http://127.0.0.1:{port}", PathString.Empty, "/", false);
        if (
            input != input.Trim()
            || !Uri.TryCreate(input, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || uri.UserInfo.Length > 0
            || uri.Query.Length > 0
            || input.Contains('?')
            || input.Contains('#')
            || input[(input.IndexOf("://", StringComparison.Ordinal) + 3)..]
                .Split('/', 2)[0]
                .Contains('@')
            || uri.Fragment.Length > 0
            || uri.Host.Length == 0
            || uri.Host.Contains('*')
            || input.Contains('\\')
        )
            throw new InvalidDataException(
                "app config `url` must be an HTTP(S) origin with an optional mount path and no credentials, query or fragment."
            );
        var escaped = uri.AbsolutePath.TrimEnd('/');
        if (
            escaped.Contains("%2f", StringComparison.OrdinalIgnoreCase)
            || escaped.Contains("%5c", StringComparison.OrdinalIgnoreCase)
        )
            throw new InvalidDataException(
                "app config `url` mount path must not contain an encoded path separator."
            );
        var path = Uri.UnescapeDataString(escaped);
        if (path.Contains('\0'))
            throw new InvalidDataException(
                "app config `url` mount path contains an invalid character."
            );
        var host =
            uri.HostNameType == UriHostNameType.IPv6
                ? "[" + uri.IdnHost.Trim('[', ']') + "]"
                : uri.IdnHost.ToLowerInvariant();
        var origin = uri.Scheme + "://" + host + (uri.IsDefaultPort ? "" : ":" + uri.Port);
        return new(
            origin,
            new PathString(path),
            path.Length == 0 ? "/" : escaped + "/",
            uri.Scheme == "https"
        );
    }
}
