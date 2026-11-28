using System.Net;
using System.Net.Sockets;

namespace Foxwarm.Tests.Hosted;

internal static class ChildListenerPorts
{
    internal static int Sample()
    {
        using var socket = new TcpListener(IPAddress.Loopback, 0);
        socket.Start();
        return ((IPEndPoint)socket.LocalEndpoint).Port;
    }

    // The port is available only at sampling time. Retry only a child-confirmed bind
    // collision; schema, configuration and all other startup failures retain their output.
    internal static bool IsCollision(string output) =>
        output.Contains("address already in use", StringComparison.OrdinalIgnoreCase)
        || output.Contains("address in use", StringComparison.OrdinalIgnoreCase);

    internal const int MaxAttempts = 5;
}
