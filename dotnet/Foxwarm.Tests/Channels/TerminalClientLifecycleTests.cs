using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using Foxwarm.Terminal;
using TerminalClient = Foxwarm.Terminal.TerminalRegistry.TerminalRecord.TerminalClient;

namespace Foxwarm.Tests;

public sealed class TerminalClientLifecycleTests
{
    [Fact]
    public async Task Host_finish_delivers_final_frame_and_completes_the_close_handshake()
    {
        var (browser, host, resources) = await PairAsync();
        using var _ = resources;
        var target = new Target();
        await using var client = new TerminalClient(host, target, CancellationToken.None, false);
        var connection = client.StartAsync();
        client.Enqueue(
            new System.Text.Json.Nodes.JsonObject
            {
                ["type"] = "error",
                ["message"] = "Node disconnected",
            }
        );
        // Finishing must not cancel the pending receive (which aborts the socket) before the
        // browser has answered the close; an aborted connection can drop the error frame.
        var finishing = client.FinishAsync();
        var buffer = new byte[4096];
        var message = await browser.ReceiveAsync(buffer, CancellationToken.None);
        Assert.Equal(WebSocketMessageType.Text, message.MessageType);
        Assert.Contains(
            "Node disconnected",
            System.Text.Encoding.UTF8.GetString(buffer, 0, message.Count)
        );
        var close = await browser.ReceiveAsync(buffer, CancellationToken.None);
        Assert.Equal(WebSocketMessageType.Close, close.MessageType);
        // A .NET client then waits for the server to drop TCP; a browser does not, so do not block on it.
        var answer = browser.CloseOutputAsync(
            WebSocketCloseStatus.NormalClosure,
            "Browser acknowledged",
            CancellationToken.None
        );
        await finishing.WaitAsync(TimeSpan.FromSeconds(5));
        await answer;
        await connection.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(WebSocketState.Closed, host.State);
    }

    [Fact]
    public async Task Browser_close_receives_the_host_close_response()
    {
        var (browser, host, resources) = await PairAsync();
        using var _ = resources;
        var target = new Target();
        var client = new TerminalClient(host, target, CancellationToken.None, false);
        var connection = client.StartAsync();
        await browser.CloseOutputAsync(
            WebSocketCloseStatus.NormalClosure,
            "Page detached",
            CancellationToken.None
        );
        await connection.WaitAsync(TimeSpan.FromSeconds(5));
        await client.DisposeAsync();
        var close = await browser
            .ReceiveAsync(new byte[1024], CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(WebSocketMessageType.Close, close.MessageType);
        Assert.Equal(WebSocketCloseStatus.NormalClosure, close.CloseStatus);
    }

    private static async Task<(WebSocket Browser, WebSocket Host, IDisposable Resources)> PairAsync()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var browserTcp = new TcpClient();
        var connecting = browserTcp.ConnectAsync((IPEndPoint)listener.LocalEndpoint);
        var hostTcp = await listener.AcceptTcpClientAsync();
        await connecting;
        var browser = WebSocket.CreateFromStream(
            browserTcp.GetStream(),
            false,
            null,
            Timeout.InfiniteTimeSpan
        );
        var host = WebSocket.CreateFromStream(
            hostTcp.GetStream(),
            true,
            null,
            Timeout.InfiniteTimeSpan
        );
        return (browser, host, new Resources([browser, host, hostTcp, browserTcp, listener]));
    }

    private sealed class Resources(object[] items) : IDisposable
    {
        public void Dispose()
        {
            foreach (var item in items)
                if (item is TcpListener listener)
                    listener.Stop();
                else
                    ((IDisposable)item).Dispose();
        }
    }

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
