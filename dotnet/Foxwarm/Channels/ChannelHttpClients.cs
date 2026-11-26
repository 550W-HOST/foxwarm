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

    public void Dispose()
    {
        lock (gate)
        {
            foreach (var client in clients.Values)
                client.Dispose();
            clients.Clear();
        }
    }
}
