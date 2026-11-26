using System.Net;
using System.Net.WebSockets;

namespace Foxwarm.Net;

/// <summary>
/// The options a call site sets on its handler. In file mode the factory builds the same
/// handler type with these options as the site did before the guard (<see cref="FileHandler"/>);
/// a guarded policy always builds a <see cref="SocketsHttpHandler"/> with them.
/// </summary>
internal sealed record EgressHandlerOptions
{
    internal bool AllowAutoRedirect { get; init; } = true;
    internal bool UseCookies { get; init; } = true;
    internal TimeSpan? ConnectTimeout { get; init; }

    /// <summary>File mode only: a guarded handler never uses a proxy.</summary>
    internal bool UseProxy { get; init; } = true;

    /// <summary>The handler type the site constructed in file mode.</summary>
    internal EgressFileHandler FileHandler { get; init; } = EgressFileHandler.Sockets;
}

internal enum EgressFileHandler
{
    Sockets,
    Client,
}

/// <summary>
/// The only constructor of outbound HTTP handlers, clients and WebSocket connections in the
/// Main server. A guarded policy's handler has <c>UseProxy = false</c>, so environment proxies
/// can't carry a connection past the check, and a <c>ConnectCallback</c> that resolves the
/// host itself, checks every address and connects to a checked one without resolving again.
/// The callback runs for every new connection, so a redirect to another host, or the same name
/// resolving elsewhere later, is checked again. HTTP/3 would bypass the callback; no call site
/// requests it, and the source rule keeps it that way.
/// </summary>
internal static class EgressHttp
{
    internal static HttpMessageHandler Handler(
        EgressPolicy policy,
        EgressPurpose purpose,
        EgressHandlerOptions? options = null
    )
    {
        options ??= new();
        policy = policy.For(purpose);
        if (!policy.Guarded)
            return options.FileHandler == EgressFileHandler.Client
                ? new HttpClientHandler
                {
                    AllowAutoRedirect = options.AllowAutoRedirect,
                    UseCookies = options.UseCookies,
                    UseProxy = options.UseProxy,
                }
                : FileSockets(options);
        var handler = Guarded(options);
        handler.ConnectCallback = async (context, token) =>
        {
            var endpoint = context.DnsEndPoint;
            var addresses = await policy
                .ResolveCheckedAsync(endpoint.Host, token)
                .ConfigureAwait(false);
            return await policy.ConnectAsync(addresses, endpoint.Port, token).ConfigureAwait(false);
        };
        return handler;
    }

    /// <summary>
    /// A handler that connects only to <paramref name="host"/>:<paramref name="port"/> at
    /// addresses its caller resolved and checked once beforehand (OAuth discovery and tokens).
    /// </summary>
    internal static HttpMessageHandler PinnedHandler(
        EgressPolicy policy,
        EgressPurpose purpose,
        string host,
        int port,
        IReadOnlyList<IPAddress> addresses,
        Func<Exception> changed,
        Func<Exception> failed,
        EgressHandlerOptions? options = null
    )
    {
        options ??= new();
        policy = policy.For(purpose);
        var handler = policy.Guarded ? Guarded(options) : FileSockets(options);
        handler.ConnectCallback = async (context, token) =>
        {
            if (context.DnsEndPoint.Host != host || context.DnsEndPoint.Port != port)
                throw changed();
            try
            {
                return await policy.ConnectAsync(addresses, port, token).ConfigureAwait(false);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                throw failed();
            }
        };
        return handler;
    }

    internal static HttpClient Client(
        EgressPolicy policy,
        EgressPurpose purpose,
        EgressHandlerOptions? options = null,
        Func<HttpMessageHandler, HttpMessageHandler>? wrap = null,
        TimeSpan? timeout = null
    )
    {
        var handler = Handler(policy, purpose, options);
        return Client(wrap is null ? handler : wrap(handler), timeout);
    }

    /// <summary>
    /// A client over a handler chain whose transport came from <see cref="Handler"/> or
    /// <see cref="PinnedHandler"/>.
    /// </summary>
    internal static HttpClient Client(HttpMessageHandler chain, TimeSpan? timeout = null) =>
        new(chain) { Timeout = timeout ?? Timeout.InfiniteTimeSpan };

    /// <summary>A WebSocket client to configure before <see cref="ConnectWebSocketAsync"/>.</summary>
    internal static ClientWebSocket WebSocket() => new();

    /// <summary>
    /// Connects a WebSocket. In file mode without an invoker this is today's
    /// <c>ConnectAsync(uri, token)</c>; a guarded policy always connects through a guarded
    /// invoker. An invoker the caller passes must come from <see cref="Handler"/>.
    /// </summary>
    internal static async Task ConnectWebSocketAsync(
        EgressPolicy policy,
        EgressPurpose purpose,
        ClientWebSocket socket,
        Uri uri,
        HttpMessageInvoker? invoker,
        CancellationToken token
    )
    {
        if (invoker is not null)
        {
            await socket.ConnectAsync(uri, invoker, token).ConfigureAwait(false);
            return;
        }
        if (!policy.For(purpose).Guarded)
        {
            await socket.ConnectAsync(uri, token).ConfigureAwait(false);
            return;
        }
        // The upgraded stream doesn't depend on the handler, as in ClientWebSocket's own
        // connect, which disposes the handler it created once the handshake is done.
        using var guarded = new HttpMessageInvoker(
            Handler(
                policy,
                purpose,
                new EgressHandlerOptions { AllowAutoRedirect = false, UseCookies = false }
            )
        );
        await socket.ConnectAsync(uri, guarded, token).ConfigureAwait(false);
    }

    private static SocketsHttpHandler FileSockets(EgressHandlerOptions options)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = options.AllowAutoRedirect,
            UseCookies = options.UseCookies,
            UseProxy = options.UseProxy,
        };
        if (options.ConnectTimeout is { } timeout)
            handler.ConnectTimeout = timeout;
        return handler;
    }

    private static SocketsHttpHandler Guarded(EgressHandlerOptions options)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = options.AllowAutoRedirect,
            UseCookies = options.UseCookies,
            UseProxy = false,
        };
        if (options.ConnectTimeout is { } timeout)
            handler.ConnectTimeout = timeout;
        // Chain building could otherwise fetch a missing intermediate from the certificate's
        // AIA URL over the runtime's own HTTP client, outside the connect callback.
        handler.SslOptions.CertificateChainPolicy = OfflineChainPolicy();
        handler.SslOptions.RemoteCertificateValidationCallback = ValidateOffline;
        return handler;
    }

    /// <summary>
    /// The chain policy of guarded TLS: what SslStream uses without one (no revocation check,
    /// the root excluded from revocation, system trust, the server-authentication EKU), with
    /// certificate downloads disabled. Host names are checked by SslStream either way.
    /// </summary>
    internal static System.Security.Cryptography.X509Certificates.X509ChainPolicy OfflineChainPolicy()
    {
        var policy = new System.Security.Cryptography.X509Certificates.X509ChainPolicy
        {
            DisableCertificateDownloads = true,
            RevocationMode = System.Security.Cryptography.X509Certificates.X509RevocationMode.NoCheck,
            RevocationFlag = System.Security.Cryptography.X509Certificates.X509RevocationFlag.ExcludeRoot,
            TrustMode = System.Security.Cryptography.X509Certificates.X509ChainTrustMode.System,
        };
        policy.ApplicationPolicy.Add(new System.Security.Cryptography.Oid("1.3.6.1.5.5.7.3.1"));
        return policy;
    }

    // The default decision (no policy errors), except that an incomplete chain, which a
    // download would have completed, is reported as such rather than as an untrusted server.
    private static bool ValidateOffline(
        object sender,
        System.Security.Cryptography.X509Certificates.X509Certificate? certificate,
        System.Security.Cryptography.X509Certificates.X509Chain? chain,
        System.Net.Security.SslPolicyErrors errors
    )
    {
        if (errors == System.Net.Security.SslPolicyErrors.None)
            return true;
        if (
            chain?.ChainStatus.Any(status =>
                status.Status
                == System.Security.Cryptography.X509Certificates.X509ChainStatusFlags.PartialChain
            ) == true
        )
            throw new EgressCertificateException(
                (sender as System.Net.Security.SslStream)?.TargetHostName ?? ""
            );
        return false;
    }
}
