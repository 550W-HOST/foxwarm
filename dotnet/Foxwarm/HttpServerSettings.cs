using System.Net;
using System.Net.Sockets;
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
    bool HttpEnabled = true
)
{

    /// <summary>
    /// How long stopping the host waits for requests still in progress before it aborts them;
    /// null keeps the host default (30 s).
    /// </summary>
    internal TimeSpan? ShutdownTimeout { get; init; }

    /// <summary>
    /// The server the host runs on instead of its own listener: a tenant runtime of a replica
    /// that hosts several tenants receives its requests from the replica's front server.
    /// </summary>
    internal Microsoft.AspNetCore.Hosting.Server.IServer? Server { get; init; }

    /// <summary>
    /// Whether <c>POST /admin/shutdown</c> may stop the process. A tenant of a replica that
    /// hosts several tenants doesn't own the process, and the route refuses.
    /// </summary>
    internal bool ShutdownAvailable { get; init; } = true;

    internal string? ReservedOperatorHost { get; init; }

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
        string dataRoot,
        Foxwarm.Storage.IInstanceCredentials? credentials = null
    )
    {
        var port = ListenPort(configuration.AppConfiguration["bot"]?["httpPort"]);
        var bindAddress = ListenAddress(configuration.AppConfiguration["bot"]?["httpHost"]);
        var configuredUrl = SessionWait.Text(configuration.AppConfiguration["url"]);
        var address = PublicWebAddress.Capture(port, configuredUrl, bindAddress);
        var enabled = Enabled(configuration);
        // bot.enableTrigger (default true) named the administrator POST /trigger route, removed in
        // 0.9.6. Existing configurations keep its listener meaning: it still starts HTTP for
        // /health, Nodes and the API when WebUI is off.
        var trigger = Feature(configuration, "enableTrigger");
        var http =
            enabled
            || trigger
            || configuration.Access.Snapshot.Values.Any(identity =>
                identity.Mcp || identity.Webhook is not null
            );
        var needsPlaintext = http;
#if FOXWARM_HOSTED
        if (http && credentials is Hosted.Postgres.PgInstanceCredentials hosted && hosted.CaptureVersionedHttp())
            needsPlaintext = false;
#endif
        var token = needsPlaintext ? await LoadOrCreateTokenAsync(dataRoot, credentials) : "";
        if (needsPlaintext && string.IsNullOrWhiteSpace(token))
            throw new InvalidDataException("HTTP access token must not be blank.");
        return new(
            port,
            token,
            bindAddress,
            address,
            enabled,
            HttpEnabled: http
        );
    }

    internal const string WildcardAddress = "0.0.0.0";

    // bot.httpPort is the port Main listens on, default 3001.
    internal static int ListenPort(JsonNode? value) =>
        value is null ? 3001
        : SessionWait.Number(value) is { } configured
        && configured >= 1
        && configured <= 65535
        && configured == Math.Truncate(configured)
            ? (int)configured
        : throw new InvalidDataException("bot.httpPort must be a port number.");

    // bot.httpHost is the address Main listens on: an IPv4 or IPv6 literal, default the IPv4
    // wildcard. Host names, including localhost, are rejected so the listener is exactly one
    // socket that needs no name resolution; 127.0.0.1 or ::1 select loopback.
    internal static string ListenAddress(JsonNode? value)
    {
        if (value is null)
            return WildcardAddress;
        var text = SessionWait.Text(value);
        if (
            text is null
            || !IPAddress.TryParse(text, out var parsed)
            || text.Contains('%')
            || text.Contains('[')
            || parsed.AddressFamily == AddressFamily.InterNetwork
                && parsed.ToString() != text
        )
            throw new InvalidDataException(
                "bot.httpHost must be an IPv4 or IPv6 address, such as 0.0.0.0, 127.0.0.1 or ::1. Host names are not accepted."
            );
        return parsed.ToString();
    }

    // An address in URL host form: IPv6 literals in brackets.
    internal static string UrlHost(string address) =>
        address.Contains(':') ? "[" + address + "]" : address;

    // Where a local client reaches a listener on this address: a wildcard listener is
    // reached through IPv4 loopback, a specific address only through itself.
    internal static string LocalHost(string address) =>
        address is WildcardAddress or "::" ? "127.0.0.1" : UrlHost(address);

    // Desktop deliberately ignores the server bind/port/public URL settings. Kestrel
    // owns the listener; its actual bound address is published after start.
    internal static async Task<HttpServerSettings> CaptureDesktopAsync(
        string dataRoot,
        Foxwarm.Storage.IInstanceCredentials? credentials = null
    )
    {
        var token = await LoadOrCreateTokenAsync(dataRoot, credentials);
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
            PublicWebAddress.Capture(port, bindAddress: "127.0.0.1"),
            true,
            true
        );
    }

    internal static Task<string?> ReadExistingTokenAsync(
        string dataRoot,
        Foxwarm.Storage.IInstanceCredentials? credentials = null
    ) =>
        Task.FromResult(
            (credentials ?? new Foxwarm.Storage.FileInstanceCredentials(dataRoot)).Read(
                Foxwarm.Storage.InstanceCredentialName.HttpToken
            )
                is { } text
                ? SessionGoal.Trim(text)
                : null
        );

    private static Task<string> LoadOrCreateTokenAsync(
        string dataRoot,
        Foxwarm.Storage.IInstanceCredentials? credentials
    ) =>
        Task.FromResult(
            SessionGoal.Trim(
                (credentials ?? new Foxwarm.Storage.FileInstanceCredentials(dataRoot)).ReadOrCreate(
                    Foxwarm.Storage.InstanceCredentialName.HttpToken,
                    () => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant()
                )
            )
        );
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
    internal bool HasConfiguredOrigin { get; init; } = true;

    internal static PublicWebAddress Capture(
        int port,
        string? configured = null,
        string bindAddress = HttpServerSettings.WildcardAddress
    )
    {
        var input = configured;
        if (string.IsNullOrEmpty(input))
            return new(
                $"http://{HttpServerSettings.LocalHost(bindAddress)}:{port}",
                PathString.Empty,
                "/",
                false
            ) { HasConfiguredOrigin = false };
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
