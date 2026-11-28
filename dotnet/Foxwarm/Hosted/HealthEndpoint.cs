using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Hosted;


/// <summary>The boot's separate health listener; it serves probes even before any tenant starts.</summary>
internal sealed class HealthEndpoint : IAsyncDisposable
{
    private readonly TcpListener listener;
    private readonly CancellationTokenSource stopping = new();
    private readonly Func<IHealthReport> state;
    private readonly Task accepting;

    internal HealthEndpoint(IPEndPoint endpoint, Func<IHealthReport> state)
    {
        this.state = state;
        listener = new TcpListener(endpoint);
        listener.Start();
        accepting = AcceptAsync();
    }

    internal int Port => ((IPEndPoint)listener.LocalEndpoint).Port;

    public async ValueTask DisposeAsync()
    {
        stopping.Cancel();
        listener.Stop();
        try
        {
            await accepting.ConfigureAwait(false);
        }
        catch { }
        stopping.Dispose();
    }

    private async Task AcceptAsync()
    {
        while (!stopping.IsCancellationRequested)
        {
            Socket client;
            try
            {
                client = await listener.AcceptSocketAsync(stopping.Token).ConfigureAwait(false);
            }
            catch
            {
                return;
            }
            _ = Task.Run(() => ServeAsync(client));
        }
    }

    private async Task ServeAsync(Socket client)
    {
        using var _ = client;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        try
        {
            var buffer = new byte[2048];
            var length = 0;
            while (length < buffer.Length)
            {
                var count = await client
                    .ReceiveAsync(buffer.AsMemory(length), SocketFlags.None, timeout.Token)
                    .ConfigureAwait(false);
                if (count == 0)
                    break;
                length += count;
                if (Encoding.ASCII.GetString(buffer, 0, length).Contains("\r\n\r\n", StringComparison.Ordinal))
                    break;
            }
            var requestLine = Encoding.ASCII.GetString(buffer, 0, length).Split("\r\n")[0].Split(' ');
            var (status, body) = requestLine is ["GET" or "HEAD", var target, ..]
                ? Respond(target.Split('?')[0])
                : (405, "{\"error\":\"method not allowed\"}");
            var payload = requestLine is ["HEAD", ..] ? "" : body;
            var reason = status switch
            {
                200 => "OK",
                404 => "Not Found",
                405 => "Method Not Allowed",
                _ => "Service Unavailable",
            };
            var response =
                $"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n"
                + $"Content-Length: {Encoding.UTF8.GetByteCount(body)}\r\nConnection: close\r\n\r\n{payload}";
            await client
                .SendAsync(Encoding.UTF8.GetBytes(response), SocketFlags.None, timeout.Token)
                .ConfigureAwait(false);
        }
        catch { }
    }

    private (int Status, string Body) Respond(string path)
    {
        var current = state();
        return path switch
        {
            "/livez" => current.Live
                ? (200, "{\"live\":true}")
                : (503, "{\"live\":false}"),
            "/readyz" => current.Ready ? (200, "{\"ready\":true}") : (503, "{\"ready\":false}"),
            "/status" => (200, current.ToJson()),
            _ => (404, "{\"error\":\"not found\"}"),
        };
    }
}

/// <summary>What the health endpoint reports, as one snapshot.</summary>
internal interface IHealthReport
{
    /// <summary>False while the replica is fencing itself.</summary>
    bool Live { get; }

    bool Ready { get; }

    /// <summary>The <c>/status</c> body; no tenant data beyond what the role needs.</summary>
    string ToJson();
}
