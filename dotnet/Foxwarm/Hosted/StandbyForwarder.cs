using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace Foxwarm.Hosted;

/// <summary>
/// The public port of a standby replica: each accepted TCP connection is piped unchanged to the
/// tenant owner's advertised address (approved plan C3). Authentication, cookies and WebSocket
/// upgrades happen at the owner, and Main reads no client address, so a byte passthrough keeps
/// every request's meaning. P2's request forwarder replaces it.
/// <para>
/// A connection that finds no reachable owner is held, not closed: nothing has been read from it
/// yet, so the forwarder re-reads the owner and retries the connection until an owner accepts
/// or the hold bound passes. That carries a request across a handover, from the old owner's host
/// stopping to the new owner's host listening. At takeover the listen socket is handed to the
/// replica's own host (<see cref="HandOverAsync"/>), so connections arriving meanwhile queue in
/// the socket's backlog instead of being refused, and the connections already held go on to the
/// new owner, which is this replica.
/// </para>
/// </summary>
internal sealed class StandbyForwarder : IAsyncDisposable
{
    /// <summary>How often a held connection retries, and how long an owner lookup is reused.</summary>
    internal static readonly TimeSpan RetryInterval = TimeSpan.FromMilliseconds(200);

    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan LookupTimeout = TimeSpan.FromSeconds(5);

    private readonly Socket listener;
    private readonly Func<CancellationToken, Task<string?>> ownerAddress;
    private readonly TimeSpan hold;
    private readonly Action<string>? log;
    private readonly CancellationTokenSource accepting = new();
    private readonly CancellationTokenSource stopping = new();
    private readonly Task acceptLoop;
    private readonly HashSet<Socket> open = [];
    private readonly HashSet<Task> forwarding = [];
    private readonly object gate = new();
    private Task<string?>? lookup;
    private long lookupStarted;
    private bool listenerReleased;

    /// <param name="hold">How long a connection waits for a reachable owner before it is closed.</param>
    internal StandbyForwarder(
        IPEndPoint endpoint,
        Func<CancellationToken, Task<string?>> ownerAddress,
        TimeSpan hold,
        Action<string>? log = null
    )
    {
        this.ownerAddress = ownerAddress;
        this.hold = hold;
        this.log = log;
        listener = new Socket(endpoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        try
        {
            listener.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            if (endpoint.Address.Equals(IPAddress.IPv6Any))
                listener.DualMode = true;
            listener.Bind(endpoint);
            listener.Listen();
        }
        catch
        {
            listener.Dispose();
            throw;
        }
        acceptLoop = AcceptAsync();
    }

    internal int Port => ((IPEndPoint)listener.LocalEndPoint!).Port;

    /// <summary>
    /// Stops accepting and returns the listening socket, still open, for the owner's host to
    /// adopt. Connections the forwarder already holds or pipes go on.
    /// </summary>
    internal async Task<Socket> HandOverAsync()
    {
        accepting.Cancel();
        await acceptLoop.ConfigureAwait(false);
        lock (gate)
            listenerReleased = true;
        return listener;
    }

    /// <summary>
    /// A standby's graceful stop: closes the port, so new connections go elsewhere, and waits up
    /// to <paramref name="bound"/> for the connections it forwards to end.
    /// </summary>
    internal async Task DrainAsync(TimeSpan bound)
    {
        accepting.Cancel();
        await acceptLoop.ConfigureAwait(false);
        CloseListener();
        Task[] current;
        lock (gate)
            current = [.. forwarding];
        try
        {
            await Task.WhenAll(current).WaitAsync(bound).ConfigureAwait(false);
        }
        catch (TimeoutException) { }
    }

    /// <summary>Stops accepting and closes every connection it holds or forwards.</summary>
    public async ValueTask DisposeAsync()
    {
        accepting.Cancel();
        stopping.Cancel();
        await acceptLoop.ConfigureAwait(false);
        CloseListener();
        lock (gate)
        {
            foreach (var socket in open)
                socket.Dispose();
            open.Clear();
        }
    }

    /// <summary>Parses <c>host:port</c> or <c>[v6]:port</c>.</summary>
    internal static (string Host, int Port) ParseAddress(string address)
    {
        var colon = address.LastIndexOf(':');
        if (colon <= 0 || !int.TryParse(address[(colon + 1)..], out var port) || port is < 1 or > 65535)
            throw new FormatException($"A replica address must be host:port, not `{address}`.");
        return (address[..colon].Trim('[', ']'), port);
    }

    private void CloseListener()
    {
        lock (gate)
        {
            if (listenerReleased)
                return;
            listenerReleased = true;
        }
        listener.Dispose();
    }

    private async Task AcceptAsync()
    {
        while (!accepting.IsCancellationRequested)
        {
            Socket client;
            try
            {
                // Cancelling an accept leaves the socket listening; a connection not yet
                // accepted stays queued for whoever accepts next.
                client = await listener.AcceptAsync(accepting.Token).ConfigureAwait(false);
            }
            catch
            {
                return;
            }
            lock (gate)
            {
                var task = Task.Run(() => ForwardAsync(client));
                forwarding.Add(task);
                _ = task.ContinueWith(
                    done =>
                    {
                        lock (gate)
                            forwarding.Remove(done);
                    },
                    TaskScheduler.Default
                );
            }
        }
    }

    private async Task ForwardAsync(Socket client)
    {
        Track(client);
        Socket? upstream = null;
        try
        {
            upstream = await ConnectOwnerAsync().ConfigureAwait(false);
            if (upstream is null)
            {
                log?.Invoke($"[forwarder] No owner was reachable within {hold.TotalSeconds:0.#} s; closing a connection.");
                return;
            }
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

    // Retries until an owner accepts the connection or the hold bound passes (null). Nothing has
    // been read from the client yet, so a retry loses nothing.
    private async Task<Socket?> ConnectOwnerAsync()
    {
        var started = Stopwatch.GetTimestamp();
        while (true)
        {
            var remaining = hold - Stopwatch.GetElapsedTime(started);
            if (remaining <= TimeSpan.Zero)
                return null;
            if (await OwnerAsync().ConfigureAwait(false) is { } address)
            {
                var (host, port) = ParseAddress(address);
                var upstream = new Socket(SocketType.Stream, ProtocolType.Tcp);
                Track(upstream);
                using var attempt = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
                attempt.CancelAfter(remaining < ConnectTimeout ? remaining : ConnectTimeout);
                try
                {
                    await upstream.ConnectAsync(host, port, attempt.Token).ConfigureAwait(false);
                    return upstream;
                }
                catch (Exception) when (!stopping.IsCancellationRequested)
                {
                    // Refused or unreachable: the owner isn't listening (yet), or has gone.
                    Untrack(upstream);
                    upstream.Dispose();
                }
            }
            await Task.Delay(RetryInterval, stopping.Token).ConfigureAwait(false);
        }
    }

    // One owner lookup at a time, reused for the retry interval, so held connections don't
    // each query the database.
    private Task<string?> OwnerAsync()
    {
        lock (gate)
        {
            if (
                lookup is { } current
                && (!current.IsCompleted || Stopwatch.GetElapsedTime(lookupStarted) < RetryInterval)
            )
                return current;
            lookupStarted = Stopwatch.GetTimestamp();
            return lookup = LookUpAsync();
        }
    }

    private async Task<string?> LookUpAsync()
    {
        try
        {
            using var bound = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
            bound.CancelAfter(LookupTimeout);
            return await ownerAddress(bound.Token).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // An unreadable owner is no reachable owner; the connection keeps waiting.
            return null;
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
