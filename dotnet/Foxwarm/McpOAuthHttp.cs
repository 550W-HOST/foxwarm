using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm;

internal sealed class McpOAuthException(string code, string message) : Exception(message)
{
    internal string Code => code;
}

// AS traffic has its own client: resource Authorization, API keys and cookies never enter it.
internal static class McpOAuthHttp
{
    internal static bool Loopback(string host) => host is "localhost" or "127.0.0.1" or "::1" or "[::1]";

    internal static Uri Endpoint(string? value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("https" or "http")
            || uri.UserInfo.Length > 0 || uri.Fragment.Length > 0
            || value!.Contains('#') || value.Contains('\\')
            || uri.Scheme == "http" && !Loopback(uri.Host))
            throw new McpOAuthException("endpoint", "OAuth endpoints require HTTPS without credentials or fragments. Localhost HTTP is supported for development.");
        return uri;
    }

    internal static bool SameOrigin(Uri left, Uri right) =>
        left.Scheme == right.Scheme && left.IdnHost == right.IdnHost && left.Port == right.Port;

    internal static bool PrivateAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
            return PrivateAddress(address.MapToIPv4());
        var bytes = address.GetAddressBytes();
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var a = bytes[0];
            var b = bytes[1];
            var c = bytes[2];
            return a is 0 or 10 or 127 || a >= 224
                || a == 169 && b == 254 || a == 172 && b is >= 16 and <= 31
                || a == 192 && (b == 168 || b == 0 && c is 0 or 2)
                || a == 198 && (b is 18 or 19 || b == 51 && c == 100)
                || a == 203 && b == 0 && c == 113 || a == 100 && b is >= 64 and <= 127;
        }
        return bytes[0] == 0 && bytes[1] == 0
            || (bytes[0] & 0xfe) == 0xfc
            || bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80
            || bytes[0] == 0xff;
    }

    internal static async Task<HttpClient> PinnedClientAsync(Uri resource, Uri endpoint, CancellationToken token)
    {
        var host = endpoint.IdnHost.Trim('[', ']');
        var addresses = IPAddress.TryParse(host, out var literal)
            ? [literal] : await Dns.GetHostAddressesAsync(host, token);
        var allowPrivate = SameOrigin(resource, endpoint) || Loopback(resource.Host) && Loopback(endpoint.Host);
        if (addresses.Length == 0 || !allowPrivate && addresses.Any(PrivateAddress))
            throw new McpOAuthException("endpoint", "OAuth discovery cannot contact an unrelated private network endpoint.");
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            ConnectTimeout = TimeSpan.FromSeconds(15),
            ConnectCallback = async (context, cancellation) =>
            {
                if (context.DnsEndPoint.Host != host || context.DnsEndPoint.Port != endpoint.Port)
                    throw new McpOAuthException("endpoint", "OAuth endpoint changed during connection.");
                foreach (var address in addresses)
                {
                    var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
                    try
                    {
                        await socket.ConnectAsync(new IPEndPoint(address, endpoint.Port), cancellation);
                        return new NetworkStream(socket, ownsSocket: true);
                    }
                    catch
                    {
                        socket.Dispose();
                        cancellation.ThrowIfCancellationRequested();
                    }
                }
                throw new McpOAuthException("connection", "OAuth request failed. Check the server connection.");
            },
        };
        return new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    internal sealed record Reply(HttpStatusCode Status, JsonObject? Body);

    internal static async Task<Reply> RequestAsync(
        string resourceUrl, string endpointUrl, HttpMethod method,
        HttpContent? content, string? authorization, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(15));
        var endpoint = Endpoint(endpointUrl);
        using var client = await PinnedClientAsync(Endpoint(resourceUrl), endpoint, deadline.Token);
        using var request = new HttpRequestMessage(method, endpoint) { Content = content };
        request.Headers.Accept.ParseAdd("application/json");
        request.Headers.AcceptEncoding.ParseAdd("identity");
        if (authorization is not null)
            request.Headers.TryAddWithoutValidation("Authorization", authorization);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
        if ((int)response.StatusCode is >= 300 and < 400)
            throw new McpOAuthException("endpoint", "OAuth endpoints must not redirect discovery or token requests.");
        await using var input = await response.Content.ReadAsStreamAsync(deadline.Token);
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var count = await input.ReadAsync(buffer, deadline.Token);
            if (count == 0)
                break;
            if (output.Length + count > 1024 * 1024)
                throw new McpOAuthException("response", "OAuth response is too large.");
            output.Write(buffer, 0, count);
        }
        JsonObject? body = null;
        try { body = JsonNode.Parse(output.ToArray()) as JsonObject; }
        catch (System.Text.Json.JsonException) { }
        return new(response.StatusCode, body);
    }

    internal static async Task<string?> ProbeAsync(string resourceUrl, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(15));
        var endpoint = Endpoint(resourceUrl);
        using var client = await PinnedClientAsync(endpoint, endpoint, deadline.Token);
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.Accept.ParseAdd("application/json, text/event-stream");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
        if ((int)response.StatusCode is >= 300 and < 400)
            throw new McpOAuthException("endpoint", "MCP authorization discovery must not redirect.");
        return response.Headers.TryGetValues("WWW-Authenticate", out var values) ? string.Join(", ", values) : null;
    }

    internal static string? Challenge(string? header, string key)
    {
        if (header is null || !header.StartsWith("Bearer", StringComparison.OrdinalIgnoreCase))
            return null;
        var match = System.Text.RegularExpressions.Regex.Match(header,
            "(?:^|[\\s,])" + System.Text.RegularExpressions.Regex.Escape(key) + "\\s*=\\s*(?:\"([^\"\\r\\n]*)\"|([^,\\s]+))",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        return match.Success ? (match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value) : null;
    }

    internal static string Query(IEnumerable<KeyValuePair<string, string>> values) =>
        string.Join("&", values.Select(pair => Uri.EscapeDataString(pair.Key) + "=" + Uri.EscapeDataString(pair.Value)));
}
