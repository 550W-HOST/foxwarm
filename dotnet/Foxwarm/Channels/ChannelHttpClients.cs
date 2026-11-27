using Foxwarm.Net;

namespace Foxwarm.Channels;

/// <summary>
/// The HTTP clients the Telegram, Matrix, WeWork and Weixin adapters share within one runtime:
/// one client per channel type, as each adapter's process-wide client was before the egress
/// guard, now built by <see cref="EgressHttp"/> under the runtime's policy. File mode builds
/// today's default client (an <see cref="HttpClientHandler"/> with its defaults, no timeout).
/// </summary>
internal sealed class ChannelHttpClients(EgressPolicy egress) : IDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, HttpClient> clients = new(StringComparer.Ordinal);
    private int holds;
    private bool disposed;

    /// <summary>A client outside a runtime's set, for adapters built directly by tests.</summary>
    internal static HttpClient Single(EgressPolicy egress) =>
        EgressHttp.Client(
            egress,
            EgressPurpose.Channel,
            new EgressHandlerOptions { FileHandler = EgressFileHandler.Client }
        );

    internal HttpClient For(string type)
    {
        lock (gate)
        {
            if (!clients.TryGetValue(type, out var client))
                clients[type] = client = Single(egress);
            return client;
        }
    }

    /// <summary>
    /// Keeps the clients usable until the returned lease is disposed, even after the runtime
    /// disposed this set: work an adapter admitted before its stop (Telegram's closing offset
    /// sync) finishes on a valid transport, as it did on the process-wide clients, without
    /// stop or disposal waiting for it.
    /// </summary>
    internal IDisposable Hold()
    {
        lock (gate)
            holds++;
        return new Lease(this);
    }

    private sealed class Lease(ChannelHttpClients owner) : IDisposable
    {
        private int released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref released, 1) == 0)
                owner.Release();
        }
    }

    private void Release()
    {
        lock (gate)
            if (--holds == 0 && disposed)
                DisposeClients();
    }

    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
            if (holds == 0)
                DisposeClients();
        }
    }

    // Called under gate.
    private void DisposeClients()
    {
        foreach (var client in clients.Values)
            client.Dispose();
        clients.Clear();
    }
}
