using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed record HttpServerSettings(int Port, string Token, PublicWebAddress Address, bool WebUiEnabled)
{
    internal static bool Enabled(ModelConfiguration? configuration)
    {
        var value = configuration?.AppConfiguration["bot"]?["enableWebUI"];
        if (value is null) return true;
        return value is JsonValue scalar && scalar.TryGetValue<bool>(out var enabled)
            ? enabled : throw new InvalidDataException("bot.enableWebUI must be a boolean.");
    }
    internal static async Task<HttpServerSettings> CaptureAsync(ModelConfiguration configuration, string dataRoot)
    {
        var portOverride = Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_PORT");
        int port;
        if (portOverride is not null)
        {
            if (!int.TryParse(portOverride, out port)) throw new InvalidDataException("FOXWARM_EXPERIMENT_PORT must be a port number.");
        }
        else
        {
            var value = configuration.AppConfiguration["bot"]?["httpPort"];
            port = value is null ? 3001 : SessionWait.Number(value) is { } configured && configured >= 1 && configured <= 65535 && configured == Math.Truncate(configured)
                ? (int)configured : throw new InvalidDataException("bot.httpPort must be a port number.");
        }
        if (port is <= 0 or > 65535) throw new InvalidDataException("HTTP port must be between 1 and 65535.");
        var address = PublicWebAddress.Capture(port);
        var enabled = Enabled(configuration);
        var token = Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_API_TOKEN");
        if (token is null)
        {
            var path = Path.Combine(dataRoot, "state", "token");
            try { token = SessionGoal.Trim(new UTF8Encoding(false, true).GetString(await File.ReadAllBytesAsync(path))); }
            catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
            {
                token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
                if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                await using var stream = new FileStream(path, options);
                await stream.WriteAsync(Encoding.UTF8.GetBytes(token));
            }
        }
        if (string.IsNullOrWhiteSpace(token)) throw new InvalidDataException("HTTP access token must not be blank.");
        return new(port, token, address, enabled);
    }
}

internal sealed record PublicWebAddress(string Origin, PathString Prefix, string CookiePath, bool Secure)
{
    internal string BaseUrl => Origin + CookiePath;
    internal static PublicWebAddress Capture(int port)
    {
        var input = Environment.GetEnvironmentVariable("FOXWARM_PUBLIC_BASE_URL");
        if (string.IsNullOrEmpty(input)) return new($"http://127.0.0.1:{port}", PathString.Empty, "/", false);
        if (input != input.Trim() || !Uri.TryCreate(input, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https") || uri.UserInfo.Length > 0 || uri.Query.Length > 0
            || input.Contains('?') || input.Contains('#') || input[(input.IndexOf("://", StringComparison.Ordinal) + 3)..].Split('/', 2)[0].Contains('@')
            || uri.Fragment.Length > 0 || uri.Host.Length == 0 || uri.Host.Contains('*') || input.Contains('\\'))
            throw new InvalidDataException("FOXWARM_PUBLIC_BASE_URL must be an HTTP(S) origin with an optional mount path and no credentials, query or fragment.");
        var escaped = uri.AbsolutePath.TrimEnd('/');
        if (escaped.Contains("%2f", StringComparison.OrdinalIgnoreCase) || escaped.Contains("%5c", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("FOXWARM_PUBLIC_BASE_URL mount path must not contain an encoded path separator.");
        var path = Uri.UnescapeDataString(escaped);
        if (path.Contains('\0')) throw new InvalidDataException("FOXWARM_PUBLIC_BASE_URL mount path contains an invalid character.");
        var host = uri.HostNameType == UriHostNameType.IPv6 ? "[" + uri.IdnHost.Trim('[', ']') + "]" : uri.IdnHost.ToLowerInvariant();
        var origin = uri.Scheme + "://" + host + (uri.IsDefaultPort ? "" : ":" + uri.Port);
        return new(origin, new PathString(path), path.Length == 0 ? "/" : escaped + "/", uri.Scheme == "https");
    }
}
