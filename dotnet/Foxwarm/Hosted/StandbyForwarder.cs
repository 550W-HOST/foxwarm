using System.Net;
using System.Net.Sockets;

namespace Foxwarm.Hosted;

/// <summary>
/// The public port of a standby replica: each accepted TCP connection is piped unchanged to the
/// tenant owner's advertised address (approved plan C3). Authentication, cookies and WebSocket
/// upgrades happen at the owner, and Main reads no client address, so a byte passthrough keeps
/// every request's meaning. When there is no owner the connection is closed at once. It stops
/// listening before the replica's own host binds the port at takeover. P2's request
/// forwarder replaces it.
/// </summary>
internal sealed class StandbyForwarder : IAsyncDisposable
{
    private readonly TcpListener listener;
    private readonly Func<CancellationToken, Task<string?>> ownerAddress;
    private readonly Action<string>? log;
    private readonly CancellationTokenSource stopping = new();
    private readonly Task accepting;
    private readonly HashSet<Socket> open = [];
    private readonly object gate = new();

    internal StandbyForwarder(
        IPEndPoint endpoint,
        Func<CancellationToken, Task<string?>> ownerAddress,
        Action<string>? log = null
    )
    {
        this.ownerAddress = ownerAddress;
        this.log = log;
        listener = new TcpListener(endpoint);
        listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        listener.Start();
        accepting = AcceptAsync();
    }

    internal int Port => ((IPEndPoint)listener.LocalEndpoint).Port;

    /// <summary>Stops accepting and closes every forwarded connection.</summary>
    public async ValueTask DisposeAsync()
    {
        stopping.Cancel();
        listener.Stop();
        try
        {
            await accepting.ConfigureAwait(false);
        }
        catch { }
        lock (gate)
        {
            foreach (var socket in open)
                socket.Dispose();
            open.Clear();
        }
        stopping.Dispose();
    }

    /// <summary>Parses <c>host:port</c> or <c>[v6]:port</c>.</summary>
    internal static (string Host, int Port) ParseAddress(string address)
    {
        var colon = address.LastIndexOf(':');
        if (colon <= 0 || !int.TryParse(address[(colon + 1)..], out var port) || port is < 1 or > 65535)
            throw new FormatException($"A replica address must be host:port, not `{address}`.");
        return (address[..colon].Trim('[', ']'), port);
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
            _ = Task.Run(() => ForwardAsync(client));
        }
    }

    private async Task ForwardAsync(Socket client)
    {
        Track(client);
        Socket? upstream = null;
        try
        {
            using var connect = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
            connect.CancelAfter(TimeSpan.FromSeconds(5));
            var address = await ownerAddress(connect.Token).ConfigureAwait(false);
            if (address is null)
                return;
            var (host, port) = ParseAddress(address);
            upstream = new Socket(SocketType.Stream, ProtocolType.Tcp);
            Track(upstream);
            await upstream.ConnectAsync(host, port, connect.Token).ConfigureAwait(false);
            client.NoDelay = true;
            upstream.NoDelay = true;
            await Task.WhenAll(PumpAsync(client, upstream), PumpAsync(upstream, client)).ConfigureAwait(false);
        }
        catch (Exception error) when (!stopping.IsCancellationRequested)
        {
            log?.Invoke("[forwarder] " + error.Message);
        }
        catch { }
        finally
        {
            Untrack(client);
            client.Dispose();
            if (upstream is not null)
            {
                Untrack(upstream);
                upstream.Dispose();
            }
        }
    }

    private async Task PumpAsync(Socket from, Socket to)
    {
        var buffer = new byte[32 * 1024];
        try
        {
            while (true)
            {
                var count = await from.ReceiveAsync(buffer, SocketFlags.None, stopping.Token).ConfigureAwait(false);
                if (count == 0)
                    break;
                await to.SendAsync(buffer.AsMemory(0, count), SocketFlags.None, stopping.Token).ConfigureAwait(false);
            }
            to.Shutdown(SocketShutdown.Send);
        }
        catch
        {
            // One direction failing ends both.
            from.Dispose();
            to.Dispose();
        }
    }

    private void Track(Socket socket)
    {
        lock (gate)
            open.Add(socket);
    }

    private void Untrack(Socket socket)
    {
        lock (gate)
            open.Remove(socket);
    }
}
