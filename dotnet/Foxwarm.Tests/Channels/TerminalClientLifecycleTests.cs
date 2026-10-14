using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using Foxwarm.Terminal;
using TerminalClient = Foxwarm.Terminal.TerminalRegistry.TerminalRecord.TerminalClient;

namespace Foxwarm.Tests;

public sealed class TerminalClientLifecycleTests
{
    [Fact]
    public async Task Exit_snapshot_can_finish_a_browser_client_after_its_normal_detach_and_disposal()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var browserTcp = new TcpClient();
        var connecting = browserTcp.ConnectAsync((IPEndPoint)listener.LocalEndpoint);
        using var hostTcp = await listener.AcceptTcpClientAsync();
        await connecting;
        using var browser = WebSocket.CreateFromStream(
            browserTcp.GetStream(),
            false,
            null,
            Timeout.InfiniteTimeSpan
        );
        using var host = WebSocket.CreateFromStream(
            hostTcp.GetStream(),
            true,
            null,
            Timeout.InfiniteTimeSpan
        );
        var target = new Target();
        var client = new TerminalClient(host, target, CancellationToken.None, false);
        var connection = client.StartAsync();
        // WaitLoopAsync retains a client snapshot outside the record lock. A browser
        // detach can finish and dispose that same client before snapshot completion.
        var exitSnapshot = new[] { client };
        await browser.CloseOutputAsync(
            WebSocketCloseStatus.NormalClosure,
            "Page detached",
            CancellationToken.None
        );
        await connection.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, target.Detaches);
        await client.DisposeAsync();
        await Task.WhenAll(exitSnapshot.Select(item => item.FinishAsync()));
    }

    private sealed class Target : ITerminalStreamTarget
    {
        public int Detaches { get; private set; }

        public Task InputAsync(string text) => Task.CompletedTask;

        public Task ResizeAsync(int cols, int rows) => Task.CompletedTask;

        public Task CloseAsync(string reason) => Task.CompletedTask;

        public void Detach(TerminalClient client) => Detaches++;

        public void ResolveControl(
            TerminalClient client,
            string requestId,
            bool ok,
            string? message,
            string? error
        ) { }
    }
}
