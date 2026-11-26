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
/// or the hold bound, counted from the accept, passes. That carries a fresh connection across a
/// handover, from the old owner's host stopping to the new owner's host listening. At takeover
/// the listen socket is handed to the replica's own host (<see cref="HandOverAsync"/>), so
/// connections arriving meanwhile queue in the socket's backlog instead of being refused, and
/// the connections already held go on to the new owner, which is this replica. Bytes already
/// piped to an owner are never replayed: an established stream that owner drops is lost.
/// </para>
/// </summary>
internal sealed class StandbyForwarder : IAsyncDisposable
{
    /// <summary>How often a held connection retries, and how long an owner lookup is reused.</summary>
    internal static readonly TimeSpan RetryInterval = TimeSpan.FromMilliseconds(200);

    /// <summary>
    /// Connections held or piped at once. Each costs up to two descriptors and two buffers;
    /// beyond this an accepted connection is reset at once, so a long outage can't exhaust the
    /// process.
    /// </summary>
    internal const int DefaultMaxConnections = 2048;

    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan LookupTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan AcceptRetry = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan JoinBound = TimeSpan.FromMilliseconds(250);

    private readonly Socket listener;
    private readonly Func<CancellationToken, Task<string?>> ownerAddress;
    private readonly TimeSpan hold;
    private readonly string? selfAddress;
    private readonly int maxConnections;
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
    private bool closed;
    private volatile bool handedOver;
    private bool atLimit;

    /// <param name="hold">How long, from its accept, a connection waits for a reachable owner.</param>
    /// <param name="selfAddress">
    /// This replica's advertised address. Until the handover an owner address equal to it is
    /// stale (a restarted replica keeps its address while its old grant is still valid) and
    /// counts as no owner, so the forwarder never pipes into its own listener.
    /// </param>
    internal StandbyForwarder(
        IPEndPoint endpoint,
        Func<CancellationToken, Task<string?>> ownerAddress,
        TimeSpan hold,
        Action<string>? log = null,
        string? selfAddress = null,
        int maxConnections = DefaultMaxConnections
    )
    {
        this.ownerAddress = ownerAddress;
        this.hold = hold;
        this.log = log;
        this.selfAddress = selfAddress;
        this.maxConnections = maxConnections;
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

    /// <summary>Connections held or piped now (tests).</summary>
    internal int Connections
    {
        get
        {
            lock (gate)
                return forwarding.Count;
        }
    }

    /// <summary>Sockets the forwarder owns now, clients and upstreams (tests).</summary>
    internal int OpenSockets
    {
        get
        {
            lock (gate)
                return open.Count;
        }
    }

    /// <summary>
    /// Stops accepting and returns the listening socket, still open, for the owner's host to
    /// adopt. Connections the forwarder already holds or pipes go on, and may now reach this
    /// replica's own address.
    /// </summary>
    internal async Task<Socket> HandOverAsync()
    {
        accepting.Cancel();
        await acceptLoop.ConfigureAwait(false);
        lock (gate)
            listenerReleased = true;
        handedOver = true;
        return listener;
    }

    /// <summary>
    /// A standby's graceful stop: closes the port, so new connections go elsewhere, and waits up
    /// to <paramref name="bound"/> for the connections it holds or forwards to end. Disposal then
    /// ends the rest.
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
        Task[] current;
        lock (gate)
        {
            closed = true;
            foreach (var socket in open)
                socket.Dispose();
            open.Clear();
            current = [.. forwarding];
        }
        // Every wait observes the cancellation; the bound keeps an exit (a fence) from waiting
        // on I/O that doesn't.
        try
        {
            await Task.WhenAll(current).WaitAsync(JoinBound).ConfigureAwait(false);
        }
        catch (TimeoutException) { }
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
            catch (Exception) when (accepting.IsCancellationRequested)
            {
                return;
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (Exception error)
            {
                // For example no descriptor left: the port keeps listening, so retry.
                log?.Invoke("[forwarder] Accepting a connection failed: " + error.Message);
                try
                {
                    await Task.Delay(AcceptRetry, accepting.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                continue;
            }
            var accepted = Stopwatch.GetTimestamp();
            lock (gate)
            {
                if (forwarding.Count >= maxConnections)
                {
                    if (!atLimit)
                        log?.Invoke($"[forwarder] {maxConnections} connections are held or forwarded; resetting new ones.");
                    atLimit = true;
                    Reset(client);
                    continue;
                }
                atLimit = false;
                open.Add(client);
                var task = Task.Run(() => ForwardAsync(client, accepted));
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

    // An explicit failure: the client sees a reset at once instead of a connection that hangs.
    private static void Reset(Socket client)
    {
        try
        {
            client.LingerState = new LingerOption(true, 0);
        }
        catch (SocketException) { }
        client.Dispose();
    }

    private async Task ForwardAsync(Socket client, long accepted)
    {
        Socket? upstream = null;
        try
        {
            upstream = await ConnectOwnerAsync(accepted).ConfigureAwait(false);
            if (upstream is null)
            {
                if (!stopping.IsCancellationRequested)
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

    // Retries until an owner accepts the connection or the hold deadline passes (null). Nothing
    // has been read from the client yet, so a retry loses nothing. Every wait is capped by the
    // deadline taken at the accept.
    private async Task<Socket?> ConnectOwnerAsync(long accepted)
    {
        TimeSpan Remaining() => hold - Stopwatch.GetElapsedTime(accepted);
        while (true)
        {
            var remaining = Remaining();
            if (remaining <= TimeSpan.Zero)
                return null;
            string? address;
            try
            {
                address = await OwnerAsync().WaitAsync(remaining, stopping.Token).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                return null;
            }
            // Before the handover this replica's own address is a stale grant, not an owner.
            if (address is not null && (handedOver || !string.Equals(address, selfAddress, StringComparison.OrdinalIgnoreCase)))
            {
                remaining = Remaining();
                if (remaining <= TimeSpan.Zero)
                    return null;
                if (await TryConnectAsync(address, remaining < ConnectTimeout ? remaining : ConnectTimeout).ConfigureAwait(false) is { } upstream)
                    return upstream;
            }
            remaining = Remaining();
            if (remaining <= TimeSpan.Zero)
                return null;
            await Task.Delay(remaining < RetryInterval ? remaining : RetryInterval, stopping.Token).ConfigureAwait(false);
        }
    }

    // One connection attempt. The socket is this method's until it is returned connected; any
    // other outcome disposes it here.
    private async Task<Socket?> TryConnectAsync(string address, TimeSpan timeout)
    {
        var (host, port) = ParseAddress(address);
        Socket? attempt = new(SocketType.Stream, ProtocolType.Tcp);
        try
        {
            lock (gate)
            {
                if (closed)
                    return null;
                open.Add(attempt);
            }
            using var bound = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
            bound.CancelAfter(timeout);
            try
            {
                await attempt.ConnectAsync(host, port, bound.Token).ConfigureAwait(false);
            }
            catch (Exception) when (!stopping.IsCancellationRequested)
            {
                // Refused or unreachable: the owner isn't listening (yet), or has gone.
                return null;
            }
            var connected = attempt;
            attempt = null;
            return connected;
        }
        finally
        {
            if (attempt is not null)
            {
                Untrack(attempt);
                attempt.Dispose();
            }
        }
    }

    // One owner lookup at a time, reused for the retry interval, so held connections don't
    // each query the database. The lookup has its own bound; no waiter's deadline cancels it.
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
                var sent = 0;
                while (sent < count)
                    sent += await to
                        .SendAsync(buffer.AsMemory(sent, count - sent), SocketFlags.None, stopping.Token)
                        .ConfigureAwait(false);
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

    private void Untrack(Socket socket)
    {
        lock (gate)
            open.Remove(socket);
    }
}
