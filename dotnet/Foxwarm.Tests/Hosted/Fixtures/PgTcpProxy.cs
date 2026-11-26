using System.Net;
using System.Net.Sockets;
using Npgsql;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// A loopback TCP proxy in front of the test PostgreSQL server, for partition tests without
/// root. Held directions stop forwarding bytes without closing anything, which is what a
/// network partition looks like to both ends.
/// </summary>
internal sealed class PgTcpProxy : IAsyncDisposable
{
    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly Func<Socket> connectUpstream;
    private readonly CancellationTokenSource stopping = new();
    private readonly List<Link> links = [];
    private readonly Task accepting;
    private readonly object gate = new();
    private volatile bool holdNew;

    private PgTcpProxy(Func<Socket> connectUpstream)
    {
        this.connectUpstream = connectUpstream;
        listener.Start();
        accepting = AcceptAsync();
    }

    internal int Port => ((IPEndPoint)listener.LocalEndpoint).Port;

    /// <summary>A proxy to <paramref name="target"/>'s server (its Unix socket or TCP address).</summary>
    internal static PgTcpProxy For(string target)
    {
        var settings = new NpgsqlConnectionStringBuilder(target);
        var host = settings.Host!;
        var port = settings.Port;
        return new PgTcpProxy(() =>
        {
            if (host.StartsWith('/'))
            {
                var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                socket.Connect(new UnixDomainSocketEndPoint(Path.Combine(host, $".s.PGSQL.{port}")));
                return socket;
            }
            var tcp = new Socket(SocketType.Stream, ProtocolType.Tcp);
            tcp.Connect(host, port);
            return tcp;
        });
    }

    /// <summary><paramref name="connectionString"/> rerouted through this proxy.</summary>
    internal string Route(string connectionString) =>
        new NpgsqlConnectionStringBuilder(connectionString)
        {
            Host = "127.0.0.1",
            Port = Port,
            SslMode = SslMode.Disable,
        }.ConnectionString;

    /// <summary>Stops forwarding on existing connections in the given directions.</summary>
    internal void HoldExisting(bool toServer, bool toClient)
    {
        lock (gate)
            foreach (var link in links)
            {
                if (toServer)
                    link.Up.Hold();
                if (toClient)
                    link.Down.Hold();
            }
    }

    /// <summary>A full partition: existing connections stall and new ones never reach the server.</summary>
    internal void Partition()
    {
        holdNew = true;
        HoldExisting(true, true);
    }

    /// <summary>Forwards again on every connection, delivering what was held.</summary>
    internal void Heal()
    {
        holdNew = false;
        lock (gate)
            foreach (var link in links)
            {
                link.Up.Release();
                link.Down.Release();
            }
    }

    /// <summary>Closes every proxied connection, as a crashed network path would.</summary>
    internal void SeverAll()
    {
        lock (gate)
        {
            foreach (var link in links)
                link.Close();
            links.Clear();
        }
    }

    public async ValueTask DisposeAsync()
    {
        stopping.Cancel();
        listener.Stop();
        SeverAll();
        try
        {
            await accepting;
        }
        catch { }
    }

    private async Task AcceptAsync()
    {
        while (!stopping.IsCancellationRequested)
        {
            Socket client;
            try
            {
                client = await listener.AcceptSocketAsync(stopping.Token);
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
        Socket upstream;
        try
        {
            upstream = connectUpstream();
        }
        catch
        {
            client.Dispose();
            return;
        }
        var link = new Link(client, upstream);
        lock (gate)
        {
            links.Add(link);
            if (holdNew)
            {
                link.Up.Hold();
                link.Down.Hold();
            }
        }
        await Task.WhenAll(link.Up.RunAsync(), link.Down.RunAsync());
        link.Close();
        lock (gate)
            links.Remove(link);
    }

    private sealed class Link(Socket client, Socket upstream)
    {
        internal Pump Up { get; } = new(client, upstream);
        internal Pump Down { get; } = new(upstream, client);

        internal void Close()
        {
            Up.Stop();
            Down.Stop();
            client.Dispose();
            upstream.Dispose();
        }
    }

    private sealed class Pump(Socket from, Socket to)
    {
        private readonly object gate = new();
        private TaskCompletionSource open = Opened();
        private volatile bool stopped;

        private static TaskCompletionSource Opened()
        {
            var source = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            source.SetResult();
            return source;
        }

        internal void Hold()
        {
            lock (gate)
                if (open.Task.IsCompleted)
                    open = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        internal void Release()
        {
            lock (gate)
                open.TrySetResult();
        }

        internal void Stop()
        {
            stopped = true;
            Release();
        }

        internal async Task RunAsync()
        {
            var buffer = new byte[16 * 1024];
            try
            {
                while (!stopped)
                {
                    var count = await from.ReceiveAsync(buffer, SocketFlags.None);
                    if (count == 0)
                        break;
                    Task wait;
                    lock (gate)
                        wait = open.Task;
                    await wait;
                    if (stopped)
                        break;
                    await to.SendAsync(buffer.AsMemory(0, count), SocketFlags.None);
                }
            }
            catch { }
            try
            {
                to.Shutdown(SocketShutdown.Send);
            }
            catch { }
        }
    }
}
